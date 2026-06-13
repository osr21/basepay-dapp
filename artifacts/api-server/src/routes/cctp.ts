import { Router } from "express";
import { parseAbi, keccak256, formatEther } from "viem";
import { base, mainnet, optimism, arbitrum, polygon, type Chain } from "viem/chains";
import { z } from "zod";
import {
  getChainPublicClient,
  getChainWalletClient,
  getRelayerAccount,
} from "../lib/rpc";

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

// ── CCTP relay-receive ────────────────────────────────────────────────────────
// Server-side registry — mirrors CrossChain.tsx CHAINS array.
// The relayer calls receiveMessage so the user never needs ETH on the dest chain.

interface CctpChainConfig { chain: Chain; messageTransmitter: `0x${string}` }

const CCTP_CHAIN_CONFIGS: Record<number, CctpChainConfig> = {
  [base.id]:     { chain: base,     messageTransmitter: "0xAD09780d193884d503182aD4588450C416D6F9D4" },
  [mainnet.id]:  { chain: mainnet,  messageTransmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81" },
  [optimism.id]: { chain: optimism, messageTransmitter: "0x4d41f22c5a0e5c74090899e5a8fb597a8842b3e8" },
  [arbitrum.id]: { chain: arbitrum, messageTransmitter: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca" },
  [polygon.id]:  { chain: polygon,  messageTransmitter: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9" },
};

// CCTP domain number → chain ID
const DOMAIN_TO_CHAIN_ID: Record<number, number> = {
  0: mainnet.id,
  2: optimism.id,
  3: arbitrum.id,
  6: base.id,
  7: polygon.id,
};

const MESSAGE_TRANSMITTER_ABI = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) external returns (bool success)",
]);

// Minimum ETH the relayer must hold before attempting a relay
const MIN_RELAY_ETH = 500_000_000_000_000n; // 0.0005 ETH

// In-flight guard — prevents double-submitting the same message while a relay is running
const pendingRelays = new Set<string>();

// Completed relay registry — returns the existing txHash on retries instead of
// wasting gas on a duplicate on-chain call that will revert.
const completedRelays = new Map<string, string>(); // relayKey → txHash
// Prune once daily — completed relays are idempotent at the contract level anyway
setInterval(() => completedRelays.clear(), 86_400_000).unref();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Parse the destinationDomain from raw CCTP v1 message bytes.
 *
 * CCTP v1 header layout (all big-endian uint32/uint64):
 *   bytes  0– 3: version          (uint32)
 *   bytes  4– 7: sourceDomain     (uint32)
 *   bytes  8–11: destinationDomain (uint32)  ← what we read
 *   bytes 12–19: nonce            (uint64)
 *   ...
 *
 * With 0x prefix: hex chars 18–26 = destinationDomain
 * (matches the same slice used in the frontend Resume flow)
 */
function parseCctpDestDomain(msgHex: `0x${string}`): number {
  const hex = msgHex.slice(2); // strip 0x
  if (hex.length < 24) throw new Error("messageBytes too short to contain a CCTP v1 header (need ≥12 bytes)");
  return parseInt(hex.slice(16, 24), 16); // bytes 8–11
}

/**
 * Fetch and validate the Circle attestation for a given message from Circle's API.
 *
 * SECURITY: We never use the attestation supplied by the caller — it could be
 * crafted to cause a contract revert and waste relayer gas.  Instead we always
 * source the attestation from Circle's authoritative API.
 *
 * The shared attestationCache is checked first, so if the browser-side poll
 * already populated a "complete" entry no extra HTTP round-trip is needed.
 */
async function fetchCircleAttestation(msgHex: `0x${string}`): Promise<string> {
  const msgHash = keccak256(msgHex);

  // Cache hit — avoids a redundant Circle API call when the browser already polled
  const cached = attestationCache.get(msgHash);
  if (cached && cached.expiresAt > Date.now()) {
    const b = cached.body as Record<string, unknown>;
    if (b.status === "complete" && typeof b.attestation === "string") return b.attestation;
    throw new Error("Attestation not yet complete — the burn needs more confirmations before relaying");
  }

  let circleRes: Response;
  try {
    circleRes = await fetch(
      `https://iris-api.circle.com/v1/attestations/${msgHash}`,
      { signal: AbortSignal.timeout(12_000) },
    );
  } catch {
    throw new Error("Circle attestation service unreachable — please try again in a moment");
  }

  const body = await circleRes.json() as Record<string, unknown>;
  if (body.status !== "complete" || typeof body.attestation !== "string") {
    throw new Error("Attestation not yet complete — wait for Circle to confirm the burn before relaying");
  }

  // Cache the verified complete attestation for future calls
  attestationCache.set(msgHash, {
    status:    circleRes.status,
    body,
    expiresAt: Date.now() + COMPLETE_TTL_MS,
  });

  return body.attestation;
}

const RelayReceiveSchema = z.object({
  // At least 116 bytes (CCTP message header is 116 bytes minimum)
  messageBytes: z.string().regex(/^0x[0-9a-fA-F]{232,}$/, "messageBytes must be at least 116 bytes of hex"),
  // destDomain and attestation are accepted from the client but NOT trusted.
  // destDomain is re-derived from messageBytes; attestation is fetched from Circle.
  destDomain:  z.number().int().min(0).max(20).optional(),
  attestation: z.string().optional(),
});

// ── POST /api/cctp/relay-receive ──────────────────────────────────────────────
// Submits receiveMessage on behalf of the user so they need no ETH on the
// destination chain.  The USDC always mints to the mintRecipient encoded in
// the message — the caller cannot redirect it.
//
// Body: { messageBytes: "0x…", destDomain?: number, attestation?: string }
// Returns: { txHash: "0x…" }
router.post("/cctp/relay-receive", async (req, res) => {
  const parsed = RelayReceiveSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { messageBytes } = parsed.data;

  // ── Derive destination chain from the message bytes — never trust the client ──
  let destDomain: number;
  try {
    destDomain = parseCctpDestDomain(messageBytes as `0x${string}`);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid messageBytes" });
  }

  const chainId = DOMAIN_TO_CHAIN_ID[destDomain];
  if (chainId === undefined) {
    return res.status(400).json({ error: `Unsupported CCTP destination domain: ${destDomain}` });
  }
  const cfg = CCTP_CHAIN_CONFIGS[chainId];
  if (!cfg) {
    return res.status(400).json({ error: `Chain config missing for domain ${destDomain}` });
  }

  // Stable dedup key — keccak256 of the raw message bytes
  const relayKey = keccak256(messageBytes as `0x${string}`);

  // ── Short-circuit: already relayed by this server ─────────────────────────
  // Return the cached txHash immediately so the frontend can track confirmation
  // without triggering a redundant on-chain call that would only revert.
  const existingTx = completedRelays.get(relayKey);
  if (existingTx) {
    req.log.info({ txHash: existingTx, chain: cfg.chain.name }, "CCTP relay already completed — returning cached txHash");
    return res.json({ txHash: existingTx });
  }

  // ── In-flight dedup — reject concurrent submissions of the same message ───
  if (pendingRelays.has(relayKey)) {
    return res.status(409).json({ error: "This message is already being relayed" });
  }
  pendingRelays.add(relayKey);

  try {
    // Resolve relayer account
    let relayerAccount: ReturnType<typeof getRelayerAccount>;
    try {
      relayerAccount = getRelayerAccount();
    } catch (err) {
      req.log.error({ err }, "getRelayerAccount failed for CCTP relay");
      return res.status(500).json({ error: "Relayer not configured" });
    }

    const publicClient = getChainPublicClient(cfg.chain);
    const walletClient = getChainWalletClient(cfg.chain);

    // Check relayer ETH balance on the destination chain before attempting relay
    const ethBalance = await publicClient.getBalance({ address: relayerAccount.address });
    if (ethBalance < MIN_RELAY_ETH) {
      req.log.warn(
        { chain: cfg.chain.name, balance: formatEther(ethBalance) },
        "Relayer ETH balance too low for CCTP relay",
      );
      return res.status(503).json({
        error: `Relayer has insufficient ETH on ${cfg.chain.name} — use self-relay instead`,
        selfRelay: true,
      });
    }

    // ── Fetch attestation from Circle — never trust client-provided value ─────
    // A crafted or invalid attestation would cause an on-chain revert and waste
    // relayer gas.  We always source from Circle's authoritative API.
    let attestation: string;
    try {
      attestation = await fetchCircleAttestation(messageBytes as `0x${string}`);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "Cannot verify attestation" });
    }

    // Submit receiveMessage on the destination chain
    let txHash: `0x${string}`;
    try {
      txHash = await walletClient.writeContract({
        address:      cfg.messageTransmitter,
        abi:          MESSAGE_TRANSMITTER_ABI,
        functionName: "receiveMessage",
        args:         [messageBytes as `0x${string}`, attestation as `0x${string}`],
        account:      relayerAccount,
        chain:        cfg.chain,
        gas:          400_000n,
      });
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      // Already received on-chain — not an error from the user's perspective
      if (/nonce already used|already received|already minted/i.test(raw)) {
        return res.status(409).json({ error: "Message already received on destination chain" });
      }
      const match =
        raw.match(/reverted with the following reason:\s*\n(.+)/m)
        ?? raw.match(/Error: (.+?)(?:\n|$)/);
      const msg = (match ? match[1].trim() : raw).slice(0, 160);
      req.log.error({ err, destDomain, chain: cfg.chain.name }, "CCTP relay-receive failed");
      return res.status(500).json({ error: msg });
    }

    // Record as completed so future retries return the existing txHash
    completedRelays.set(relayKey, txHash);

    req.log.info(
      { txHash, destDomain, chain: cfg.chain.name },
      "CCTP relay-receive submitted",
    );
    return res.json({ txHash });

  } finally {
    pendingRelays.delete(relayKey);
  }
});

// ── GET /api/cctp/relay-status ────────────────────────────────────────────────
// Returns whether the relayer has sufficient ETH on each destination chain.
// Useful for the frontend to decide whether to show the gasless receive option.
router.get("/cctp/relay-status", async (req, res) => {
  let relayerAddress: `0x${string}`;
  try {
    relayerAddress = getRelayerAccount().address;
  } catch {
    return res.json({ available: false, chains: {} });
  }

  const results: Record<string, boolean> = {};

  await Promise.allSettled(
    Object.entries(CCTP_CHAIN_CONFIGS).map(async ([, cfg]) => {
      try {
        const pc  = getChainPublicClient(cfg.chain);
        const bal = await pc.getBalance({ address: relayerAddress });
        results[cfg.chain.name] = bal >= MIN_RELAY_ETH;
      } catch {
        results[cfg.chain.name] = false;
      }
    }),
  );

  return res.json({ available: Object.values(results).some(Boolean), chains: results });
});

export default router;
