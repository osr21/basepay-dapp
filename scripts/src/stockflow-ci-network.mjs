// Loaded into every CI child, including tsx and Vitest workers. Test chain reads
// must use fixtures; only local PostgreSQL and the replacement HTTP server may
// open network connections. This is a regression guard, not a hostile-code VM.
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

function requireLoopback(host) {
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host ?? "localhost")) {
    throw new Error("StockFlow CI blocked non-loopback network access; mock the chain read");
  }
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // node:net normalizes its internal call shape into [options, callback].
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options === "object" && options !== null) {
    if (options.path) throw new Error("StockFlow CI blocked Unix socket access");
    requireLoopback(options.host);
  } else {
    if (typeof options !== "number") throw new Error("StockFlow CI requires a loopback TCP connection");
    requireLoopback(typeof args[1] === "string" ? args[1] : undefined);
  }
  return connect.apply(this, args);
};
syncBuiltinESMExports();

const originalFetch = globalThis.fetch;
globalThis.fetch = function (input, init) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  requireLoopback(url.hostname);
  return originalFetch(input, init);
};

if (process.argv.some(arg => /^(--live|--http|--funded)(=|$)/.test(arg))) {
  throw new Error("StockFlow CI does not allow live, external HTTP or funded test modes");
}
