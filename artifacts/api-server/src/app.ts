import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Trust the Replit proxy so that express-rate-limit can read the real client IP
// from X-Forwarded-For without throwing a ValidationError.
app.set("trust proxy", 1);

// ── Allowed origins ──────────────────────────────────────────────────────────
// Accept the Replit dev/prod domain(s) and localhost for local development.
const ALLOWED_ORIGINS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /\.replit\.app$/,
  /\.replit\.dev$/,
  /\.replit\.co$/,
];

app.use(
  cors({
    origin(origin, cb) {
      // Non-browser requests (e.g. curl, server-to-server) have no Origin header.
      if (!origin) return cb(null, true);
      const allowed = ALLOWED_ORIGINS.some((re) => re.test(origin));
      cb(allowed ? null : new Error("CORS: origin not allowed"), allowed);
    },
    credentials: true,
  }),
);

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
