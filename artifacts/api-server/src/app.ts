import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Trust the Replit proxy so that express-rate-limit can read the real client IP
// from X-Forwarded-For without throwing a ValidationError.
app.set("trust proxy", 1);

// ── HTTP security headers ─────────────────────────────────────────────────────
// Sets X-Content-Type-Options, X-Frame-Options, HSTS, X-DNS-Prefetch-Control,
// Referrer-Policy, and more. contentSecurityPolicy is disabled for the API server
// (no HTML served) to avoid blocking valid JSON responses.
app.use(helmet({ contentSecurityPolicy: false }));

// ── Allowed origins ──────────────────────────────────────────────────────────
// Accept the Replit dev/prod domain(s) and localhost for local development.
const ALLOWED_ORIGINS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /\.replit\.app$/,
  /\.replit\.dev$/,
  /\.replit\.co$/,
];

// CORS — public relay endpoints are open to any external dApp origin.
// All other routes are restricted to Replit domains.
app.use((req, res, next) => {
  const isPublicRelay =
    req.path.startsWith("/api/gasless") ||
    req.path.startsWith("/api/v2/relay");
  cors({
    origin: isPublicRelay
      ? true  // any origin — rate limiting (20 req/min per IP) handles abuse
      : (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
          if (!origin) return cb(null, true);
          const allowed = ALLOWED_ORIGINS.some((re) => re.test(origin));
          cb(allowed ? null : new Error("CORS: origin not allowed"), allowed);
        },
    credentials: !isPublicRelay,
  })(req, res, next);
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max:      120,          // 120 requests per IP per minute
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api", limiter);

// ── Tighter limit for mutating endpoints ──────────────────────────────────────
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: "Too many write requests, please slow down." },
});
app.use("/api/contacts", writeLimiter);
app.use("/api/payment-requests", writeLimiter);
app.use("/api/gasless", writeLimiter);
app.use("/api/swap/execute", writeLimiter);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id:     req.id,
          method: req.method,
          url:    req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);

app.use(express.json({ limit: "64kb" }));
app.use(express.urlencoded({ extended: true, limit: "64kb" }));

app.use("/api", router);

// ── Global error handler ──────────────────────────────────────────────────────
// Must be declared after all routes. Catches any error forwarded via next(err)
// or thrown inside async route handlers (Express 5 auto-forwards async throws).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number; statusCode?: number }).status
    ?? (err as { statusCode?: number }).statusCode
    ?? 500;
  const message =
    err instanceof Error ? err.message : "Internal server error";
  req.log?.error({ err }, "unhandled error");
  if (!res.headersSent) {
    res.status(status).json({ error: message });
  }
});

export default app;
