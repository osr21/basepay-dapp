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
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
]);

// EIP-3009: FiatToken V2.2 (USDC, EURC)
const EIP3009_ABI = parseAbi([
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external",
]);

// Aerodrome factory
const FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, bool stable) external view returns (address)",
]);

// Aerodrome router — quotes and atomic swaps
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
  {
    type: "function",
    name: "swapExactTokensForTokens",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amountIn",     type: "uint256" },
      { name: "amountOutMin", type: "uint256" },
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
      { name: "to",       type: "address" },
      { name: "deadline", type: "uint256" },
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
  // Whether to use the stable (true) or volatile (false) Aerodrome pool
  stable:      z.boolean(),
  // EIP-3009 authorization (signed for the relay wallet as recipient)
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

  let relayerAddress: string;
  try { relayerAddress = getRelayer().account.address; } catch {
    return res.status(500).json({ error: "Relayer not configured" });
  }

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
    relayerAddress,
  });
});

// ── POST /api/swap/execute ────────────────────────────────────────────────────
// Gasless swap via Aerodrome Router — 2 relayer transactions:
//
//   TX1: token.transferWithAuthorization(from=user, to=relay, value=amountIn, ...)
//        → input tokens move from the user's wallet to the relay wallet.
//          The relay temporarily holds them between TX1 and TX2.
//
//   TX2: aerodromeRouter.swapExactTokensForTokens(amountIn, amountOutMin, routes, user, deadline)
//        → Router atomically pulls input tokens from relay, executes the pool swap,
//          and delivers output tokens directly to the user wallet in one tx.
//
// Why router instead of pool.swap directly:
//   The prior approach was transferWithAuthorization(user→pool) then pool.swap — two
//   separate txs. Any tx between them that updates the pool's stored reserves (another
//   swap, pool.sync, etc.) causes pool.swap to revert with InsufficientInputAmount()
//   because it sees balance == reserve (no excess input deposit visible).
//   The Aerodrome Router atomically deposits and swaps in one tx, eliminating this race.
//
// Error recovery:
//   - TX1 failure  → return error; user's funds never left their wallet.
//   - TX2 failure after TX1 → relay holds tokenIn → transfer directly back to user.
router.post("/swap/execute", async (req, res) => {
  req.log.info({ tokenIn: req.body?.tokenIn, tokenOut: req.body?.tokenOut, amountIn: req.body?.amountIn, owner: req.body?.owner }, "swap execute request received");

  const parsed = SwapSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { tokenIn, tokenOut, amountIn, owner, stable, validAfter, validBefore, nonce, v, r, s, slippageBps } = parsed.data;

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

  let relayer: Relayer;
  try { relayer = getRelayer(); } catch {
    return res.status(500).json({ error: "Relayer not configured" });
  }

  // Verify sender balance and get a fresh quote in parallel
  const routes = [{ from: pair.tokenIn, to: pair.tokenOut, stable, factory: AERODROME_FACTORY }] as const;
  let balance: bigint;
  let quoteAmounts: readonly bigint[];
  try {
    [balance, quoteAmounts] = await Promise.all([
      publicClient.readContract({
        address:      pair.tokenIn,
        abi:          ERC20_ABI,
        functionName: "balanceOf",
        args:         [owner as `0x${string}`],
      }),
      publicClient.readContract({
        address:      AERODROME_ROUTER,
        abi:          AERODROME_ROUTER_ABI,
        functionName: "getAmountsOut",
        args:         [amountBig, routes],
      }),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
    req.log.error({ err }, "failed to read balance/quote");
    return res.status(503).json({ error: `Failed to fetch data: ${msg}` });
  }

  if (balance < amountBig) {
    return res.status(400).json({ error: "Insufficient token balance" });
  }

  const quoteAmountOut = quoteAmounts[1] ?? 0n;
  if (quoteAmountOut === 0n) {
    return res.status(503).json({ error: "No liquidity for this pair at the requested amount" });
  }

  const slipBps      = BigInt(slippageBps ?? 50);
  const amountOutMin = (quoteAmountOut * (10_000n - slipBps)) / 10_000n;

  // ── TX 1: transferWithAuthorization(user → relay) ─────────────────────────
  // User's EIP-3009 signature moves tokens from their wallet to the relay wallet.
  // The relay wallet holds the tokens until TX2 swaps them via the router.
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
          relayer.account.address,
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
    return res.status(500).json({ error: `Transfer failed: ${msg}` });
  }

  // ── Ensure relay has approved Aerodrome Router ────────────────────────────
  // Check allowance; approve max uint256 once if insufficient (one-time per token).
  try {
    const allowance = await publicClient.readContract({
      address:      pair.tokenIn,
      abi:          ERC20_ABI,
      functionName: "allowance",
      args:         [relayer.account.address, AERODROME_ROUTER],
    });
    if (allowance < amountBig) {
      const approveHash = await writeWithRetry(
        () => relayer.client.writeContract({
          chain: base, account: relayer.account,
          address: pair.tokenIn, abi: ERC20_ABI,
          functionName: "approve",
          args: [AERODROME_ROUTER, (2n ** 256n) - 1n],
        }),
        "router approve",
      );
      await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
      req.log.info({ approveHash, tokenIn: pair.tokenIn }, "relay approved Aerodrome Router");
    }
  } catch (approveErr) {
    // Approval failed — relay holds tokenIn, refund user
    req.log.error({ err: approveErr, twaHash }, "router approval failed — refunding");
    try {
      const refundHash = await writeWithRetry(
        () => relayer.client.writeContract({
          chain: base, account: relayer.account,
          address: pair.tokenIn, abi: ERC20_ABI,
          functionName: "transfer",
          args: [owner as `0x${string}`, amountBig],
        }),
        "approval-failure refund",
      );
      req.log.info({ refundHash, twaHash }, "refunded user after approval failure");
      return res.status(500).json({ error: "Router approval failed — your tokens have been refunded.", refundHash });
    } catch (refundErr) {
      req.log.error({ refundErr, twaHash }, "approval failure refund also failed");
    }
    return res.status(500).json({ error: "Router approval failed — contact support.", twaHash });
  }

  // ── TX 2: router.swapExactTokensForTokens(relay → pool → user) ───────────
  // The router atomically: (a) pulls tokenIn from relay via transferFrom,
  // (b) deposits to pool, (c) triggers pool.swap, (d) delivers tokenOut to user.
  // Single on-chain transaction — no race condition between deposit and swap.
  //
  // Deadline is set 2 hours out (not 5 minutes) because the Replit/production
  // server clock can drift significantly from Base mainnet's block.timestamp.
  //
  // IMPORTANT: We skip eth_estimateGas (set explicit gas: 350_000n) because
  // viem's gas estimation simulates against the *pending* block state which may
  // not yet reflect TX1's token deposit. The estimation incorrectly sees zero
  // EURC/USDC at the relay and reverts. TX2 on-chain executes against the
  // canonical state (TX1 is already in a confirmed block) so it succeeds.
  //
  // We also pause 1.5s after TX1 confirmation to let the RPC's state index
  // catch up before the allowance read and TX2 submission.
  await new Promise(r => setTimeout(r, 1_500));

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 7_200);
  let swapHash: Hex;
  try {
    swapHash = await writeWithRetry(
      () => relayer.client.writeContract({
        chain:        base,
        account:      relayer.account,
        address:      AERODROME_ROUTER,
        abi:          AERODROME_ROUTER_ABI,
        functionName: "swapExactTokensForTokens",
        args:         [amountBig, amountOutMin, routes, owner as `0x${string}`, deadline],
        // Explicit gas limit bypasses eth_estimateGas to avoid RPC state-lag
        // false-reverts. 350k is well above the actual ~150-250k used by a
        // single-hop Aerodrome volatile swap.
        gas:          350_000n,
      }),
      "TX2 router.swapExactTokensForTokens",
    );
  } catch (submitErr) {
    // TX2 failed to submit — relay still holds tokenIn → refund user
    req.log.error({ err: submitErr, twaHash }, "swap TX2 submit failed — refunding user");
    try {
      const refundHash = await writeWithRetry(
        () => relayer.client.writeContract({
          chain: base, account: relayer.account,
          address: pair.tokenIn, abi: ERC20_ABI,
          functionName: "transfer",
          args: [owner as `0x${string}`, amountBig],
        }),
        "TX2-submit-failure refund",
      );
      req.log.info({ refundHash, twaHash }, "refunded user after TX2 submit failure");
      return res.status(500).json({ error: "Swap could not be submitted — your tokens have been refunded.", refundHash });
    } catch (refundErr) {
      req.log.error({ refundErr, twaHash }, "TX2 submit refund also failed");
    }
    return res.status(500).json({ error: "Swap failed — contact support with your transaction hash.", twaHash });
  }

  // TX2 submitted — return immediately; Base confirms in ~2s.
  // Background: if TX2 reverts (rare — slippage guard is server-side), tokens
  // remain at the relay wallet and must be manually refunded via the
  // scripts/src/refund-stuck.ts pattern.
  req.log.info(
    { swapHash, twaHash, amountIn, amountOutMin: amountOutMin.toString(), owner, stable },
    "gasless swap TX2 submitted via Aerodrome Router",
  );

  return res.json({
    txHash:            swapHash,
    tokenIn, tokenOut, amountIn,
    amountOutAfterFee: quoteAmountOut.toString(),
  });
});

export default router;
