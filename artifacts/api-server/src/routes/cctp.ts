import { Router } from "express";

const router = Router();

// ── TTL cache — avoid hammering Circle's API on every 5-second browser poll ──
interface CacheEntry { status: number; body: unknown; expiresAt: number }
const attestationCache = new Map<string, CacheEntry>();
const PENDING_TTL_MS  = 10_000;    // 10 s for pending — client polls every 5 s
const COMPLETE_TTL_MS = 300_000;   // 5 min for complete — result is idempotent

// Prune stale entries every 5 minutes so the map never grows unbounded
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attestationCache) {
    if (entry.expiresAt <= now) attestationCache.delete(key);
  }
}, 300_000).unref();

// ── GET /api/cctp/attestation/:messageHash ─────────────────────────────────────
// Proxies to Circle's CCTP Attestation API to avoid CORS restrictions in the browser.
// messageHash = keccak256(messageBytesFromMessageSentEvent)
//
// Circle response shape:
//   { status: "pending_confirmations" | "complete", attestation: "0x..." }
//
// Docs: https://developers.circle.com/stablecoins/reference/getattestation
router.get("/cctp/attestation/:messageHash", async (req, res) => {
  const { messageHash } = req.params;

  if (!/^0x[0-9a-fA-F]{64}$/.test(messageHash)) {
    return res.status(400).json({ error: "messageHash must be a 0x-prefixed 32-byte hex string" });
  }

  // Serve from cache if still fresh
  const cached = attestationCache.get(messageHash);
  if (cached && cached.expiresAt > Date.now()) {
    return res.status(cached.status).json(cached.body);
  }

  // Guard against unbounded growth under adversarial load
  if (attestationCache.size >= 1_000) attestationCache.clear();

  let circleRes: Response;
  try {
    circleRes = await fetch(
      `https://iris-api.circle.com/v1/attestations/${messageHash}`,
      { signal: AbortSignal.timeout(12_000) },
    );
  } catch (err) {
    req.log.error({ err, messageHash }, "Circle attestation API request failed");
    return res.status(503).json({ error: "Circle attestation service unreachable" });
  }

  let body: unknown;
  try {
    body = await circleRes.json();
  } catch {
    return res.status(502).json({ error: "Invalid JSON from Circle attestation service" });
  }

  const isComplete = (body as Record<string, unknown>)?.status === "complete";
  attestationCache.set(messageHash, {
    status:    circleRes.status,
    body,
    expiresAt: Date.now() + (isComplete ? COMPLETE_TTL_MS : PENDING_TTL_MS),
  });

  return res.status(circleRes.status).json(body);
});

export default router;
