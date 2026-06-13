import { Router, type Request, type Response, type NextFunction } from "express";
import { verifyMessage, isAddress, type Hex } from "viem";
import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { db, developerKeysTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";

const router = Router();

// ── JWT secret ────────────────────────────────────────────────────────────────
function getJwtSecret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET not set");
  if (s.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters for HS256 signing");
  return new TextEncoder().encode(s);
}

async function signDevJwt(address: string): Promise<string> {
  return new SignJWT({ address })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(getJwtSecret());
}

export async function verifyDevJwt(token: string): Promise<string | null> {
  try {
    // Explicitly enforce HS256 to prevent algorithm-confusion attacks
    // (e.g., a crafted token with alg:none or alg:RS256).
    const { payload } = await jwtVerify(token, getJwtSecret(), { algorithms: ["HS256"] });
    return typeof payload.address === "string" ? payload.address : null;
  } catch {
    return null;
  }
}

// ── Session cookie ────────────────────────────────────────────────────────────
// The JWT is stored server-side in an HttpOnly cookie — JS on the page can
// never read it, which eliminates the XSS token-theft vector that exists when
// tokens are stored in localStorage.
const COOKIE_NAME             = "dev_session";
const SESSION_MAX_AGE_SECONDS = 86_400; // 24 h

/** Parse a single named value from a raw Cookie request-header string. */
function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const sep = part.indexOf("=");
    if (sep === -1) continue;
    const k = part.slice(0, sep).trim();
    if (k === name) return decodeURIComponent(part.slice(sep + 1).trim());
  }
  return undefined;
}

/** Set the HttpOnly session cookie after successful authentication. */
function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,   // not readable by document.cookie / JS
    secure:   true,   // HTTPS-only — Replit always proxies over HTTPS
    sameSite: "strict",
    maxAge:   SESSION_MAX_AGE_SECONDS * 1_000, // express uses ms
    path:     "/api/developer",  // scoped — only sent for /api/developer/* requests
  });
}

/** Expire the session cookie on logout. */
function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/api/developer" });
}

// ── In-memory rate limiter for /developer/auth ─────────────────────────────
// Limits expensive verifyMessage calls to 20 attempts per IP per hour.
const _authAttempts = new Map<string, { count: number; resetAt: number }>();
const AUTH_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const AUTH_LIMIT     = 20;

function checkAuthRateLimit(ip: string): boolean {
  const now   = Date.now();
  const entry = _authAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    _authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
    return true;
  }
  if (entry.count >= AUTH_LIMIT) return false;
  entry.count++;
  return true;
}

// Prune stale entries every hour so the Map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _authAttempts) {
    if (entry.resetAt < now) _authAttempts.delete(ip);
  }
}, AUTH_WINDOW_MS).unref();

// ── Auth middleware ────────────────────────────────────────────────────────────
interface DevRequest extends Request { developerAddress: string; }

async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = readCookie(req.headers.cookie, COOKIE_NAME);
  if (!token) {
    return res.status(401).json({ error: "Not authenticated — sign with your wallet to continue" });
  }
  const address = await verifyDevJwt(token);
  if (!address) return res.status(401).json({ error: "Session expired — sign again" });
  (req as DevRequest).developerAddress = address;
  return next();
}

// ── Validation schemas ─────────────────────────────────────────────────────────
const AuthSchema = z.object({
  address:   z.string().refine(isAddress, "Invalid Ethereum address"),
  timestamp: z.number().int().positive("timestamp must be a positive integer"),
  signature: z.string().min(1),
});

const CreateKeySchema = z.object({
  name: z.string().min(1, "name is required").max(80, "name must be at most 80 chars"),
});

// ── POST /api/developer/auth ──────────────────────────────────────────────────
// Verifies an EIP-191 wallet signature and sets a 24h HttpOnly session cookie.
router.post("/developer/auth", async (req, res) => {
  const ip = (req.ip ?? req.socket?.remoteAddress ?? "unknown");
  if (!checkAuthRateLimit(ip)) {
    req.log.warn({ ip }, "developer auth rate limit exceeded");
    return res.status(429).json({ error: "Too many authentication attempts — try again in an hour" });
  }

  const parsed = AuthSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { address, timestamp, signature } = parsed.data;

  const ageSeconds = Math.floor(Date.now() / 1000) - timestamp;
  if (ageSeconds < 0 || ageSeconds > 600) {
    return res.status(400).json({ error: "Signature timestamp too old or in the future — re-sign" });
  }

  const message = `BasePay Developer Portal\nAddress: ${address}\nTimestamp: ${timestamp}`;
  let valid = false;
  try {
    valid = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as Hex });
  } catch {
    valid = false;
  }
  if (!valid) return res.status(401).json({ error: "Signature verification failed" });

  const token = await signDevJwt(address.toLowerCase());
  setSessionCookie(res, token);
  req.log.info({ address }, "developer session issued");
  // Return the address (not the token — it lives in the HttpOnly cookie now)
  return res.json({ address: address.toLowerCase(), expiresIn: SESSION_MAX_AGE_SECONDS });
});

// ── GET /api/developer/session ─────────────────────────────────────────────────
// Returns the wallet address bound to the current session, or null.
// Used by the frontend to restore auth state on page load without re-signing.
router.get("/developer/session", async (req, res) => {
  const token = readCookie(req.headers.cookie, COOKIE_NAME);
  if (!token) return res.json({ authenticated: false, address: null });
  const address = await verifyDevJwt(token);
  return res.json({ authenticated: !!address, address: address ?? null });
});

// ── POST /api/developer/logout ─────────────────────────────────────────────────
// Clears the session cookie, ending the authenticated session immediately.
router.post("/developer/logout", (req, res) => {
  clearSessionCookie(res);
  req.log.info("developer session cleared");
  return res.json({ success: true });
});

// ── GET /api/developer/keys ────────────────────────────────────────────────────
router.get("/developer/keys", requireAuth, async (req, res) => {
  const address = (req as DevRequest).developerAddress;
  const rows = await db
    .select()
    .from(developerKeysTable)
    .where(eq(developerKeysTable.walletAddress, address));

  return res.json(rows.map(r => ({
    id:           r.id,
    name:         r.name,
    keyPrefix:    r.keyPrefix,
    createdAt:    r.createdAt.toISOString(),
    revokedAt:    r.revokedAt?.toISOString() ?? null,
    lastUsedAt:   r.lastUsedAt?.toISOString() ?? null,
    requestCount: r.requestCount,
    revoked:      r.revokedAt !== null,
  })));
});

// ── POST /api/developer/keys ───────────────────────────────────────────────────
// Creates a new API key — the plaintext is returned exactly once and never stored.
router.post("/developer/keys", requireAuth, async (req, res) => {
  const parsed = CreateKeySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const address = (req as DevRequest).developerAddress;

  const active = await db
    .select({ id: developerKeysTable.id })
    .from(developerKeysTable)
    .where(and(eq(developerKeysTable.walletAddress, address), isNull(developerKeysTable.revokedAt)));

  if (active.length >= 10) {
    return res.status(400).json({ error: "Maximum 10 active API keys — revoke one first" });
  }

  const rawKey    = `bpk_${randomBytes(32).toString("hex")}`;
  const keyHash   = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 12);

  const [row] = await db
    .insert(developerKeysTable)
    .values({ walletAddress: address, keyPrefix, keyHash, name: parsed.data.name })
    .returning();

  req.log.info({ id: row.id, address }, "developer API key created");
  return res.status(201).json({
    id:        row.id,
    name:      row.name,
    keyPrefix,
    createdAt: row.createdAt.toISOString(),
    key:       rawKey,
  });
});

// ── DELETE /api/developer/keys/:id ────────────────────────────────────────────
router.delete("/developer/keys/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  if (isNaN(id)) return res.status(400).json({ error: "Invalid key ID" });

  const address = (req as DevRequest).developerAddress;
  const [updated] = await db
    .update(developerKeysTable)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(developerKeysTable.id, id),
      eq(developerKeysTable.walletAddress, address),
      isNull(developerKeysTable.revokedAt),
    ))
    .returning({ id: developerKeysTable.id });

  if (!updated) return res.status(404).json({ error: "Key not found or already revoked" });

  req.log.info({ id, address }, "developer API key revoked");
  return res.json({ success: true });
});

export default router;
