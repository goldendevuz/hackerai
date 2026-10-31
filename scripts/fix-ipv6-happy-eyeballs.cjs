// Solider.uz change: this WSL host advertises AAAA (IPv6) records for hosts
// like a.s2.dev (Trigger.dev's S2 streamstore) but has no working IPv6 route
// ("Network is unreachable"). Node's default Happy Eyeballs connection
// racing (net.autoSelectFamily) still lets the dead IPv6 candidates stall
// the attempt long enough that even the working IPv4 addresses time out,
// which surfaced as "S2Error: Max attempts (3) exhausted: Connection failed:
// ETIMEDOUT" on every Trigger.dev agent-long run. Plain curl and a raw
// https.get to the same IPv4 address both work instantly -- only Node's
// multi-address racing path (used by fetch/undici and node:http2, which the
// S2 client uses directly) was affected.
//
// Preloaded via NODE_OPTIONS=--require so it also covers any child Node
// process Trigger.dev's CLI spawns, not just the top-level process.
try {
  require("dns").setDefaultResultOrder("ipv4first");
} catch {
  /* Older Node without this API: nothing to do, IPv6 attempts just race as before. */
}
try {
  require("net").setDefaultAutoSelectFamily(false);
} catch {
  /* Older Node without this API (added 18.13+): nothing to do. */
}
