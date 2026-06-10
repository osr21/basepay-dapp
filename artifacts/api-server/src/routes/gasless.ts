import { Router } from "express";
import {
  createWalletClient,
  parseAbi,
  encodeFunctionData,
  concat,
  isAddress,
  isHex,
  type Hex,
  formatEther,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Attribution } from "ox/erc8021";
import { db, gaslessNoncesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { baseTransport, basePublicClient as publicClient } from "../lib/rpc";

// ── Base Builder Code (ERC-8021) ─────────────────────────────────────────────
const _builderCode = process.env.BASE_BUILDER_CODE;
const DATA_SUFFIX: Hex | undefined = _builderCode
  ? (Attribution.toDataSuffix({ codes: [_builderCode] }) as Hex)
  : undefined;

const router = Router();

type Relayer = {
  client:  ReturnType<typeof createWalletClient>;
  account: ReturnType<typeof privateKeyToAccount>;
};
let _relayer: Relayer | null = null;

function getRelayer(): Relayer {
  if (_relayer) return _relayer;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const key = pk.startsWith("0x") ? (pk as Hex) : (`0x${pk}` as Hex);
  const account = privateKeyToAccount(key);
  const client  = createWalletClient({
    account,
    chain: base,
    transport: baseTransport,
    ...(DATA_SUFFIX ? { dataSuffix: DATA_SUFFIX } : {}),
  });
  _relayer = { client, account };
  return _relayer;
}

// ── EIP-3009 token whitelist ──────────────────────────────────────────────────
// Only Circle FiatToken V2.2 contracts — they share the transferWithAuthorization
// + authorizationState interface and are audited. Any new token must be added here.
type TokenMeta = { symbol: string; decimals: number };
const ALLOWED_TOKENS = new Map<string, TokenMeta>([
  [
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    { symbol: "USDC", decimals: 6 },
  ],
  [
    "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42",
    { symbol: "EURC", decimals: 6 },
  ],
]);

const DEFAULT_TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // USDC

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Max relay per request: 1,000,000 tokens (same limit regardless of token)
const MAX_VALUE = 1_000_000_000_000n; // 1e12 atomic units (6 decimals)

const EIP3009_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
  "function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
]);

const MIN_ETH = 1_000_000_000_000_000n; // 0.001 ETH minimum

// ── In-memory pending-nonce guard ─────────────────────────────────────────────
const pendingNonces = new Set<string>();

// ── Validation schema ─────────────────────────────────────────────────────────
const GaslessTransferSchema = z.object({
  token:       z.string().refine(isAddress, "invalid token address").optional(),
  from:        z.string().refine(isAddress, "invalid from address"),
  to:          z.string().refine(isAddress, "invalid to address"),
  value:       z.string().regex(/^\d{1,16}$/, "value must be 1–16 digit integer"),
  validAfter:  z.string().regex(/^\d{1,12}$/, "validAfter must be a unix timestamp"),
  validBefore: z.string().regex(/^\d{1,12}$/, "validBefore must be a unix timestamp"),
  nonce:       z.string().refine((v: string) => isHex(v) && v.length === 66, "nonce must be 0x-prefixed 32-byte hex"),
  v:           z.number().int().min(27).max(28),
  r:           z.string().refine((v: string) => isHex(v) && v.length === 66, "r must be 0x-prefixed 32-byte hex"),
  s:           z.string().refine((v: string) => isHex(v) && v.length === 66, "s must be 0x-prefixed 32-byte hex"),
});

// ── GET /api/gasless/fee ──────────────────────────────────────────────────────
router.get("/gasless/fee", async (_req, res) => {
  let relayerReady      = false;
  let relayerEthBalance = "0";

  try {
    const { account } = getRelayer();
    const ethBal = await publicClient.getBalance({ address: account.address });
    relayerEthBalance = formatEther(ethBal);
    relayerReady      = ethBal >= MIN_ETH;
    // Blank out balance — we return only the boolean so callers cannot
    // monitor relay wallet funds to time DoS/drain attacks.
    relayerEthBalance = "";
  } catch {
    relayerReady = false;
  }

  return res.json({
    relayFeeUsdc: "0.00",
    relayerReady,
    networkName: "Base Mainnet",
  });
});

// ── POST /api/gasless/transfer ────────────────────────────────────────────────
router.post("/gasless/transfer", async (req, res) => {
  // 1. Validate input shape
  const parsed = GaslessTransferSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { from, to, value, validAfter, validBefore, nonce, v, r, s } = parsed.data;

  // 2. Resolve and whitelist-check token
  const tokenAddr = (parsed.data.token ?? DEFAULT_TOKEN).toLowerCase();
  const tokenMeta = ALLOWED_TOKENS.get(tokenAddr);
  if (!tokenMeta) {
    return res.status(400).json({
      error: `Token not supported for gasless relay. Allowed: ${[...ALLOWED_TOKENS.keys()].join(", ")}`,
    });
  }
  const TOKEN_ADDRESS = tokenAddr as `0x${string}`;

  // 3. Semantic checks
  const valueBig = BigInt(value);
  if (valueBig === 0n) {
    return res.status(400).json({ error: "Value must be greater than zero" });
  }
  if (valueBig > MAX_VALUE) {
    return res.status(400).json({ error: `Value exceeds maximum relay limit (1,000,000 ${tokenMeta.symbol})` });
  }
  if (from.toLowerCase() === ZERO_ADDRESS) {
    return res.status(400).json({ error: "Invalid sender address" });
  }
  if (to.toLowerCase() === ZERO_ADDRESS) {
    return res.status(400).json({ error: "Invalid recipient address" });
  }
  if (from.toLowerCase() === to.toLowerCase()) {
    return res.status(400).json({ error: "Sender and recipient must be different addresses" });
  }

  // 4. Timing checks
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < BigInt(validAfter)) {
    return res.status(400).json({ error: "Authorization not yet valid" });
  }
  if (now >= BigInt(validBefore)) {
    return res.status(400).json({ error: "Authorization has expired" });
  }
  if (BigInt(validBefore) <= BigInt(validAfter)) {
    return res.status(400).json({ error: "validBefore must be after validAfter" });
  }

  // 5. Concurrent-replay guard
  const nonceKey = `${tokenAddr}:${nonce}`;
  if (pendingNonces.has(nonceKey)) {
    return res.status(400).json({ error: "Nonce is already being processed" });
  }
  pendingNonces.add(nonceKey);

  try {
    // 6. DB nonce check
    const existing = await db
      .select()
      .from(gaslessNoncesTable)
      .where(eq(gaslessNoncesTable.nonce, nonce))
      .limit(1);
    if (existing.length > 0) {
      return res.status(400).json({ error: "Nonce already used" });
    }

    // 7. On-chain authorizationState
    const alreadyUsed = await publicClient.readContract({
      address:      TOKEN_ADDRESS,
      abi:          EIP3009_ABI,
      functionName: "authorizationState",
      args: [from as `0x${string}`, nonce as `0x${string}`],
    });
    if (alreadyUsed) {
      return res.status(400).json({ error: "Nonce already used on-chain" });
    }

    // 8. Sender balance check
    const senderBal = await publicClient.readContract({
      address:      TOKEN_ADDRESS,
      abi:          EIP3009_ABI,
      functionName: "balanceOf",
      args: [from as `0x${string}`],
    });
    if (senderBal < valueBig) {
      return res.status(400).json({ error: `Insufficient ${tokenMeta.symbol} balance` });
    }

    // 9. Get relayer
    let relayer: Relayer;
    try {
      relayer = getRelayer();
    } catch (err) {
      req.log.error({ err }, "getRelayer failed");
      return res.status(500).json({ error: "Relayer not configured" });
    }

    // 10. Submit transferWithAuthorization
    let txHash: Hex;
    try {
      const calldata = encodeFunctionData({
        abi:          EIP3009_ABI,
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
      const data: Hex = DATA_SUFFIX ? concat([calldata, DATA_SUFFIX]) : calldata;

      txHash = await relayer.client.sendTransaction({
        chain:   base,
        account: relayer.account,
        to:      TOKEN_ADDRESS,
        data,
      });
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : "Relay failed";
      const match =
        raw.match(/reverted with the following reason:\s*\n(.+)/m)
        ?? raw.match(/Error: (.+?)(?:\n|$)/);
      const msg = (match ? match[1].trim() : raw).slice(0, 120);
      req.log.error({ err }, "gasless relay failed");
      return res.status(500).json({ error: msg });
    }

    // 11. Record spent nonce
    await db.insert(gaslessNoncesTable).values({
      nonce,
      senderAddress: from.toLowerCase(),
      txHash,
    }).onConflictDoNothing();

    req.log.info({ txHash, from, to, value, token: TOKEN_ADDRESS, symbol: tokenMeta.symbol }, "gasless transfer relayed");
    return res.json({ txHash, token: TOKEN_ADDRESS, from, to, value });

  } finally {
    pendingNonces.delete(nonceKey);
  }
});

export default router;
