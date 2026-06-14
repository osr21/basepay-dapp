import { Router } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  createWalletClient,
  parseAbi,
  encodeFunctionData,
  isAddress,
  isHex,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { type privateKeyToAccount } from "viem/accounts";
import { baseTransport, basePublicClient as publicClient, getRelayerAccount, getChainWalletClient } from "../lib/rpc";
import { createPrivateKey, createHash } from "crypto";
import { SignJWT } from "jose";
import { db, gaslessNoncesTable, developerKeysTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { z } from "zod";

const router = Router();

// ── x402 payment configuration ────────────────────────────────────────────────
const _rawPayTo = process.env.FEE_COLLECTOR_ADDRESS ?? "";
const PAY_TO: `0x${string}` | "" =
  _rawPayTo.startsWith("0x") && _rawPayTo.length === 42
    ? (_rawPayTo as `0x${string}`)
    : "";
const RELAY_PRICE    = "$0.001"; // 0.1¢ USDC per relay
const BASE_CHAIN_ID  = "eip155:8453"; // Base Mainnet

// ── Facilitator selection ─────────────────────────────────────────────────────
// When CDP credentials are present we use the Coinbase CDP mainnet facilitator
// (supports eip155:8453). Without them we fall back to the public x402.org
// facilitator which only supports Base Sepolia — payment gate returns 503.
const CDP_FACILITATOR_URL    = "https://api.cdp.coinbase.com/platform/x402/facilitator";
const PUBLIC_FACILITATOR_URL = "https://x402.org/facilitator";

function hasCdpCredentials(): boolean {
  return !!(process.env.CDP_API_KEY_NAME && process.env.CDP_API_KEY_PRIVATE_KEY);
}

// ── CDP private key cache ─────────────────────────────────────────────────────
// Parsed once per process — PEM parsing is cheap but unnecessary per-request.
type CdpKey = { key: ReturnType<typeof createPrivateKey>; alg: string };
let _cdpKey: CdpKey | null = null;

function getCdpKey(): CdpKey {
  if (_cdpKey) return _cdpKey;
  // Replit secrets preserve literal \n — normalize to real newlines
  const pem = process.env.CDP_API_KEY_PRIVATE_KEY!.replace(/\\n/g, "\n");
  const key  = createPrivateKey(pem);
  const alg  = key.asymmetricKeyType === "ed25519" ? "EdDSA" : "ES256";
  _cdpKey = { key, alg };
  return _cdpKey;
}

/**
 * Generates fresh CDP JWT credentials for each x402 facilitator call.
 * Tokens are scoped per-endpoint and expire after 2 minutes.
 *
 * CDP API key format (from portal.cdp.coinbase.com JSON download):
 *   name:       "organizations/<org_id>/apiKeys/<key_id>"
 *   privateKey: EC P-256 or Ed25519 PEM (auto-detected)
 */
async function createCdpAuthHeaders(): Promise<{
  verify:    Record<string, string>;
  settle:    Record<string, string>;
  supported: Record<string, string>;
}> {
  const keyName = process.env.CDP_API_KEY_NAME!;
  const { key: privateKey, alg } = getCdpKey();

  const host     = "api.cdp.coinbase.com";
  const basePath = "/platform/x402/facilitator";
  const now      = Math.floor(Date.now() / 1000);

  const makeJwt = (method: string, endpoint: string) =>
    new SignJWT({
      iss: keyName,
      sub: keyName,
      nbf: now,
      uri: `${method} ${host}${basePath}/${endpoint}`,
    })
      .setProtectedHeader({ alg, kid: keyName })
      .setExpirationTime(now + 120)
      .sign(privateKey);

  const [verifyJwt, settleJwt, supportedJwt] = await Promise.all([
    makeJwt("POST", "verify"),
    makeJwt("POST", "settle"),
    makeJwt("GET",  "supported"),
  ]);

  return {
    verify:    { Authorization: `Bearer ${verifyJwt}` },
    settle:    { Authorization: `Bearer ${settleJwt}` },
    supported: { Authorization: `Bearer ${supportedJwt}` },
  };
}

// ── Middleware singleton ───────────────────────────────────────────────────────
let _x402Middleware: ReturnType<typeof paymentMiddleware> | null = null;
let _facilitatorStatus: "unknown" | "ok" | "unavailable" = "unknown";

function getX402Middleware(): ReturnType<typeof paymentMiddleware> {
  if (_x402Middleware) return _x402Middleware;

  const useCdp = hasCdpCredentials();

  const facilitatorClient = new HTTPFacilitatorClient(
    useCdp
      ? { url: CDP_FACILITATOR_URL, createAuthHeaders: createCdpAuthHeaders }
      : { url: PUBLIC_FACILITATOR_URL },
  );

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    BASE_CHAIN_ID,
    new ExactEvmScheme(),
  );

  _x402Middleware = paymentMiddleware(
    {
      "POST /v2/relay": {
        accepts: {
          scheme:  "exact",
          price:   RELAY_PRICE,
          network: BASE_CHAIN_ID,
          payTo:   PAY_TO || "0x0000000000000000000000000000000000000000",
        },
        description: "Gasless USDC relay — BasePay developer API",
      },
    },
    resourceServer,
  );

  return _x402Middleware;
}

/**
 * Wraps paymentMiddleware and intercepts configuration-error responses.
 * For the CDP facilitator these should never occur (mainnet is supported).
 * Kept as a safety net in case credentials are wrong or service is down.
 */
function x402Gate(
  req: Parameters<ReturnType<typeof paymentMiddleware>>[0],
  res: Parameters<ReturnType<typeof paymentMiddleware>>[1],
  next: Parameters<ReturnType<typeof paymentMiddleware>>[2],
) {
  if (_facilitatorStatus === "unavailable") {
    const useCdp = hasCdpCredentials();
    return res.status(503).json({
      error:  "x402 payment facilitation unavailable",
      detail: useCdp
        ? "CDP facilitator returned a configuration error. Check server credentials."
        : `The public facilitator (x402.org) does not support ${BASE_CHAIN_ID}. Configure a mainnet-capable facilitator.`,
      docs: "https://www.x402.org",
    });
  }

  const origJson = res.json.bind(res) as typeof res.json;

  (res as typeof res & { json: typeof res.json }).json = (body: unknown) => {
    const isConfigError =
      res.statusCode === 500 &&
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof (body as { error: unknown }).error === "string" &&
      ((body as { error: string }).error.includes("Route Configuration Errors") ||
        (body as { error: string }).error.includes("does not support") ||
        (body as { error: string }).error.includes("no supported payment kinds"));

    (res as typeof res & { json: typeof res.json }).json = origJson;

    if (isConfigError) {
      _facilitatorStatus = "unavailable";
      req.log.warn({ network: BASE_CHAIN_ID, cdp: hasCdpCredentials() }, "x402 facilitator config error");
      return res.status(503).json({
        error:  "x402 payment facilitation unavailable",
        detail: hasCdpCredentials()
          ? "CDP facilitator returned a configuration error. Verify your CDP API key has x402 access."
          : `The public facilitator (x402.org) does not support ${BASE_CHAIN_ID}.`,
        docs: "https://www.x402.org",
      });
    }

    _facilitatorStatus = "ok";
    return origJson(body);
  };

  return getX402Middleware()(req, res, next);
}

// ── Chain clients — see ../lib/rpc.ts (uses authenticated Coinbase node) ──────
type Relayer = {
  client:  ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
};

function getRelayer(): Relayer {
  const account = getRelayerAccount();
  const client  = getChainWalletClient(base);
  return { client, account };
}

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const USDC_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
  "function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
]);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_VALUE    = 1_000_000_000_000n; // 1M USDC

const X402RelaySchema = z.object({
  from:        z.string().refine(isAddress, "invalid from address"),
  to:          z.string().refine(isAddress, "invalid to address"),
  value:       z.string().regex(/^\d{1,16}$/, "value must be 1–16 digit integer"),
  validAfter:  z.string().regex(/^\d{1,12}$/, "validAfter must be a unix timestamp"),
  validBefore: z.string().regex(/^\d{1,12}$/, "validBefore must be a unix timestamp"),
  nonce:       z.string().refine((v) => isHex(v) && v.length === 66, "nonce must be 0x-prefixed 32-byte hex"),
  v:           z.number().int().min(27).max(28),
  r:           z.string().refine((v) => isHex(v) && v.length === 66),
  s:           z.string().refine((v) => isHex(v) && v.length === 66),
});

const pendingNonces = new Set<string>();

// ── API Key bypass ─────────────────────────────────────────────────────────────
// If a valid developer API key is present in X-API-Key, skip the x402 payment
// gate and track the request count against the key. Keys are issued via the
// developer portal at /developer.
async function checkApiKey(
  req: Parameters<typeof x402Gate>[0] & { __apiKeyAuth?: boolean },
  _res: Parameters<typeof x402Gate>[1],
  next: Parameters<typeof x402Gate>[2],
) {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.startsWith("bpk_")) {
    try {
      const keyHash = createHash("sha256").update(apiKey).digest("hex");
      const [row] = await db
        .select()
        .from(developerKeysTable)
        .where(and(eq(developerKeysTable.keyHash, keyHash), isNull(developerKeysTable.revokedAt)))
        .limit(1);
      if (row) {
        db.update(developerKeysTable)
          .set({ requestCount: row.requestCount + 1, lastUsedAt: new Date() })
          .where(eq(developerKeysTable.id, row.id))
          .catch(() => {});
        req.__apiKeyAuth = true;
      }
    } catch {
      // Invalid key format or DB error — fall through to x402
    }
  }
  next();
}

// ── GET /api/v2/relay/info ─────────────────────────────────────────────────────
router.get("/v2/relay/info", (_req, res) => {
  const useCdp = hasCdpCredentials();
  res.json({
    version:     "v2",
    protocol:    "x402",
    price:       RELAY_PRICE,
    network:     BASE_CHAIN_ID,
    payTo:       PAY_TO || null,
    facilitator: useCdp ? CDP_FACILITATOR_URL : PUBLIC_FACILITATOR_URL,
    mainnet:     useCdp,
    description: "x402-gated USDC relay. Include a valid x402 payment header to access POST /api/v2/relay.",
    docs:        "https://www.x402.org",
  });
});

// ── POST /api/v2/relay — x402-gated relay endpoint ────────────────────────────
router.post(
  "/v2/relay",
  checkApiKey as Parameters<typeof router.post>[1],
  (req, res, next) => {
    const r = req as typeof req & { __apiKeyAuth?: boolean };
    if (r.__apiKeyAuth) {
      req.log.info("x402 relay: developer API key auth bypass");
      return next();
    }
    if (!PAY_TO) {
      req.log.warn("x402 relay: FEE_COLLECTOR_ADDRESS not set — skipping payment gate");
      return next();
    }
    return x402Gate(req, res, next);
  },
  async (req, res) => {
    const parsed = X402RelaySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }

    const { from, to, value, validAfter, validBefore, nonce, v, r, s } = parsed.data;
    const valueBig = BigInt(value);

    if (valueBig === 0n)                         return res.status(400).json({ error: "Value must be greater than zero" });
    if (valueBig > MAX_VALUE)                    return res.status(400).json({ error: "Value exceeds 1,000,000 USDC limit" });
    if (from.toLowerCase() === ZERO_ADDRESS)     return res.status(400).json({ error: "Invalid sender address" });
    if (to.toLowerCase() === ZERO_ADDRESS)       return res.status(400).json({ error: "Invalid recipient address" });
    if (from.toLowerCase() === to.toLowerCase()) return res.status(400).json({ error: "Sender and recipient must differ" });

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(validBefore) <= BigInt(validAfter)) return res.status(400).json({ error: "validBefore must be after validAfter" });
    if (now < BigInt(validAfter))                  return res.status(400).json({ error: "Authorization not yet valid" });
    if (now >= BigInt(validBefore))                return res.status(400).json({ error: "Authorization has expired" });

    if (pendingNonces.has(nonce)) return res.status(400).json({ error: "Nonce is already being processed" });
    pendingNonces.add(nonce);

    try {
      const existing = await db
        .select()
        .from(gaslessNoncesTable)
        .where(eq(gaslessNoncesTable.nonce, nonce))
        .limit(1);
      if (existing.length > 0) return res.status(400).json({ error: "Nonce already used" });

      const alreadyUsed = await publicClient.readContract({
        address:      USDC_ADDRESS,
        abi:          USDC_ABI,
        functionName: "authorizationState",
        args: [from as `0x${string}`, nonce as `0x${string}`],
      });
      if (alreadyUsed) return res.status(400).json({ error: "Nonce already used on-chain" });

      const senderBal = await publicClient.readContract({
        address:      USDC_ADDRESS,
        abi:          USDC_ABI,
        functionName: "balanceOf",
        args: [from as `0x${string}`],
      });
      if (senderBal < valueBig) return res.status(400).json({ error: "Insufficient USDC balance" });

      let relayer: Relayer;
      try {
        relayer = getRelayer();
      } catch (err) {
        req.log.error({ err }, "getRelayer failed");
        return res.status(500).json({ error: "Relayer not configured" });
      }

      const calldata = encodeFunctionData({
        abi:          USDC_ABI,
        functionName: "transferWithAuthorization",
        args: [
          from        as `0x${string}`,
          to          as `0x${string}`,
          valueBig,
          BigInt(validAfter),
          BigInt(validBefore),
          nonce       as `0x${string}`,
          v,
          r           as `0x${string}`,
          s           as `0x${string}`,
        ],
      });

      let txHash: Hex;
      try {
        txHash = await relayer.client.sendTransaction({
          chain:   base,
          account: relayer.account,
          to:      USDC_ADDRESS,
          data:    calldata as Hex,
        });
      } catch (err: unknown) {
        const raw   = err instanceof Error ? err.message : "Relay failed";
        const match =
          raw.match(/reverted with the following reason:\s*\n(.+)/m)
          ?? raw.match(/Error: (.+?)(?:\n|$)/);
        const msg = (match ? match[1].trim() : raw).slice(0, 120);
        req.log.error({ err }, "x402 relay failed");
        return res.status(500).json({ error: msg });
      }

      await db
        .insert(gaslessNoncesTable)
        .values({ nonce, senderAddress: from.toLowerCase(), txHash })
        .onConflictDoNothing();

      req.log.info({ txHash, from, to, value, cdp: hasCdpCredentials() }, "x402 relay completed");
      return res.json({ txHash, from, to, value, protocol: "x402" });
    } finally {
      pendingNonces.delete(nonce);
    }
  },
);

export default router;
