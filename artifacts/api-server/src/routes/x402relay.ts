import { Router } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  encodeFunctionData,
  concat,
  isAddress,
  isHex,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { db, gaslessNoncesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

const router = Router();

// ── x402 payment configuration ────────────────────────────────────────────────
// The payTo address receives USDC for each paid relay.
const PAY_TO = (process.env.FEE_COLLECTOR_ADDRESS ?? "") as `0x${string}`;
const RELAY_PRICE = "$0.001"; // 0.1¢ USDC per relay
const BASE_CHAIN_ID = "eip155:8453"; // Base Mainnet

let _x402Middleware: ReturnType<typeof paymentMiddleware> | null = null;

function getX402Middleware(): ReturnType<typeof paymentMiddleware> {
  if (_x402Middleware) return _x402Middleware;

  const facilitatorClient = new HTTPFacilitatorClient({
    url: "https://facilitator.x402.org",
  });

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    BASE_CHAIN_ID,
    new ExactEvmScheme(),
  );

  _x402Middleware = paymentMiddleware(
    {
      "POST /v2/relay": {
        accepts: {
          scheme: "exact",
          price: RELAY_PRICE,
          network: BASE_CHAIN_ID,
          payTo: PAY_TO || "0x0000000000000000000000000000000000000000",
        },
        description: "Gasless USDC relay — BasePay developer API",
      },
    },
    resourceServer,
  );

  return _x402Middleware;
}

// ── Chain clients (singletons) ────────────────────────────────────────────────
const transport = http("https://mainnet.base.org");
const publicClient = createPublicClient({ chain: base, transport });

type Relayer = {
  client: ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
};
let _relayer: Relayer | null = null;

function getRelayer(): Relayer {
  if (_relayer) return _relayer;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const key = pk.startsWith("0x") ? (pk as Hex) : (`0x${pk}` as Hex);
  const account = privateKeyToAccount(key);
  const client = createWalletClient({ account, chain: base, transport });
  _relayer = { client, account };
  return _relayer;
}

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const USDC_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
  "function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
]);

const MAX_VALUE = 1_000_000_000_000n; // 1M USDC

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

// ── GET /api/v2/relay/info — describe x402 requirements ───────────────────────
router.get("/v2/relay/info", (_req, res) => {
  res.json({
    version: "v2",
    protocol: "x402",
    price: RELAY_PRICE,
    network: BASE_CHAIN_ID,
    payTo: PAY_TO || null,
    facilitator: "https://facilitator.x402.org",
    description:
      "x402-gated USDC relay. Include a valid x402 payment header to access POST /api/v2/relay.",
    docs: "https://x402.org",
  });
});

// ── POST /api/v2/relay — x402-gated relay endpoint ────────────────────────────
// The x402 paymentMiddleware intercepts this, validates the USDC micro-payment,
// then passes the request through to the relay handler below.
router.post(
  "/v2/relay",
  (req, res, next) => {
    if (!PAY_TO || !PAY_TO.startsWith("0x")) {
      req.log.warn("x402 relay: FEE_COLLECTOR_ADDRESS not set — skipping payment gate");
      return next();
    }
    const mw = getX402Middleware();
    return mw(req, res, next);
  },
  async (req, res) => {
    const parsed = X402RelaySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }

    const { from, to, value, validAfter, validBefore, nonce, v, r, s } = parsed.data;
    const valueBig = BigInt(value);

    if (valueBig === 0n) return res.status(400).json({ error: "Value must be greater than zero" });
    if (valueBig > MAX_VALUE) return res.status(400).json({ error: "Value exceeds 1,000,000 USDC limit" });
    if (from.toLowerCase() === to.toLowerCase()) return res.status(400).json({ error: "Sender and recipient must differ" });

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now < BigInt(validAfter)) return res.status(400).json({ error: "Authorization not yet valid" });
    if (now >= BigInt(validBefore)) return res.status(400).json({ error: "Authorization has expired" });

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
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: "authorizationState",
        args: [from as `0x${string}`, nonce as `0x${string}`],
      });
      if (alreadyUsed) return res.status(400).json({ error: "Nonce already used on-chain" });

      const senderBal = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: "balanceOf",
        args: [from as `0x${string}`],
      });
      if (senderBal < valueBig) return res.status(400).json({ error: "Insufficient USDC balance" });

      let relayer: Relayer;
      try {
        relayer = getRelayer();
      } catch {
        return res.status(500).json({ error: "Relayer not configured" });
      }

      const calldata = encodeFunctionData({
        abi: USDC_ABI,
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
          chain: base,
          account: relayer.account,
          to: USDC_ADDRESS,
          data: calldata as Hex,
        });
      } catch (err: unknown) {
        const raw = err instanceof Error ? err.message : "Relay failed";
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

      req.log.info({ txHash, from, to, value }, "x402 relay completed");
      return res.json({ txHash, from, to, value, protocol: "x402" });
    } finally {
      pendingNonces.delete(nonce);
    }
  },
);

export default router;
