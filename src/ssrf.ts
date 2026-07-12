import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * SSRF guard for agent-supplied URLs (show_image). The tool params come from
 * the agent's LLM, i.e. indirectly from the caller - a crafted prompt must not
 * be able to make the bridge fetch cloud metadata (169.254.169.254), loopback,
 * or RFC1918 hosts. Mirrors the same guard the StandIn media bridge applies.
 *
 * The DNS-rebind TOCTOU (validate-then-fetch re-resolves, and the second answer
 * can be private) is CLOSED for fetchPublicImage: the actual connect goes
 * through a guarded `lookup` that re-checks every address against the same
 * private-range rules, so a rebind to a private IP fails at connect time -
 * the http(s) stack's own resolution never runs unguarded (parity with the
 * worker's P2-6 pinning).
 */

type LookupFn = (hostname: string, opts: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

function inCidr4(ip: number, base: string, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

/** True for any IPv4 address that must never be fetched server-side. */
export function isForbiddenIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return (
    inCidr4(n, "0.0.0.0", 8) || // "this" network
    inCidr4(n, "10.0.0.0", 8) || // RFC1918
    inCidr4(n, "100.64.0.0", 10) || // CGNAT
    inCidr4(n, "127.0.0.0", 8) || // loopback
    inCidr4(n, "169.254.0.0", 16) || // link-local incl. cloud metadata
    inCidr4(n, "172.16.0.0", 12) || // RFC1918
    inCidr4(n, "192.0.0.0", 24) || // IETF protocol assignments
    inCidr4(n, "192.168.0.0", 16) || // RFC1918
    inCidr4(n, "198.18.0.0", 15) || // benchmarking
    inCidr4(n, "224.0.0.0", 3) // multicast + reserved + broadcast
  );
}

/** True for any IPv6 address that must never be fetched server-side. */
export function isForbiddenIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // v4-mapped/translated (::ffff:a.b.c.d, 64:ff9b::/96) → judge the embedded v4
  if (lower.startsWith("::ffff:") || lower.startsWith("64:ff9b:")) {
    const dotted = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dotted) {
      return isForbiddenIpv4(dotted[1]);
    }
    // hex-encoded tail (e.g. 64:ff9b::a00:1 = 10.0.0.1): last 32 bits are the v4
    const groups = lower.split("::").pop()!.split(":").filter(Boolean);
    if (groups.length <= 2) {
      const hi = groups.length === 2 ? parseInt(groups[0], 16) : 0;
      const lo = parseInt(groups[groups.length - 1] ?? "0", 16) || 0;
      return isForbiddenIpv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
    }
    return true; // malformed mapped form - refuse rather than guess
  }
  if (lower === "::" || lower === "::1") {
    return true; // unspecified / loopback
  }
  const firstGroup = lower.split(":")[0] || "0";
  const first16 = parseInt(firstGroup === "" ? "0" : firstGroup, 16);
  if ((first16 & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique-local
  }
  if ((first16 & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }
  return false;
}

export function isForbiddenIp(ip: string): boolean {
  const family = isIP(ip);
  return family === 4 ? isForbiddenIpv4(ip) : family === 6 ? isForbiddenIpv6(ip) : true;
}

/**
 * Read a fetch Response body with a hard byte cap: rejects on Content-Length
 * upfront, then streams with a running total so an oversized (or lying) server
 * can't balloon memory before the size check.
 */
export async function readBodyWithCap(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response too large (${declared} bytes, max ${maxBytes})`);
  }
  if (!res.body) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`response too large (${buf.length} bytes, max ${maxBytes})`);
    }
    return buf;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error(`response exceeded ${maxBytes} bytes; aborting read`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Injectable private-range predicate (tests only; production uses isForbiddenIp). */
export type ForbiddenIpFn = (ip: string) => boolean;

/**
 * Validate an outbound URL: http(s) only, no credentials, and every address the
 * host resolves to must be public. Throws with a reason on rejection.
 */
export async function assertPublicHttpUrl(
  raw: string,
  lookupFn: LookupFn = lookup,
  isForbiddenFn: ForbiddenIpFn = isForbiddenIp,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`forbidden protocol ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  // WHATWG URL keeps brackets on IPv6 literals ("[::1]") - strip for isIP()
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isForbiddenFn(host)) {
      throw new Error(`address ${host} is private/reserved`);
    }
    return url;
  }
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookupFn(host, { all: true, verbatim: true });
  } catch {
    throw new Error(`cannot resolve host ${host}`);
  }
  if (addrs.length === 0) {
    throw new Error(`host ${host} resolves to no addresses`);
  }
  for (const a of addrs) {
    if (isForbiddenFn(a.address)) {
      throw new Error(`host ${host} resolves to private/reserved address ${a.address}`);
    }
  }
  return url;
}

/** Redirect statuses the single re-validated hop follows. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Fetch an image from an untrusted (agent/LLM-supplied) URL with the full SSRF
 * posture: public http(s) host, no credentials, connect-time DNS guarded
 * against rebind, bounded total time and body size. At most ONE redirect hop
 * is followed, and the redirect target goes through the exact same validation
 * as the original URL (image CDNs commonly 301/302 to the actual asset; an
 * unvalidated redirect would be a guard bypass). Returns the raw bytes and the
 * response content-type.
 */
export async function fetchPublicImage(
  rawUrl: string,
  maxBytes: number,
  timeoutMs = 10_000,
  lookupFn: LookupFn = lookup,
  isForbiddenFn: ForbiddenIpFn = isForbiddenIp,
  redirectsLeft = 1,
): Promise<{ bytes: Buffer; mime: string }> {
  const url = await assertPublicHttpUrl(rawUrl, lookupFn, isForbiddenFn);

  // Connect-time guard: the http stack calls THIS to resolve the host, so a
  // DNS rebind (public answer for the validation, private for the fetch) is
  // rejected here instead of silently connecting to an internal address.
  const guardedLookup = (
    hostname: string,
    options: { all?: boolean },
    cb: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
  ): void => {
    lookupFn(hostname, { all: true, verbatim: true }).then(
      (addrs) => {
        const bad = addrs.find((a) => isForbiddenFn(a.address));
        if (bad || addrs.length === 0) {
          cb(new Error(`DNS rebind blocked: ${hostname} resolved to ${bad?.address ?? "nothing"}`), null as never);
          return;
        }
        if (options.all) {
          cb(null, addrs);
        } else {
          cb(null, addrs[0].address, addrs[0].family);
        }
      },
      (err) => cb(err as NodeJS.ErrnoException, null as never),
    );
  };

  return new Promise((resolve, reject) => {
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { lookup: guardedLookup as any, headers: { accept: "image/*" } },
      (res) => {
        // One re-validated redirect hop: the Location target is resolved against
        // the current URL and recursed through the FULL guard (host allowcheck,
        // DNS pinning, size/time bounds). A second redirect is a failure.
        if (REDIRECT_STATUSES.has(res.statusCode ?? 0)) {
          const location = res.headers.location;
          res.resume();
          if (!location) {
            reject(new Error(`fetch ${rawUrl} → HTTP ${res.statusCode} with no Location header`));
            return;
          }
          if (redirectsLeft <= 0) {
            reject(new Error(`fetch ${rawUrl} → too many redirects`));
            return;
          }
          let next: string;
          try {
            next = new URL(location, url).toString();
          } catch {
            reject(new Error(`fetch ${rawUrl} → invalid redirect Location "${location}"`));
            return;
          }
          fetchPublicImage(next, maxBytes, timeoutMs, lookupFn, isForbiddenFn, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`fetch ${rawUrl} → HTTP ${res.statusCode}`));
          return;
        }
        const declared = Number(res.headers["content-length"] ?? NaN);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          reject(new Error(`response too large (${declared} bytes, max ${maxBytes})`));
          return;
        }
        const mime = (res.headers["content-type"] ?? "image/jpeg").split(";")[0].trim();
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy();
            reject(new Error(`response exceeded ${maxBytes} bytes; aborting read`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ bytes: Buffer.concat(chunks), mime }));
        res.on("error", reject);
      },
    );
    // hard total deadline (the `timeout` option alone is only an idle timer)
    const deadline = setTimeout(() => req.destroy(new Error(`fetch ${rawUrl} timed out after ${timeoutMs}ms`)), timeoutMs);
    deadline.unref?.();
    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.on("close", () => clearTimeout(deadline));
    req.end();
  });
}
