import { Router } from "express";
import { logger } from "../lib/logger";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  isAddress,
  isHex,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

const router = Router();

// ── Chain clients ─────────────────────────────────────────────────────────────
const transport    = http("https://mainnet.base.org");
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
  const client  = createWalletClient({ account, chain: base, transport });
  _relayer = { client, account };
  return _relayer;
}

// ── Retry helper for sequencer "in-flight transaction limit" ─────────────────
async function writeWithRetry<T>(
  fn:          () => Promise<T>,
  label:       string,
  maxAttempts  = 6,
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("in-flight transaction limit") && attempt < maxAttempts - 1) {
        const delayMs = 1_500 * (attempt + 1);
        logger.warn({ attempt, delayMs, label }, "in-flight limit — backing off");
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

// ── Aerodrome Finance on Base ─────────────────────────────────────────────────
// Aerodrome is the dominant AMM on Base; USDC/EURC has active pools here.
// (Uniswap V3 USDC/EURC pools have zero liquidity on Base.)
const AERODROME_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as const;
const AERODROME_ROUTER  = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as const;

// ── Token whitelist ────────────────────────────────────────────────────────────
const USDC    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const EURC    = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as const;
const USDC_LC = USDC.toLowerCase();
const EURC_LC = EURC.toLowerCase();

type TokenPair = { tokenIn: `0x${string}`; tokenOut: `0x${string}` };
function resolveTokens(tokenIn: string, tokenOut: string): TokenPair | null {
  const a = tokenIn.toLowerCase();
  const b = tokenOut.toLowerCase();
  if (a === USDC_LC && b === EURC_LC) return { tokenIn: USDC, tokenOut: EURC };
  if (a === EURC_LC && b === USDC_LC) return { tokenIn: EURC, tokenOut: USDC };
  return null;
}

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_ABI = parseAbi([
  "function balanceOf(address) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
]);

// EIP-3009: FiatToken V2.2 (USDC, EURC)
const EIP3009_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
]);

// Aerodrome factory
const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, bool stable) external view returns (address)",
]);

// Aerodrome pool (Solidly fork)
const POOL_ABI = parseAbi([
  "function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external",
  "function token0() external view returns (address)",
  "function getAmountOut(uint256 amountIn, address tokenIn) external view returns (uint256)",
  "function skim(address to) external",
]);

// Aerodrome router — only used for quotes
const AERODROME_ROUTER_ABI = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from",    type: "address" },
          { name: "to",      type: "address" },
          { name: "stable",  type: "bool"    },
          { name: "factory", type: "address" },
        ],
      },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

// ── Rate limit constants ───────────────────────────────────────────────────────
const MAX_AMOUNT   = 10_000_000_000n; // 10,000 tokens (6 dec)
const MAX_SLIP_BPS = 100n;            // 1% slippage guard on quote

// ── Pool auto-discovery ────────────────────────────────────────────────────────
// Tries stable + volatile, returns the pool with the better quote.
type AeroQuote = { amountOut: bigint; stable: boolean; poolAddress: `0x${string}` };

async function getBestPool(
  tokenIn:  `0x${string}`,
  tokenOut: `0x${string}`,
  amountIn: bigint,
): Promise<AeroQuote | null> {
  let best: AeroQuote | null = null;
  for (const stable of [true, false]) {
    try {
      const amounts = await publicClient.readContract({
        address:      AERODROME_ROUTER,
        abi:          AERODROME_ROUTER_ABI,
        functionName: "getAmountsOut",
        args:         [amountIn, [{ from: tokenIn, to: tokenOut, stable, factory: AERODROME_FACTORY }]],
      });
      const amountOut = amounts[1];
      if (amountOut <= 0n) continue;

      const poolAddress = await publicClient.readContract({
        address:      AERODROME_FACTORY,
        abi:          FACTORY_ABI,
        functionName: "getPool",
        args:         [tokenIn, tokenOut, stable],
      });
      if (!poolAddress || poolAddress === "0x0000000000000000000000000000000000000000") continue;

      if (!best || amountOut > best.amountOut) {
        best = { amountOut, stable, poolAddress };
      }
    } catch (err) {
      logger.debug({ stable, err: err instanceof Error ? err.message : String(err) }, "pool quote failed");
    }
  }
  return best;
}

// ── Validation schemas ────────────────────────────────────────────────────────
const QuoteSchema = z.object({
  tokenIn:  z.string().refine(isAddress, "invalid tokenIn"),
  tokenOut: z.string().refine(isAddress, "invalid tokenOut"),
  amountIn: z.string().regex(/^\d{1,13}$/, "amountIn must be 1–13 digit integer string"),
});

const SwapSchema = z.object({
  tokenIn:     z.string().refine(isAddress, "invalid tokenIn address"),
  tokenOut:    z.string().refine(isAddress, "invalid tokenOut address"),
  amountIn:    z.string().regex(/^\d{1,13}$/, "amountIn must be 1–13 digit integer string"),
  owner:       z.string().refine(isAddress, "invalid owner address"),
  // EIP-3009 authorization
  validAfter:  z.string().regex(/^\d{1,12}$/, "validAfter must be unix timestamp string"),
  validBefore: z.string().regex(/^\d{1,12}$/, "validBefore must be unix timestamp string"),
  nonce:       z.string().refine((v: string) => isHex(v) && v.length === 66, "nonce must be 0x-prefixed 32-byte hex"),
  v:           z.number().int().min(27).max(28),
  r:           z.string().refine((v: string) => isHex(v) && v.length === 66, "r must be 0x-prefixed 32-byte hex"),
  s:           z.string().refine((v: string) => isHex(v) && v.length === 66, "s must be 0x-prefixed 32-byte hex"),
  slippageBps: z.number().int().min(0).max(100).optional(),
});

// ── GET /api/swap/quote ───────────────────────────────────────────────────────
router.get("/swap/quote", async (req, res) => {
  const parsed = QuoteSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query params" });
  }
  const { tokenIn, tokenOut, amountIn } = parsed.data;

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

  const best = await getBestPool(pair.tokenIn, pair.tokenOut, amountBig);
  if (!best) {
    req.log.warn({ tokenIn: pair.tokenIn, tokenOut: pair.tokenOut, amountIn }, "no Aerodrome pool found");
    return res.status(503).json({ error: "No liquid pool found for this pair — try a smaller amount" });
  }

  const { amountOut, stable, poolAddress } = best;
  const amountOutMin = (amountOut * (10_000n - MAX_SLIP_BPS)) / 10_000n;

  req.log.info({ stable, poolAddress, amountOut: amountOut.toString() }, "Aerodrome swap quote");

  return res.json({
    amountOut:         amountOut.toString(),
    amountOutMin:      amountOutMin.toString(),
    fee:               stable ? 100 : 500,
    protocolFeeBps:    0,
    protocolFeeAmount: "0",
    amountOutAfterFee: amountOut.toString(),
    poolAddress,
    stable,
  });
});

// ── POST /api/swap/execute ────────────────────────────────────────────────────
// Gasless swap via direct Aerodrome pool interaction — 2 relayer transactions:
//
//   TX1: token.transferWithAuthorization(from=user, to=pool, value=amountIn, ...)
//        → input tokens move directly from user wallet to the Aerodrome pool.
//          The relay wallet never holds the input tokens.
//
//   TX2: pool.swap(amount0Out, amount1Out, to=user, data="0x")
//        → output tokens move directly from the Aerodrome pool to the user wallet.
//          The relay wallet never holds the output tokens.
//
// Error recovery:
//   - TX1 failure  → return error; user's funds never left their wallet.
//   - TX2 failure after TX1 → attempt pool.skim(relayer) to recover the deposited
//     tokens from the pool's excess balance, then refund user. If skim fails (e.g.
//     another tx consumed the excess), log and return error — operator must resolve.
router.post("/swap/execute", async (req, res) => {
  const parsed = SwapSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { tokenIn, tokenOut, amountIn, owner, validAfter, validBefore, nonce, v, r, s, slippageBps } = parsed.data;

  const pair = resolveTokens(tokenIn, tokenOut);
  if (!pair) {
    return res.status(400).json({ error: "Only USDC↔EURC swaps are supported" });
  }

  const amountBig      = BigInt(amountIn);
  const validAfterBig  = BigInt(validAfter);
  const validBeforeBig = BigInt(validBefore);
  const nowSeconds     = BigInt(Math.floor(Date.now() / 1000));

  if (amountBig <= 0n || amountBig > MAX_AMOUNT) {
    return res.status(400).json({ error: "amountIn out of range" });
  }
  if (validBeforeBig < nowSeconds) {
    return res.status(400).json({ error: "EIP-3009 authorization has expired (validBefore is in the past)" });
  }

  // Verify sender balance
  const balance = await publicClient.readContract({
    address:      pair.tokenIn,
    abi:          ERC20_ABI,
    functionName: "balanceOf",
    args:         [owner as `0x${string}`],
  });
  if (balance < amountBig) {
    return res.status(400).json({ error: "Insufficient token balance" });
  }

  // Find best pool and get initial quote for slippage reference
  const best = await getBestPool(pair.tokenIn, pair.tokenOut, amountBig);
  if (!best) {
    return res.status(503).json({ error: "Could not get swap quote — no liquid pool found" });
  }
  const { poolAddress, stable: poolStable } = best;
  const slipBps      = BigInt(slippageBps ?? 50);
  const amountOutMin = (best.amountOut * (10_000n - slipBps)) / 10_000n;

  // Determine token0/token1 ordering for pool.swap output amounts
  // (Solidly pools sort tokens by address; lower address = token0)
  const token0 = await publicClient.readContract({
    address:      poolAddress,
    abi:          POOL_ABI,
    functionName: "token0",
  });
  const isToken0In = pair.tokenIn.toLowerCase() === token0.toLowerCase();
  // If tokenIn = token0 → output is token1 → amount0Out=0, amount1Out=X
  // If tokenIn = token1 → output is token0 → amount0Out=X, amount1Out=0

  let relayer: Relayer;
  try { relayer = getRelayer(); } catch {
    return res.status(500).json({ error: "Relayer not configured" });
  }

  // ── TX 1: transferWithAuthorization(user → pool) ──────────────────────────
  // USDC/EURC move directly from the user's wallet to the Aerodrome pool.
  // The relay wallet signs and pays gas but never holds the tokens.
  let twaHash: Hex;
  try {
    twaHash = await writeWithRetry(
      () => relayer.client.writeContract({
        chain:        base,
        account:      relayer.account,
        address:      pair.tokenIn,
        abi:          EIP3009_ABI,
        functionName: "transferWithAuthorization",
        args:         [
          owner as `0x${string}`,
          poolAddress,
          amountBig,
          validAfterBig,
          validBeforeBig,
          nonce as `0x${string}`,
          v,
          r as `0x${string}`,
          s as `0x${string}`,
        ],
      }),
      "TX1 transferWithAuthorization",
    );
    const twaReceipt = await publicClient.waitForTransactionReceipt({ hash: twaHash, confirmations: 1 });
    if (twaReceipt.status !== "success") {
      req.log.error({ twaHash, status: twaReceipt.status }, "swap TX1 (transferWithAuthorization) reverted");
      return res.status(400).json({
        error: "Authorization rejected by token contract — signature may be invalid, expired, or nonce already used.",
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : "Transfer authorization failed";
    req.log.error({ err }, "swap TX1 (transferWithAuthorization) failed");
    // TX1 failed → user's tokens never moved, safe to return error
    return res.status(500).json({ error: `Transfer failed: ${msg}` });
  }

  // Refresh amountOut from pool immediately before TX2 to account for any
  // price movement since the quote was fetched.
  let freshAmountOut: bigint;
  try {
    freshAmountOut = await publicClient.readContract({
      address:      poolAddress,
      abi:          POOL_ABI,
      functionName: "getAmountOut",
      args:         [amountBig, pair.tokenIn],
    });
  } catch {
    freshAmountOut = best.amountOut; // fall back to original quote
  }

  // Slippage guard: if price moved too much after TX1, skim tokens back and abort
  if (freshAmountOut < amountOutMin) {
    req.log.warn(
      { freshAmountOut: freshAmountOut.toString(), amountOutMin: amountOutMin.toString(), twaHash },
      "slippage exceeded post-TX1 — attempting skim + refund",
    );
    try {
      const skimHash = await writeWithRetry(
        () => relayer.client.writeContract({
          chain: base, account: relayer.account,
          address: poolAddress, abi: POOL_ABI,
          functionName: "skim",
          args: [relayer.account.address],
        }),
        "slippage-recovery skim",
      );
      await publicClient.waitForTransactionReceipt({ hash: skimHash, confirmations: 1 });
      const refundHash = await writeWithRetry(
        () => relayer.client.writeContract({
          chain: base, account: relayer.account,
          address: pair.tokenIn, abi: ERC20_ABI,
          functionName: "transfer",
          args: [owner as `0x${string}`, amountBig],
        }),
        "slippage-recovery refund",
      );
      req.log.info({ refundHash, twaHash }, "refunded user after slippage abort");
      return res.status(400).json({
        error: "Price moved too much since quote — your tokens have been refunded.",
        refundHash,
      });
    } catch (recErr) {
      req.log.error({ recErr, twaHash }, "slippage recovery failed — tokens may be stuck in pool");
      return res.status(500).json({
        error: "Slippage too high and recovery failed — contact support with your transaction hash.",
        twaHash,
      });
    }
  }

  // ── TX 2: pool.swap(→ user) ───────────────────────────────────────────────
  // Output tokens move directly from pool to user wallet.
  const amount0Out = isToken0In ? 0n : freshAmountOut;
  const amount1Out = isToken0In ? freshAmountOut : 0n;

  let swapHash: Hex;
  try {
    swapHash = await writeWithRetry(
      () => relayer.client.writeContract({
        chain:        base,
        account:      relayer.account,
        address:      poolAddress,
        abi:          POOL_ABI,
        functionName: "swap",
        args:         [amount0Out, amount1Out, owner as `0x${string}`, "0x"],
      }),
      "TX2 pool.swap",
    );
  } catch (submitErr) {
    // TX2 failed to submit — USDC is in pool but swap not mined → try to recover via skim
    req.log.error({ err: submitErr, twaHash }, "swap TX2 submit failed — attempting skim recovery");
    try {
      const skimHash = await writeWithRetry(
        () => relayer.client.writeContract({
          chain: base, account: relayer.account,
          address: poolAddress, abi: POOL_ABI,
          functionName: "skim",
          args: [relayer.account.address],
        }),
        "TX2-submit-recovery skim",
      );
      await publicClient.waitForTransactionReceipt({ hash: skimHash, confirmations: 1 });
      const refundHash = await writeWithRetry(
        () => relayer.client.writeContract({
          chain: base, account: relayer.account,
          address: pair.tokenIn, abi: ERC20_ABI,
          functionName: "transfer",
          args: [owner as `0x${string}`, amountBig],
        }),
        "TX2-submit-recovery refund",
      );
      req.log.info({ refundHash, twaHash }, "refunded user after TX2 submit failure");
      return res.status(500).json({ error: "Swap could not be submitted — your tokens have been refunded.", refundHash });
    } catch (recErr) {
      req.log.error({ recErr, twaHash }, "TX2 submit recovery failed — tokens may be in pool");
    }
    return res.status(500).json({
      error: "Swap failed — contact support with your transaction hash.",
      twaHash,
    });
  }

  // Wait for receipt
  let swapReceipt: Awaited<ReturnType<typeof publicClient.waitForTransactionReceipt>>;
  try {
    swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swapHash, confirmations: 1, timeout: 90_000 });
  } catch (receiptErr) {
    // Receipt timeout — swap may have already mined. Return txHash. Do NOT attempt refund.
    req.log.error({ err: receiptErr, swapHash, twaHash }, "TX2 receipt timeout — returning txHash");
    return res.status(200).json({
      txHash:           swapHash,
      tokenIn,
      tokenOut,
      amountIn,
      amountOutAfterFee: freshAmountOut.toString(),
      warning:          "Swap submitted but receipt timed out — please verify on BaseScan",
    });
  }

  if (swapReceipt.status !== "success") {
    // pool.swap reverted — try to skim the deposited tokens back
    req.log.error({ swapHash, twaHash, status: swapReceipt.status }, "TX2 (pool.swap) reverted");
    try {
      const skimHash = await writeWithRetry(
        () => relayer.client.writeContract({
          chain: base, account: relayer.account,
          address: poolAddress, abi: POOL_ABI,
          functionName: "skim",
          args: [relayer.account.address],
        }),
        "TX2-revert-recovery skim",
      );
      await publicClient.waitForTransactionReceipt({ hash: skimHash, confirmations: 1 });
      const refundHash = await writeWithRetry(
        () => relayer.client.writeContract({
          chain: base, account: relayer.account,
          address: pair.tokenIn, abi: ERC20_ABI,
          functionName: "transfer",
          args: [owner as `0x${string}`, amountBig],
        }),
        "TX2-revert-recovery refund",
      );
      req.log.info({ refundHash, swapHash, twaHash }, "refunded user after TX2 revert");
      return res.status(500).json({ error: "Swap reverted on-chain — your tokens have been refunded.", refundHash });
    } catch (recErr) {
      req.log.error({ recErr, swapHash, twaHash }, "TX2 revert recovery failed");
    }
    return res.status(500).json({ error: "Swap reverted — contact support.", swapHash, twaHash });
  }

  req.log.info(
    { swapHash, twaHash, amountIn, amountOut: freshAmountOut.toString(), owner, stable: poolStable },
    "gasless swap complete — relay wallet never held user tokens",
  );

  return res.json({
    txHash:           swapHash,
    tokenIn,
    tokenOut,
    amountIn,
    amountOutAfterFee: freshAmountOut.toString(),
  });
});

export default router;
