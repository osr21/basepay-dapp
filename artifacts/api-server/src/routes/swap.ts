import { Router } from "express";
import { logger } from "../lib/logger";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  concat,
  isAddress,
  isHex,
  type Hex,
  maxUint256,
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

// ── Retry helper for EIP-7702 "in-flight transaction limit" ─────────────────
// Base RPC enforces max 1 pending tx at a time for EIP-7702 delegated accounts.
// Even after waitForTransactionReceipt confirms a tx there is a brief window
// where the sequencer still considers it in-flight. Retry with linear backoff.
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
        const delayMs = 1_500 * (attempt + 1); // 1.5 s, 3 s, 4.5 s …
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
// Checksummed addresses for viem; also store lowercase for comparison.
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

// ── Protocol fee (0.30% on output) ────────────────────────────────────────────
const SWAP_FEE_BPS = 30n;

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ERC20_ABI = parseAbi([
  "function balanceOf(address) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) external returns (bool)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external",
]);

// Aerodrome route struct: { from, to, stable, factory }
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
      { name: "amountIn",     type: "uint256"   },
      { name: "amountOutMin", type: "uint256"   },
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

// ── Pool auto-discovery: tries stable + volatile, returns better quote ─────────
type AeroQuote = { amountOut: bigint; stable: boolean };
async function getBestAerodromeQuote(
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
      if (!best || amountOut > best.amountOut) {
        best = { amountOut, stable };
      }
    } catch (err) {
      logger.debug({ stable, err: err instanceof Error ? err.message : String(err) }, "Aerodrome pool quote failed");
    }
  }
  return best;
}

// ── Startup: ensure relayer has max approval on both tokens for Aerodrome ──────
// Called once when the module loads (if DEPLOYER_PRIVATE_KEY is set).
let _approvalsEnsured = false;
async function ensureRelayerApprovals(): Promise<void> {
  if (_approvalsEnsured) return;
  let relayer: Relayer;
  try { relayer = getRelayer(); } catch { return; } // key not set — skip

  const TOKENS = [USDC, EURC] as const;
  for (const token of TOKENS) {
    try {
      const allowance = await publicClient.readContract({
        address:      token,
        abi:          ERC20_ABI,
        functionName: "allowance",
        args:         [relayer.account.address, AERODROME_ROUTER],
      });
      if (allowance < maxUint256 / 2n) {
        logger.info({ token }, "Approving Aerodrome router for relayer (one-time setup)");
        const hash = await relayer.client.writeContract({
          chain:        base,
          account:      relayer.account,
          address:      token,
          abi:          ERC20_ABI,
          functionName: "approve",
          args:         [AERODROME_ROUTER, maxUint256],
        });
        await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
        logger.info({ token, hash }, "Aerodrome router approved for relayer");
      }
    } catch (err) {
      logger.warn({ token, err }, "Could not ensure Aerodrome approval — swap execute may fail");
    }
  }
  _approvalsEnsured = true;
}

// Fire approvals in background on module load
ensureRelayerApprovals().catch(() => {});

// ── Rate limit constants ───────────────────────────────────────────────────────
const MAX_AMOUNT   = 10_000_000_000n; // 10,000 tokens (6 dec)
const MAX_SLIP_BPS = 100n;            // 1% slippage guard on quote

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

  const best = await getBestAerodromeQuote(pair.tokenIn, pair.tokenOut, amountBig);
  if (!best) {
    req.log.warn({ tokenIn: pair.tokenIn, tokenOut: pair.tokenOut, amountIn }, "no Aerodrome pool found");
    return res.status(503).json({ error: "No liquid pool found for this pair — try a smaller amount" });
  }

  const { amountOut, stable } = best;
  const amountOutMin      = (amountOut * (10_000n - MAX_SLIP_BPS)) / 10_000n;
  const protocolFeeAmount = (amountOut * SWAP_FEE_BPS) / 10_000n;
  const amountOutAfterFee = amountOut - protocolFeeAmount;

  // Expose relayer address so the frontend can use it as the permit spender
  let relayerAddress: string | undefined;
  try { relayerAddress = getRelayer().account.address; } catch { /* key not set */ }

  req.log.info({ stable, amountOut: amountOut.toString() }, "Aerodrome swap quote");

  return res.json({
    amountOut:         amountOut.toString(),
    amountOutMin:      amountOutMin.toString(),
    fee:               stable ? 100 : 500, // Aerodrome pool type indicator
    protocolFeeBps:    Number(SWAP_FEE_BPS),
    protocolFeeAmount: protocolFeeAmount.toString(),
    amountOutAfterFee: amountOutAfterFee.toString(),
    relayerAddress,
    stable,
  });
});

// ── POST /api/swap/execute ────────────────────────────────────────────────────
// Gasless swap via Aerodrome — 4 relayer transactions:
//   TX1: token.permit(user, relayer, amountIn)  — submit the off-chain permit
//   TX2: token.transferFrom(user, relayer, amountIn) — pull tokens to relayer
//   TX3: aerodromeRouter.swapExactTokensForTokens(...)  — swap, output to relayer
//   TX4: outputToken.transfer(user, amountOutAfterFee)  — send to user
// Permit spender must equal relayer address (returned by /quote as relayerAddress).
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

  const amountBig   = BigInt(amountIn);
  const deadlineBig = BigInt(deadline);

  if (amountBig <= 0n || amountBig > MAX_AMOUNT) {
    return res.status(400).json({ error: "amountIn out of range" });
  }
  if (deadlineBig < BigInt(Math.floor(Date.now() / 1000))) {
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

  // Fresh quote to compute amountOutMin
  const freshQuote = await getBestAerodromeQuote(pair.tokenIn, pair.tokenOut, amountBig);
  if (!freshQuote) {
    return res.status(503).json({ error: "Could not get swap quote — no liquid pool found" });
  }
  const slipBps      = BigInt(slippageBps ?? 50);
  const amountOutMin = (freshQuote.amountOut * (10_000n - slipBps)) / 10_000n;
  const poolStable   = freshQuote.stable;

  let relayer: Relayer;
  try { relayer = getRelayer(); } catch {
    return res.status(500).json({ error: "Relayer not configured" });
  }

  // ── TX 1: submit the EIP-2612 permit (sets allowance for relayer to pull tokens) ──
  let permitHash: Hex;
  try {
    permitHash = await writeWithRetry(
      () => relayer.client.writeContract({
        chain:        base,
        account:      relayer.account,
        address:      pair.tokenIn,
        abi:          ERC20_ABI,
        functionName: "permit",
        args:         [
          owner as `0x${string}`,
          relayer.account.address,
          amountBig,
          deadlineBig,
          permitV,
          permitR as `0x${string}`,
          permitS as `0x${string}`,
        ],
      }),
      "TX1 permit",
    );
    const permitReceipt = await publicClient.waitForTransactionReceipt({ hash: permitHash, confirmations: 1 });
    // A reverted permit TX still produces a receipt — check status explicitly.
    if (permitReceipt.status !== "success") {
      req.log.error({ permitHash, status: permitReceipt.status }, "swap TX1 (permit) reverted on-chain");
      return res.status(400).json({
        error:
          "Permit was rejected by the token contract. Smart wallets that use passkey (WebAuthn) " +
          "signing are not compatible with EIP-2612 — please connect with a seed-phrase (EOA) wallet.",
        permitHash,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 150) : "Permit failed";
    req.log.error({ err }, "swap TX1 (permit) failed");
    return res.status(500).json({ error: `Permit failed: ${msg}` });
  }

  // Belt-and-suspenders: verify the allowance was actually set before pulling.
  const allowanceAfterPermit = await publicClient.readContract({
    address:      pair.tokenIn,
    abi:          ERC20_ABI,
    functionName: "allowance",
    args:         [owner as `0x${string}`, relayer.account.address],
  });
  if (allowanceAfterPermit < amountBig) {
    req.log.error(
      { allowanceAfterPermit: allowanceAfterPermit.toString(), amountIn, permitHash },
      "permit mined but allowance not set — smart wallet incompatibility suspected",
    );
    return res.status(400).json({
      error:
        "Permit was accepted on-chain but did not grant the expected allowance. " +
        "Smart wallets with passkey signing are not compatible with EIP-2612 — " +
        "please connect with a seed-phrase (EOA) wallet.",
      permitHash,
    });
  }

  // ── TX 2: pull tokens from user to relayer ────────────────────────────────
  let pullHash: Hex;
  try {
    pullHash = await writeWithRetry(
      () => relayer.client.writeContract({
        chain:        base,
        account:      relayer.account,
        address:      pair.tokenIn,
        abi:          ERC20_ABI,
        functionName: "transferFrom",
        args:         [owner as `0x${string}`, relayer.account.address, amountBig],
      }),
      "TX2 transferFrom",
    );
    const pullReceipt = await publicClient.waitForTransactionReceipt({ hash: pullHash, confirmations: 1 });
    if (pullReceipt.status !== "success") {
      req.log.error({ pullHash, permitHash, status: pullReceipt.status }, "swap TX2 (transferFrom) reverted");
      return res.status(500).json({ error: "Token pull reverted on-chain after permit succeeded. Contact support.", permitHash, pullHash });
    }
  } catch (err) {
    req.log.error({ err, permitHash }, "swap TX2 (transferFrom) failed");
    return res.status(500).json({ error: "Token pull failed after permit succeeded. Contact support.", permitHash });
  }

  // ── TX 3 (conditional): ensure relayer has approved Aerodrome router ─────────
  const currentAllowance = await publicClient.readContract({
    address:      pair.tokenIn,
    abi:          ERC20_ABI,
    functionName: "allowance",
    args:         [relayer.account.address, AERODROME_ROUTER],
  });
  if (currentAllowance < amountBig) {
    try {
      req.log.info({ token: pair.tokenIn }, "Approving Aerodrome router inline");
      const approveHash = await writeWithRetry(
        () => relayer.client.writeContract({
          chain:        base,
          account:      relayer.account,
          address:      pair.tokenIn,
          abi:          ERC20_ABI,
          functionName: "approve",
          args:         [AERODROME_ROUTER, maxUint256],
        }),
        "TX3 approve",
      );
      await publicClient.waitForTransactionReceipt({ hash: approveHash, confirmations: 1 });
    } catch (err) {
      req.log.error({ err }, "Inline approve failed");
      return res.status(500).json({ error: "Could not approve Aerodrome router — swap aborted" });
    }
  }

  // ── TX 4: swap via Aerodrome ──────────────────────────────────────────────
  const routes = [{ from: pair.tokenIn, to: pair.tokenOut, stable: poolStable, factory: AERODROME_FACTORY }];
  let swapHash: Hex;
  try {
    swapHash = await writeWithRetry(
      () => relayer.client.writeContract({
        chain:        base,
        account:      relayer.account,
        address:      AERODROME_ROUTER,
        abi:          AERODROME_ROUTER_ABI,
        functionName: "swapExactTokensForTokens" as const,
        args:         [amountBig, amountOutMin, routes, relayer.account.address, deadlineBig] as const,
      }),
      "TX4 swap",
    );
    await publicClient.waitForTransactionReceipt({ hash: swapHash, confirmations: 1 });
  } catch (err) {
    const raw   = err instanceof Error ? err.message : "Swap failed";
    const match = raw.match(/reverted with the following reason:\s*\n(.+)/m) ?? raw.match(/Error: (.+?)(?:\n|$)/);
    const msg   = (match ? match[1].trim() : raw).slice(0, 150);
    req.log.error({ err, permitHash, pullHash }, "swap Aerodrome swap tx failed");
    return res.status(500).json({ error: msg, permitHash, pullHash });
  }

  // ── Final TX: send (amountOutMin − protocol fee) to user ─────────────────
  // Using amountOutMin (worst-case) ensures the relayer always holds enough.
  const userAmount = (amountOutMin * (10_000n - SWAP_FEE_BPS)) / 10_000n;
  let transferHash: Hex;
  try {
    transferHash = await writeWithRetry(
      () => relayer.client.writeContract({
        chain:        base,
        account:      relayer.account,
        address:      pair.tokenOut,
        abi:          ERC20_ABI,
        functionName: "transfer",
        args:         [owner as `0x${string}`, userAmount],
      }),
      "TX5 transfer to user",
    );
  } catch (err) {
    req.log.error({ err, swapHash, owner, tokenOut: pair.tokenOut, userAmount: userAmount.toString() },
      "swap TX5 (user transfer) failed — manual recovery needed");
    return res.status(500).json({ error: "Swap succeeded but output transfer failed. Contact support.", swapHash });
  }

  req.log.info(
    { permitHash, pullHash, swapHash, transferHash, owner, tokenIn: pair.tokenIn, tokenOut: pair.tokenOut, amountIn, userAmount: userAmount.toString() },
    "gasless swap completed",
  );

  return res.json({
    txHash:           swapHash,
    transferHash,
    tokenIn:          pair.tokenIn,
    tokenOut:         pair.tokenOut,
    amountIn,
    amountOutMin:     amountOutMin.toString(),
    amountOutAfterFee: userAmount.toString(),
  });
});

export default router;
