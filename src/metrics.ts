/**
 * Dependency-free counters exposed at GET /metrics in the Prometheus text
 * exposition format (0.0.4). Telephony ops need at minimum: how many calls,
 * how many right now, how long, and what is being rejected/dropped.
 */

const counts = new Map<string, number>();

const META: Record<string, { help: string; type: "counter" | "gauge" }> = {
  bridge_calls_total: { help: "Calls accepted (worker sessions created)", type: "counter" },
  bridge_calls_active: { help: "Live calls right now", type: "gauge" },
  bridge_call_seconds_total: { help: "Total call duration in seconds", type: "counter" },
  bridge_upgrades_rejected_auth_total: { help: "Upgrades rejected: bad/stale/replayed HMAC", type: "counter" },
  bridge_upgrades_rejected_cap_total: { help: "Upgrades rejected: connection caps", type: "counter" },
  bridge_upgrades_rejected_duplicate_total: { help: "Upgrades rejected: callId already live (409)", type: "counter" },
  bridge_frames_to_agent_total: { help: "Caller audio frames relayed to Deepgram", type: "counter" },
  bridge_frames_to_worker_total: { help: "Agent audio frames relayed to the worker", type: "counter" },
  bridge_frames_dropped_total: { help: "Frames dropped under worker backpressure", type: "counter" },
  bridge_agent_connect_failures_total: { help: "Deepgram Voice Agent connect failures", type: "counter" },
};

export function metricInc(name: keyof typeof META, by = 1): void {
  counts.set(name, (counts.get(name) ?? 0) + by);
}

export function metricDec(name: keyof typeof META): void {
  metricInc(name, -1);
}

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [name, meta] of Object.entries(META)) {
    lines.push(`# HELP ${name} ${meta.help}`);
    lines.push(`# TYPE ${name} ${meta.type}`);
    lines.push(`${name} ${counts.get(name) ?? 0}`);
  }
  return lines.join("\n") + "\n";
}
