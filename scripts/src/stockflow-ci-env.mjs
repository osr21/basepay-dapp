// Public, synthetic configuration for the disposable CI database only.
export const DEFAULT_DATABASE_URL =
  "postgresql://stockflow_ci:stockflow_ci@127.0.0.1:5432/stockflow_ci";

export function ciDatabaseUrl(value = DEFAULT_DATABASE_URL) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username !== "stockflow_ci" || url.password !== "stockflow_ci" ||
      url.pathname !== "/stockflow_ci" || url.search || url.hash) {
    throw new Error("StockFlow CI requires a disposable loopback stockflow_ci database with synthetic credentials");
  }
  return url.href;
}

export function ciEnvironment(source) {
  // Do not spread process.env: even local runs must not inherit signing keys,
  // provider credentials, sessions, database settings or arbitrary NODE_OPTIONS.
  const env = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot"]) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env,
    CI: "true",
    NODE_ENV: "test",
    DATABASE_URL: ciDatabaseUrl(source.STOCKFLOW_CI_DATABASE_URL),
    SESSION_SECRET: "stockflow-ci-synthetic-session-not-for-production",
    STOCKFLOW_PILOT_ENABLED: "false",
    STOCKFLOW_PILOT_ADMIN_WALLETS: "",
    NODE_OPTIONS: `--import=${new URL("./stockflow-ci-network.mjs", import.meta.url).href}`,
  };
}
