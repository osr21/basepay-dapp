import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
    ],
    // Pino serialises log objects as JSON before writing.
    // If a private key (64-hex chars after optional 0x) ever appears
    // inside a serialised field value, replace it with [REDACTED].
    censor(value, path) {
      if (typeof value === "string") {
        // Matches bare 64-hex private key or 0x-prefixed variant
        return value.replace(/\b(0x)?[0-9a-fA-F]{64}\b/g, "[REDACTED]");
      }
      return value;
    },
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
