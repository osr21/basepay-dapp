import { Router } from "express";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  isAddress,
  isHex,
  type Hex,
  formatEther,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { db, gaslessNoncesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod";

const router = Router();

// ── Chain clients ─────────────────────────────────────────────────────────────
const transport = http("https://mainnet.base.org");

const publicClient = createPublicClient({ chain: base, transport });

function getWalletClient() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const key = pk.startsWith("0x") ? (pk as Hex) : (`0x${pk}` as Hex);
  const account = privateKeyToAccount(key);
  return { client: createWalletClient({ account, chain: base, transport }), account };
}

// ── USDC constants ────────────────────────────────────────────────────────────
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const USDC_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
  "function authorizationState(address authorizer, bytes32 nonce) external view returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
]);

const MIN_ETH = 1_000_000_000_000_000n; // 0.001 ETH minimum relayer balance

// ── Validation schema ─────────────────────────────────────────────────────────
const GaslessTransferSchema = z.object({
  from:        z.string().refine(isAddress, "invalid from address"),
  to:          z.string().refine(isAddress, "invalid to address"),
  value:       z.string().regex(/^\d+$/, "value must be decimal integer string"),
  validAfter:  z.string().regex(/^\d+$/, "validAfter must be decimal integer string"),
  validBefore: z.string().regex(/^\d+$/, "validBefore must be decimal integer string"),
  nonce:       z.string().refine((v: string) => isHex(v) && v.length === 66, "nonce must be 0x-prefixed 32-byte hex"),
  v:           z.number().int().min(27).max(28),
  r:           z.string().refine((v: string) => isHex(v) && v.length === 66, "r must be 0x-prefixed 32-byte hex"),
  s:           z.string().refine((v: string) => isHex(v) && v.length === 66, "s must be 0x-prefixed 32-byte hex"),
});

// ── GET /api/gasless/fee ──────────────────────────────────────────────────────
router.get("/gasless/fee", async (req, res) => {
  let relayerReady = false;
  let relayerEthBalance = "0";

  try {
    const { account } = getWalletClient();
    const ethBal = await publicClient.getBalance({ address: account.address });
    relayerEthBalance = formatEther(ethBal);
    relayerReady = ethBal >= MIN_ETH;
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
  // 1. Validate input
  const parsed = GaslessTransferSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { from, to, value, validAfter, validBefore, nonce, v, r, s } = parsed.data;

  // 2. Timing checks
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < BigInt(validAfter)) {
    return res.status(400).json({ error: "Authorization not yet valid" });
  }
  if (now >= BigInt(validBefore)) {
    return res.status(400).json({ error: "Authorization has expired" });
  }

  // 3. Check nonce not already used in our DB (fast path before chain call)
  const existing = await db
    .select()
    .from(gaslessNoncesTable)
    .where(eq(gaslessNoncesTable.nonce, nonce))
    .limit(1);
  if (existing.length > 0) {
    return res.status(400).json({ error: "Nonce already used" });
  }

  // 4. Check authorization state on-chain (authoritative check)
  const alreadyUsed = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "authorizationState",
    args: [from as `0x${string}`, nonce as `0x${string}`],
  });
  if (alreadyUsed) {
    return res.status(400).json({ error: "Nonce already used on-chain" });
  }

  // 5. Check sender USDC balance
  const senderBal = await publicClient.readContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: [from as `0x${string}`],
  });
  if (senderBal < BigInt(value)) {
    return res.status(400).json({ error: "Insufficient USDC balance" });
  }

  // 6. Get relayer wallet
  let walletClient: ReturnType<typeof createWalletClient>;
  let relayerAccount: ReturnType<typeof privateKeyToAccount>;
  try {
    const wc = getWalletClient();
    walletClient = wc.client;
    relayerAccount = wc.account;
  } catch {
    return res.status(500).json({ error: "Relayer not configured" });
  }

  // 7. Submit transferWithAuthorization
  let txHash: Hex;
  try {
    txHash = await walletClient.writeContract({
      chain: base,
      account: relayerAccount,
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: "transferWithAuthorization",
      args: [
        from as `0x${string}`,
        to as `0x${string}`,
        BigInt(value),
        BigInt(validAfter),
        BigInt(validBefore),
        nonce as `0x${string}`,
        v,
        r as `0x${string}`,
        s as `0x${string}`,
      ],
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Relay failed";
    req.log.error({ err }, "gasless relay failed");
    return res.status(500).json({ error: msg.slice(0, 200) });
  }

  // 8. Record nonce in DB (fire-and-forget; on-chain is authoritative)
  await db.insert(gaslessNoncesTable).values({
    nonce,
    senderAddress: from.toLowerCase(),
    txHash,
  }).onConflictDoNothing();

  req.log.info({ txHash, from, to, value }, "gasless transfer relayed");

  return res.json({ txHash, from, to, value });
});

export default router;
