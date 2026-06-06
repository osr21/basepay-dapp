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
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Attribution } from "ox/erc8021";
import { z } from "zod";

// ── Base Builder Code (ERC-8021) ─────────────────────────────────────────────
const _builderCode = process.env.BASE_BUILDER_CODE;
const DATA_SUFFIX: Hex | undefined = _builderCode
  ? (Attribution.toDataSuffix({ codes: [_builderCode] }) as Hex)
  : undefined;

const router = Router();

// ── Chain clients ─────────────────────────────────────────────────────────────
const transport    = http("https://mainnet.base.org");
const publicClient = createPublicClient({ chain: base, transport });

type Relayer = { client: ReturnType<typeof createWalletClient>; account: ReturnType<typeof privateKeyToAccount> };
let _relayer: Relayer | null = null;
function getRelayer(): Relayer {
  if (_relayer) return _relayer;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const key = pk.startsWith("0x") ? (pk as Hex) : (`0x${pk}` as Hex);
  const account = privateKeyToAccount(key);
  const client  = createWalletClient({ account, chain: base, transport });
  _relayer = { client, account };
  return _relayer;
}

// ── Uniswap V3 constants on Base ──────────────────────────────────────────────
// SwapRouter02: supports selfPermit so we can permit+swap in one multicall tx
const SWAP_ROUTER  = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;
// QuoterV2: read-only quote for exactInputSingle
const QUOTER_V2    = "0x3d4e44Eb1374240CE5F1B136cf68A4f7f823aE3A" as const;
// Best USDC/EURC pool: fee tier 500 (0.05%), verified ~$3.75M liquidity
const POOL_FEE     = 500;

// ── Protocol fee ──────────────────────────────────────────────────────────────
// 0.30% on the output amount; relayer keeps this in its wallet.
const SWAP_FEE_BPS = 30n;

// ── Token whitelist (only these two directions are supported) ─────────────────
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;
const EURC = "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42" as const;

type TokenPair = { tokenIn: `0x${string}`; tokenOut: `0x${string}` };
function resolveTokens(tokenIn: string, tokenOut: string): TokenPair | null {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  if ((a === USDC && b === EURC) || (a === EURC && b === USDC)) {
    return { tokenIn: a as `0x${string}`, tokenOut: b as `0x${string}` };
  }
  return null;
}

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_ABI = parseAbi([
  "function nonces(address owner) external view returns (uint256)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external",
  "function balanceOf(address) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
]);

const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const ROUTER_ABI = parseAbi([
  "function selfPermit(address token, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external payable",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)",
  "function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)",
]);

// ── Max slippage: 1% ──────────────────────────────────────────────────────────
const MAX_SLIPPAGE_BPS = 100n; // 1%

// ── Rate limit: max 10,000 tokens per swap ────────────────────────────────────
const MAX_AMOUNT = 10_000_000_000n; // 10,000 * 1e6

// ── Validation schema ─────────────────────────────────────────────────────────
const SwapSchema = z.object({
  tokenIn:     z.string().refine(isAddress, "invalid tokenIn address"),
  tokenOut:    z.string().refine(isAddress, "invalid tokenOut address"),
  amountIn:    z.string().regex(/^\d{1,13}$/, "amountIn must be 1–13 digit integer string"),
  owner:       z.string().refine(isAddress, "invalid owner address"),
  deadline:    z.string().regex(/^\d{1,12}$/, "deadline must be unix timestamp"),
  permitV:     z.number().int().min(27).max(28),
  permitR:     z.string().refine((v: string) => isHex(v) && v.length === 66, "permitR must be 0x-prefixed 32-byte hex"),
  permitS:     z.string().refine((v: string) => isHex(v) && v.length === 66, "permitS must be 0x-prefixed 32-byte hex"),
  slippageBps: z.number().int().min(0).max(100).optional(),
});

// ── GET /api/swap/quote ───────────────────────────────────────────────────────
router.get("/swap/quote", async (req, res) => {
  const { tokenIn, tokenOut, amountIn } = req.query as Record<string, string | undefined>;

  if (!tokenIn || !tokenOut || !amountIn) {
    return res.status(400).json({ error: "tokenIn, tokenOut, amountIn are required" });
  }
  if (!isAddress(tokenIn) || !isAddress(tokenOut)) {
    return res.status(400).json({ error: "Invalid token address" });
  }
  const pair = resolveTokens(tokenIn, tokenOut);
  if (!pair) {
    return res.status(400).json({ error: "Only USDC↔EURC swaps are supported" });
  }

  let amountBig: bigint;
  try { amountBig = BigInt(amountIn); } catch {
    return res.status(400).json({ error: "amountIn must be an integer string" });
  }
  if (amountBig <= 0n || amountBig > MAX_AMOUNT) {
    return res.status(400).json({ error: "amountIn out of range (1 – 10,000 tokens)" });
  }

  try {
    const quoteResult = await publicClient.readContract({
      address:      QUOTER_V2,
      abi:          QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{
        tokenIn:           pair.tokenIn,
        tokenOut:          pair.tokenOut,
        amountIn:          amountBig,
        fee:               POOL_FEE,
        sqrtPriceLimitX96: 0n,
      }],
    });
    const amountOut = (quoteResult as readonly [bigint, ...unknown[]])[0];

    const slippageFactor   = (10_000n - MAX_SLIPPAGE_BPS);
    const amountOutMin     = (amountOut * slippageFactor) / 10_000n;

    // Protocol fee applied to the output received by the user
    const protocolFeeAmount  = (amountOut * SWAP_FEE_BPS) / 10_000n;
    const amountOutAfterFee  = amountOut - protocolFeeAmount;

    return res.json({
      amountOut:          amountOut.toString(),
      amountOutMin:       amountOutMin.toString(),
      fee:                POOL_FEE,
      protocolFeeBps:     Number(SWAP_FEE_BPS),
      protocolFeeAmount:  protocolFeeAmount.toString(),
      amountOutAfterFee:  amountOutAfterFee.toString(),
    });
  } catch (err) {
    req.log.warn({ err }, "swap quote failed");
    return res.status(503).json({ error: "Quote unavailable — pool may have insufficient liquidity" });
  }
});

// ── POST /api/swap/execute ────────────────────────────────────────────────────
router.post("/swap/execute", async (req, res) => {
  const parsed = SwapSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { tokenIn, tokenOut, amountIn, owner, deadline, permitV, permitR, permitS, slippageBps } = parsed.data;

  const pair = resolveTokens(tokenIn, tokenOut);
  if (!pair) {
    return res.status(400).json({ error: "Only USDC↔EURC swaps are supported" });
  }

  const amountBig = BigInt(amountIn);
  if (amountBig <= 0n || amountBig > MAX_AMOUNT) {
    return res.status(400).json({ error: "amountIn out of range" });
  }

  const deadlineBig = BigInt(deadline);
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (deadlineBig < now) {
    return res.status(400).json({ error: "Permit deadline has expired" });
  }

  // Check sender balance
  const balance = await publicClient.readContract({
    address:      pair.tokenIn,
    abi:          ERC20_ABI,
    functionName: "balanceOf",
    args:         [owner as `0x${string}`],
  });
  if (balance < amountBig) {
    return res.status(400).json({ error: "Insufficient token balance" });
  }

  // Get a fresh quote to compute amountOutMin
  let amountOutMin: bigint;
  try {
    const quoteResult = await publicClient.readContract({
      address:      QUOTER_V2,
      abi:          QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{
        tokenIn:           pair.tokenIn,
        tokenOut:          pair.tokenOut,
        amountIn:          amountBig,
        fee:               POOL_FEE,
        sqrtPriceLimitX96: 0n,
      }],
    });
    const amountOut = (quoteResult as readonly [bigint, ...unknown[]])[0];
    const slipBps   = BigInt(slippageBps ?? 50); // default 0.5%
    amountOutMin = (amountOut * (10_000n - slipBps)) / 10_000n;
  } catch {
    return res.status(503).json({ error: "Could not get swap quote — insufficient liquidity" });
  }

  let relayer: Relayer;
  try { relayer = getRelayer(); } catch {
    return res.status(500).json({ error: "Relayer not configured" });
  }

  // ── TX 1: selfPermit + exactInputSingle → output goes to relayer ─────────
  // The relayer holds the output tokens and distributes user's share in TX 2.
  const permitCalldata = encodeFunctionData({
    abi:          ROUTER_ABI,
    functionName: "selfPermit",
    args:         [pair.tokenIn, amountBig, deadlineBig, permitV, permitR as `0x${string}`, permitS as `0x${string}`],
  });

  const swapCalldata = encodeFunctionData({
    abi:          ROUTER_ABI,
    functionName: "exactInputSingle",
    args:         [{
      tokenIn:           pair.tokenIn,
      tokenOut:          pair.tokenOut,
      fee:               POOL_FEE,
      recipient:         relayer.account.address, // relayer receives output; distributes after fee
      amountIn:          amountBig,
      amountOutMinimum:  amountOutMin,
      sqrtPriceLimitX96: 0n,
    }],
  });

  const multicallData = encodeFunctionData({
    abi:          ROUTER_ABI,
    functionName: "multicall",
    args:         [[permitCalldata, swapCalldata]],
  });

  const finalData: Hex = DATA_SUFFIX ? concat([multicallData, DATA_SUFFIX]) : multicallData;

  let swapHash: Hex;
  try {
    swapHash = await relayer.client.sendTransaction({
      chain:   base,
      account: relayer.account,
      to:      SWAP_ROUTER,
      data:    finalData,
    });
  } catch (err: unknown) {
    const raw   = err instanceof Error ? err.message : "Swap failed";
    const match =
      raw.match(/reverted with the following reason:\s*\n(.+)/m)
      ?? raw.match(/Error: (.+?)(?:\n|$)/);
    const msg = (match ? match[1].trim() : raw).slice(0, 120);
    req.log.error({ err }, "gasless swap tx1 failed");
    return res.status(500).json({ error: msg });
  }

  // Wait for swap to confirm before distributing output
  try {
    await publicClient.waitForTransactionReceipt({ hash: swapHash, confirmations: 1 });
  } catch (err) {
    req.log.error({ err, swapHash }, "swap receipt timeout — manual recovery may be needed");
    return res.status(500).json({ error: "Swap submitted but confirmation timed out. Check BaseScan.", txHash: swapHash });
  }

  // ── TX 2: transfer (amountOutMin − protocol fee) to the user ─────────────
  // Using amountOutMin (worst-case actual output) ensures the relayer always
  // holds enough tokens. Any positive slippage accrues to the relayer.
  const userAmount = (amountOutMin * (10_000n - SWAP_FEE_BPS)) / 10_000n;

  let transferHash: Hex;
  try {
    transferHash = await relayer.client.writeContract({
      chain:        base,
      account:      relayer.account,
      address:      pair.tokenOut,
      abi:          ERC20_ABI,
      functionName: "transfer",
      args:         [owner as `0x${string}`, userAmount],
    });
  } catch (err: unknown) {
    // Swap succeeded but transfer failed — relayer holds the output tokens.
    // Log full details for manual recovery.
    req.log.error(
      { err, swapHash, owner, tokenOut: pair.tokenOut, userAmount: userAmount.toString() },
      "gasless swap tx2 (user transfer) failed — manual recovery needed"
    );
    return res.status(500).json({
      error: "Swap executed but output transfer failed. Contact support with swapHash.",
      swapHash,
    });
  }

  req.log.info(
    { swapHash, transferHash, owner, tokenIn: pair.tokenIn, tokenOut: pair.tokenOut, amountIn, userAmount: userAmount.toString() },
    "gasless swap completed"
  );

  return res.json({
    txHash:          swapHash,
    transferHash,
    tokenIn:         pair.tokenIn,
    tokenOut:        pair.tokenOut,
    amountIn,
    amountOutMin:    amountOutMin.toString(),
    amountOutAfterFee: userAmount.toString(),
  });
});

export default router;
