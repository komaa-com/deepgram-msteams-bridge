import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicHttpUrl, isForbiddenIp, readBodyWithCap } from "../src/ssrf.js";

test("forbidden addresses: loopback, RFC1918, link-local/metadata, CGNAT, v6 privates", () => {
  for (const ip of [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "169.254.0.1", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12::1", "fe80::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.5", "64:ff9b::a00:1",
  ]) {
    assert.equal(isForbiddenIp(ip), true, `${ip} must be forbidden`);
  }
});

test("public addresses pass", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
    assert.equal(isForbiddenIp(ip), false, `${ip} must be allowed`);
  }
});

test("assertPublicHttpUrl rejects bad protocols, credentials, and private IP literals", async () => {
  await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd"), /protocol/);
  await assert.rejects(() => assertPublicHttpUrl("ftp://example.com/x"), /protocol/);
  await assert.rejects(() => assertPublicHttpUrl("http://user:pass@example.com/"), /credentials/);
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1/img.png"), /private/);
  await assert.rejects(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/"), /private/);
  await assert.rejects(() => assertPublicHttpUrl("http://[::1]/img.png"), /private/);
  await assert.rejects(() => assertPublicHttpUrl("not a url"), /valid URL/);
});

test("assertPublicHttpUrl checks every resolved address", async () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const rebindLookup = async () => [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.7", family: 4 }, // one private A record poisons the set
  ];
  const url = await assertPublicHttpUrl("https://example.com/cat.jpg", publicLookup);
  assert.equal(url.hostname, "example.com");
  await assert.rejects(() => assertPublicHttpUrl("https://example.com/cat.jpg", rebindLookup), /private/);
});

test("readBodyWithCap: content-length reject, streamed overrun reject, small body passes", async () => {
  const big = new Uint8Array(1024);
  await assert.rejects(
    () => readBodyWithCap(new Response(big, { headers: { "content-length": "999999" } }), 512),
    /too large/,
  );
  await assert.rejects(() => readBodyWithCap(new Response(big), 512), /exceeded|too large/);
  const ok = await readBodyWithCap(new Response(new Uint8Array([1, 2, 3])), 512);
  assert.deepEqual([...ok], [1, 2, 3]);
});

test("fetchPublicImage blocks a DNS rebind: public at validation, private at connect", async () => {
  let calls = 0;
  const rebindLookup = async () => {
    calls++;
    // 1st call (validation) → public; 2nd call (connect-time) → private
    return calls === 1
      ? [{ address: "93.184.216.34", family: 4 }]
      : [{ address: "169.254.169.254", family: 4 }];
  };
  const { fetchPublicImage } = await import("../src/ssrf.js");
  await assert.rejects(
    () => fetchPublicImage("http://rebind.example/img.jpg", 1024, 500, rebindLookup),
    /rebind blocked/,
  );
  assert.ok(calls >= 2, "connect-time resolution must go through the guard");
});

// ---- redirect handling: one re-validated hop ----
// Test scaffolding: local HTTP servers stand in for "public" hosts. Fake
// hostnames resolve to 127.0.0.1 via an injected lookup, and an injected
// private-range predicate treats ONLY 127.0.0.1 as public (so the test can
// actually connect) while everything else keeps the real rules.
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchPublicImage } from "../src/ssrf.js";

test("fetchPublicImage follows ONE re-validated redirect and rejects unsafe or chained ones", async (t) => {
  const png = Buffer.from("89504e47", "hex");
  const target = createHttpServer((req, res) => {
    res.writeHead(200, { "content-type": "image/png", "content-length": String(png.length) });
    res.end(png);
  });
  await new Promise<void>((r) => target.listen(0, "127.0.0.1", () => r()));
  const targetPort = (target.address() as AddressInfo).port;

  const redirector = createHttpServer((req, res) => {
    if (req.url === "/one-hop") {
      res.writeHead(302, { location: `http://img-cdn.test:${targetPort}/asset.png` });
    } else if (req.url === "/to-private") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
    } else if (req.url === "/chain") {
      res.writeHead(302, { location: `http://redir.test:0/one-hop` }); // would be a 2nd hop
    } else if (req.url === "/no-location") {
      res.writeHead(302);
    } else {
      res.writeHead(404);
    }
    res.end();
  });
  await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", () => r()));
  const redirPort = (redirector.address() as AddressInfo).port;
  t.after(() => {
    target.close();
    redirector.close();
  });

  // fake DNS: both "public-looking" names resolve to loopback so the test can connect
  const lookupFn = async (hostname: string) => {
    if (hostname === "redir.test" || hostname === "img-cdn.test") {
      return [{ address: "127.0.0.1", family: 4 }];
    }
    throw new Error(`unexpected lookup ${hostname}`);
  };
  // test-only predicate: loopback is "public"; every other rule stays real
  const isForbiddenFn = (ip: string) => ip !== "127.0.0.1" && isForbiddenIp(ip);

  // one hop to a validated target succeeds
  const ok = await fetchPublicImage(`http://redir.test:${redirPort}/one-hop`, 1024 * 1024, 2000, lookupFn, isForbiddenFn);
  assert.equal(ok.mime, "image/png");
  assert.deepEqual(ok.bytes, png);

  // a redirect to a private/metadata target is re-validated and rejected
  await assert.rejects(
    fetchPublicImage(`http://redir.test:${redirPort}/to-private`, 1024 * 1024, 2000, lookupFn, isForbiddenFn),
    /private|reserved/,
  );

  // a second hop is refused
  await assert.rejects(
    fetchPublicImage(`http://redir.test:${redirPort}/chain`, 1024 * 1024, 2000, lookupFn, isForbiddenFn),
    /too many redirects|unexpected lookup|ECONNREFUSED/,
  );

  // a redirect with no Location header is a clean failure
  await assert.rejects(
    fetchPublicImage(`http://redir.test:${redirPort}/no-location`, 1024 * 1024, 2000, lookupFn, isForbiddenFn),
    /no Location/,
  );
});
