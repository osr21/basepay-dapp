import { Router } from "express";

const router = Router();

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

  return res.status(circleRes.status).json(body);
});

export default router;
