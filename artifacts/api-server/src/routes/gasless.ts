import { Router } from "express";
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
  formatEther,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Attribution } from "ox/erc8021";
import { db, gaslessNoncesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

// ── Base Builder Code (ERC-8021) ─────────────────────────────────────────────
// Register at base.dev → Settings → Builder Code, then set BASE_BUILDER_CODE
const _builderCode = process.env.BASE_BUILDER_CODE;
const DATA_SUFFIX: Hex | undefined = _builderCode
  ? (Attribution.toDataSuffix({ codes: [_builderCode] }) as Hex)
  : undefined;

const router = Router();

// ── Chain clients (singletons — do not re-create per request) ────────────────
const transport = http("https://mainnet.base.org");
const publicClient = createPublicClient({ chain: base, transport });

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
    transport,
    ...(DATA_SUFFIX ? { dataSuffix: DATA_SUFFIX } : {}),
  });
  _relayer = { client, account };
  return _relayer;
}

// ── USDC constants ────────────────────────────────────────────────────────────
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Max relay: 1,000,000 USDC = 1_000_000 * 10^6 = 10^12 atomic units (16 digits)
const MAX_VALUE = 1_000_000_000_000n;

const USDC_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
  "function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
]);

const MIN_ETH = 1_000_000_000_000_000n; // 0.001 ETH minimum

// ── In-memory pending-nonce guard (prevents concurrent-replay gas waste) ─────
// On-chain authorizationState is the authoritative guard; this is a cheap
// server-side pre-filter for truly concurrent duplicate submissions.
const pendingNonces = new Set<string>();

// ── Validation schema ─────────────────────────────────────────────────────────
const GaslessTransferSchema = z.object({
  from:        z.string().refine(isAddress, "invalid from address"),
  to:          z.string().refine(isAddress, "invalid to address"),
  // 1–16 digits → covers 0.000001 USDC to 999,999,999 USDC safely
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
  } catch {
    relayerReady = false;
  }

  return res.json({
    relayFeeUsdc: "0.00",
    relayerReady,
    relayerEthBalance,
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

  // 2. Semantic checks
  const valueBig = BigInt(value);
  if (valueBig === 0n) {
    return res.status(400).json({ error: "Value must be greater than zero" });
  }
  if (valueBig > MAX_VALUE) {
    return res.status(400).json({ error: "Value exceeds maximum relay limit (1,000,000 USDC)" });
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

  // 3. Timing checks
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

  // 4. Concurrent-replay guard (in-memory, fast — prevents burning relayer ETH
  //    on two truly-simultaneous submissions of the same signed nonce)
  if (pendingNonces.has(nonce)) {
    return res.status(400).json({ error: "Nonce is already being processed" });
  }
  pendingNonces.add(nonce);

  try {
    // 5. DB nonce check (fast path — catches any previously relayed nonce)
    const existing = await db
      .select()
      .from(gaslessNoncesTable)
      .where(eq(gaslessNoncesTable.nonce, nonce))
      .limit(1);
    if (existing.length > 0) {
      return res.status(400).json({ error: "Nonce already used" });
    }

    // 6. On-chain authorizationState (authoritative — catches nonces used outside this relayer)
    const alreadyUsed = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi:     USDC_ABI,
      functionName: "authorizationState",
      args: [from as `0x${string}`, nonce as `0x${string}`],
    });
    if (alreadyUsed) {
      return res.status(400).json({ error: "Nonce already used on-chain" });
    }

    // 7. Sender USDC balance check
    const senderBal = await publicClient.readContract({
      address: USDC_ADDRESS,
      abi:     USDC_ABI,
      functionName: "balanceOf",
      args: [from as `0x${string}`],
    });
    if (senderBal < valueBig) {
      return res.status(400).json({ error: "Insufficient USDC balance" });
    }

    // 8. Get relayer (singleton)
    let relayer: Relayer;
    try {
      relayer = getRelayer();
    } catch {
      return res.status(500).json({ error: "Relayer not configured" });
    }

    // 9. Submit transferWithAuthorization
    // Build calldata manually so the ERC-8021 builder code suffix is always
    // appended — bypasses viem's internal dataSuffix plumbing entirely.
    let txHash: Hex;
    try {
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
      const data: Hex = DATA_SUFFIX ? concat([calldata, DATA_SUFFIX]) : calldata;

      txHash = await relayer.client.sendTransaction({
        chain:   base,
        account: relayer.account,
        to:      USDC_ADDRESS,
        data,
      });
    } catch (err: unknown) {
      // Extract a clean revert reason from viem's verbose error format
      const raw = err instanceof Error ? err.message : "Relay failed";
      const match =
        raw.match(/reverted with the following reason:\s*\n(.+)/m)
        ?? raw.match(/Error: (.+?)(?:\n|$)/);
      const msg = (match ? match[1].trim() : raw).slice(0, 120);
      req.log.error({ err }, "gasless relay failed");
      return res.status(500).json({ error: msg });
    }

    // 10. Record spent nonce (on-chain is authoritative; this is a fast-path cache)
    await db.insert(gaslessNoncesTable).values({
      nonce,
      senderAddress: from.toLowerCase(),
      txHash,
    }).onConflictDoNothing();

    req.log.info({ txHash, from, to, value }, "gasless transfer relayed");
    return res.json({ txHash, from, to, value });

  } finally {
    // Always release the pending-nonce slot (success or error)
    pendingNonces.delete(nonce);
  }
});

export default router;
