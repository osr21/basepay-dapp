import { randomUUID } from "node:crypto";
import {
  createPublicClient, fallback, http, parseAbi, parseUnits, zeroAddress,
  encodeFunctionData, decodeEventLog, type Address, type Hash,
} from "viem";
import { base } from "viem/chains";
import { Attribution } from "ox/erc8021";
import { getStockflowCatalogue } from "./stockflow";
import { readActualTransactionFee, serializeFee } from "@workspace/base-fees";

// Current Aerodrome Gauges V3 deployment. Source and ABI:
// https://github.com/aerodrome-finance/slipstream (README, ISwapRouter, IQuoterV2).
// Older factory/router generations do not route the current stock pools.
export const PILOT_ROUTER = "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F" as const;
export const PILOT_FACTORY = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef" as const;
export const PILOT_QUOTER = "0x514c8B5f54112481E28028F1166Bd78501089259" as const;
export const PILOT_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const pilotChain = createPublicClient({
  chain: base, transport: fallback([
    http("https://mainnet.base.org", { timeout: 12_000, retryCount: 1 }),
    http("https://base-rpc.publicnode.com", { timeout: 12_000, retryCount: 1 }),
  ]),
});
export const pilotErc20Abi = parseAbi([
  "function balanceOf(address) view returns(uint256)",
  "function allowance(address,address) view returns(uint256)",
  "function decimals() view returns(uint8)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);
const factoryAbi = parseAbi([
  "function factory() view returns(address)",
  "function getPool(address,address,int24) view returns(address)",
]);
const poolAbi = parseAbi([
  "function liquidity() view returns(uint128)",
  "function slot0() view returns(uint160,int24,uint16,uint16,uint16,bool)",
]);
const quoterAbi = [{
  type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" }, { name: "tickSpacing", type: "int24" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
  ] }], outputs: [
    { name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
    { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" },
  ],
}] as const;
export const pilotSwapAbi = [{
  type: "function", name: "exactInputSingle", stateMutability: "payable",
  inputs: [{ name: "params", type: "tuple", components: [
    { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
    { name: "tickSpacing", type: "int24" }, { name: "recipient", type: "address" },
    { name: "deadline", type: "uint256" }, { name: "amountIn", type: "uint256" },
    { name: "amountOutMinimum", type: "uint256" }, { name: "sqrtPriceLimitX96", type: "uint160" },
  ] }], outputs: [{ name: "amountOut", type: "uint256" }],
}] as const;
export type PilotQuote = Awaited<ReturnType<typeof quotePilotTrade>>;
let venueVerifiedUntil = 0;
async function verifyVenue() {
  if (Date.now() < venueVerifiedUntil) return;
  const [chain, routerFactory, quoterFactory] = await Promise.all([
    pilotChain.getChainId(),
    pilotChain.readContract({ address: PILOT_ROUTER, abi: factoryAbi, functionName: "factory" }),
    pilotChain.readContract({ address: PILOT_QUOTER, abi: factoryAbi, functionName: "factory" }),
  ]);
  if (chain !== base.id || routerFactory.toLowerCase() !== PILOT_FACTORY.toLowerCase() ||
      quoterFactory.toLowerCase() !== PILOT_FACTORY.toLowerCase()) throw new Error("Approved venue verification failed.");
  venueVerifiedUntil = Date.now() + 60_000;
}
export function parsePilotAmount(amount: string, decimals: number) {
  if (amount.length > 90 || !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(amount) ||
      (amount.split(".")[1]?.length ?? 0) > decimals) throw new Error("Enter a positive amount within the token's decimal precision.");
  const raw = parseUnits(amount, decimals);
  if (raw <= 0n || raw >= 2n ** 256n) throw new Error("Amount is outside the supported range.");
  return raw;
}
export function priceImpactBps(amount: bigint, out: bigint, sqrt: bigint, tokenIn: string, tokenOut: string) {
  if (sqrt <= 0n || amount <= 0n) throw new Error("Pool price unavailable.");
  const squared = sqrt * sqrt, scale = 2n ** 192n;
  const spot = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? amount * squared / scale : amount * scale / squared;
  if (spot <= 0n) throw new Error("Amount is too small to quote reliably.");
  return Number(out >= spot ? 0n : ((spot - out) * 10_000n + spot - 1n) / spot);
}
export async function quotePilotTrade(wallet: Address, input: {
  stockAddress: string; side: "buy" | "sell"; amount: string; slippageBps: number;
}) {
  const code = await pilotChain.getCode({ address: wallet });
  if (code && code !== "0x" && !(code.startsWith("0xef0100") && code.length === 48)) {
    throw new Error("This pilot supports EOA and EIP-7702 wallets for trading, not contract-wallet transactions. Contract wallets may still sign in for administration.");
  }
  const { stocks } = await getStockflowCatalogue();
  const stock = stocks.find(s => s.address.toLowerCase() === input.stockAddress.toLowerCase());
  if (!stock) throw new Error("Only stocks in the official Coinbase catalogue are supported.");
  if (stock.pausedFeatures.length) throw new Error("This asset reports paused features; trading is blocked.");
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 10 || input.slippageBps > 100) throw new Error("Slippage must be 0.1%–1%.");
  await verifyVenue();
  const stockAddress = stock.address as Address;
  const decimals = await pilotChain.readContract({ address: stockAddress, abi: pilotErc20Abi, functionName: "decimals" });
  if (decimals !== stock.decimals) throw new Error("Stock decimal metadata does not match the chain.");
  const buy = input.side === "buy";
  const tokenIn = buy ? PILOT_USDC : stockAddress, tokenOut = buy ? stockAddress : PILOT_USDC;
  const decimalsIn = buy ? 6 : decimals, decimalsOut = buy ? decimals : 6;
  const amountIn = parsePilotAmount(input.amount, decimalsIn);
  if (buy && amountIn > 100_000000n) throw new Error("The pilot quotes at most 100 USDC per trade.");
  const blockNumber = await pilotChain.getBlockNumber({ cacheTime: 0 });
  const spacings = [1, 10, 50, 100, 200, 2000];
  const poolResults = await pilotChain.multicall({
    blockNumber, contracts: spacings.map(tick => ({
      address: PILOT_FACTORY, abi: factoryAbi, functionName: "getPool" as const, args: [tokenIn, tokenOut, tick] as const,
    })),
  });
  if (poolResults.every(r => r.status === "failure")) throw new Error("Pool discovery RPC unavailable.");
  const candidates = await Promise.all(poolResults.map(async (r, i) => {
    if (r.status !== "success" || r.result === zeroAddress) return null;
    const pool = r.result;
    try {
      const [liquidity, slot, quote] = await Promise.all([
        pilotChain.readContract({ address: pool, abi: poolAbi, functionName: "liquidity", blockNumber }),
        pilotChain.readContract({ address: pool, abi: poolAbi, functionName: "slot0", blockNumber }),
        pilotChain.simulateContract({
          address: PILOT_QUOTER, abi: quoterAbi, functionName: "quoteExactInputSingle", blockNumber,
          args: [{ tokenIn, tokenOut, amountIn, tickSpacing: spacings[i]!, sqrtPriceLimitX96: 0n }],
        }),
      ]);
      if (liquidity === 0n || quote.result[0] === 0n) return null;
      const impact = priceImpactBps(amountIn, quote.result[0], slot[0], tokenIn, tokenOut);
      if (impact > 500) return null; // Fee-inclusive pool-spot impact, not a promise of fair NAV.
      return { pool, tickSpacing: spacings[i]!, amountOut: quote.result[0], impact };
    } catch { return null; } // Other verified pools may still quote; never fabricate output.
  }));
  const best = candidates.filter(x => x !== null).sort((a, b) => a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : 0)[0];
  if (!best) throw new Error("No executable direct USDC pool within the 5% impact limit. Liquidity or RPC data may be unavailable.");
  if (!buy && best.amountOut > 100_000000n) throw new Error("The pilot quotes sales worth at most 100 USDC per trade.");
  const minimumOut = best.amountOut * BigInt(10_000 - input.slippageBps) / 10_000n;
  if (minimumOut === 0n) throw new Error("Trade is too small.");
  const now = Date.now();
  return {
    id: randomUUID(), chainId: base.id, wallet: wallet.toLowerCase(), stockAddress,
    symbol: stock.symbol, side: input.side, router: PILOT_ROUTER, factory: PILOT_FACTORY,
    pool: best.pool, tickSpacing: best.tickSpacing, tokenIn, tokenOut, decimalsIn, decimalsOut,
    amountIn: amountIn.toString(), amountOut: best.amountOut.toString(), minimumOut: minimumOut.toString(),
    slippageBps: input.slippageBps, priceImpactBps: best.impact,
    expiresAt: new Date(now + 45_000).toISOString(), deadline: Math.floor(now / 1000) + 60,
    blockNumber: blockNumber.toString(),
  };
}
export function pilotSwapParams(q: PilotQuote) {
  return {
    tokenIn: q.tokenIn as Address, tokenOut: q.tokenOut as Address, tickSpacing: q.tickSpacing,
    recipient: q.wallet as Address, deadline: BigInt(q.deadline), amountIn: BigInt(q.amountIn),
    amountOutMinimum: BigInt(q.minimumOut), sqrtPriceLimitX96: 0n,
  };
}
export function pilotSwapData(q: PilotQuote) {
  return encodeFunctionData({ abi: pilotSwapAbi, functionName: "exactInputSingle", args: [pilotSwapParams(q)] });
}
export function pilotCalldataMatches(data: `0x${string}`, q: PilotQuote) {
  const expected = pilotSwapData(q).toLowerCase();
  const actual = data.toLowerCase();
  if (actual === expected) return true;
  if (!actual.startsWith(expected)) return false;
  // ERC-8021 metadata is appended by the existing wallet connector. Accept a
  // canonical suffix only; every economic argument must still match exactly.
  const tail = `0x${actual.slice(expected.length)}` as const;
  return canonicalAttribution(tail);
}
function canonicalAttribution(tail: `0x${string}`) {
  try {
    const attribution = Attribution.fromData(tail);
    return !!attribution && Attribution.toDataSuffix(attribution).toLowerCase() === tail;
  } catch { return false; }
}
export async function inspectPilotReceipt(hash: Hash, q: PilotQuote) {
  const tx = await pilotChain.getTransaction({ hash });
  if (!pilotTransactionMatches(tx, q)) {
    throw new Error("Transaction does not match this wallet's quoted swap.");
  }
  let receipt;
  try { receipt = await pilotChain.getTransactionReceipt({ hash }); }
  catch (err) {
    if (err instanceof Error && err.name === "TransactionReceiptNotFoundError") return { status: "pending" as const, amountOut: null, networkFees: null };
    throw err;
  }
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error("Receipt hash mismatch.");
  const [safe, actualFee] = await Promise.all([
    pilotChain.getBlock({ blockTag: "safe" }),
    readActualTransactionFee(pilotChain, hash, receipt.blockHash),
  ]);
  const canonical = await pilotChain.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash !== receipt.blockHash) throw new Error("Receipt is not on the canonical chain. Retry reconciliation.");
  const networkFees = serializeFee(actualFee);
  if (receipt.status === "reverted") return { status: safe.number < receipt.blockNumber ? "pending" as const : "failed" as const, amountOut: null, networkFees };
  let amountOut = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== q.tokenOut.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: pilotErc20Abi, eventName: "Transfer", topics: log.topics, data: log.data });
      if (event.args.to.toLowerCase() === q.wallet.toLowerCase()) amountOut += event.args.value;
    } catch { /* Other token events aren't transfer receipts. */ }
  }
  if (amountOut < BigInt(q.minimumOut)) throw new Error("Receipt output could not be verified; do not report trade as confirmed.");
  // Avoid calling a one-block inclusion final before Base's safe chain advances.
  if (safe.number < receipt.blockNumber) return { status: "pending" as const, amountOut: amountOut.toString(), networkFees };
  return { status: "confirmed" as const, amountOut: amountOut.toString(), networkFees };
}

export function pilotTransactionMatches(tx: { from: string; to: string | null; value: bigint; input: `0x${string}` }, q: PilotQuote) {
  return tx.from.toLowerCase() === q.wallet.toLowerCase() &&
    tx.to?.toLowerCase() === PILOT_ROUTER.toLowerCase() && tx.value === 0n &&
    pilotCalldataMatches(tx.input, q);
}

// Server-owned evidence kept with the stored quote, not supplied by the browser.
// Persist this before waiting for a receipt: RPCs may forget the original after
// its nonce is consumed. Hashes received from the wallet are discovery hints only.
export type PilotTracking = {
  originalHash: Hash;
  nonce: number;
  scanBlock: string;
  hashes: Hash[];
};
const sameHash = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const notFound = (e: unknown) => e instanceof Error &&
  ["TransactionNotFoundError", "TransactionReceiptNotFoundError"].includes(e.name);

export async function reconcilePilotTrade(q: PilotQuote, hash: Hash, hints: Hash[] = [], prior?: PilotTracking) {
  let tracking: PilotTracking;
  if (prior) {
    if (![prior.originalHash, ...prior.hashes].some(h => sameHash(h, hash))) {
      throw new Error("This quote already tracks another submitted transaction. Nothing was resent.");
    }
    tracking = { ...prior, hashes: [...prior.hashes] };
  } else {
    const original = await pilotChain.getTransaction({ hash });
    if (!sameHash(original.hash, hash) || !pilotTransactionMatches(original, q)) {
      throw new Error("Original transaction does not match this wallet's quoted swap.");
    }
    const block = original.blockNumber ?? await pilotChain.getBlockNumber({ cacheTime: 0 });
    tracking = { originalHash: hash, nonce: original.nonce, scanBlock: (block > 120n ? block - 120n : 0n).toString(), hashes: [] };
  }
  const candidates = [...new Set([tracking.originalHash, ...tracking.hashes, ...hints].map(h => h.toLowerCase()))] as Hash[];
  let mined: Awaited<ReturnType<typeof pilotChain.getTransaction>> | undefined;
  for (const candidate of candidates) {
    let tx;
    try { tx = await pilotChain.getTransaction({ hash: candidate }); }
    catch (e) { if (notFound(e)) continue; throw e; }
    if (!sameHash(tx.hash, candidate) || tx.from.toLowerCase() !== q.wallet.toLowerCase() || tx.nonce !== tracking.nonce) {
      throw new Error("Replacement sender or nonce does not match the original transaction.");
    }
    if (!sameHash(candidate, tracking.originalHash) && !tracking.hashes.some(h => sameHash(h, candidate))) tracking.hashes.push(candidate);
    if (tx.blockNumber !== null) mined = tx;
  }
  // A reload may occur before the wallet reports a replacement. Discover the
  // consumed nonce in bounded, resumable pages rather than scanning all history.
  if (!mined && await pilotChain.getTransactionCount({ address: q.wallet as Address, blockTag: "latest" }) > tracking.nonce) {
    const latest = await pilotChain.getBlockNumber({ cacheTime: 0 });
    const start = BigInt(tracking.scanBlock);
    const end = start + 119n < latest ? start + 119n : latest;
    const safe = await pilotChain.getBlock({ blockTag: "safe" });
    for (let number = start; number <= end && !mined; number += 10n) {
      const numbers = Array.from({ length: Number(end - number + 1n > 10n ? 10n : end - number + 1n) }, (_, i) => number + BigInt(i));
      const blocks = await Promise.all(numbers.map(blockNumber => pilotChain.getBlock({ blockNumber, includeTransactions: true })));
      for (const block of blocks) {
        const tx = block.transactions.find(t => typeof t !== "string" && t.from.toLowerCase() === q.wallet.toLowerCase() && t.nonce === tracking.nonce);
        // Only advance past safe blocks, so a reorg cannot hide a replacement.
        if (block.number <= safe.number) tracking.scanBlock = (block.number + 1n).toString();
        if (tx && typeof tx !== "string") { mined = tx; break; }
      }
    }
  }
  if (!mined) return { hash: tracking.originalHash, status: "pending" as const, amountOut: null, networkFees: null, tracking };
  if (!sameHash(mined.hash, tracking.originalHash) && !tracking.hashes.some(h => sameHash(h, mined!.hash))) tracking.hashes.push(mined.hash);
  if (pilotTransactionMatches(mined, q)) {
    return { hash: mined.hash, ...await inspectPilotReceipt(mined.hash, q), tracking };
  }
  // Same sender/nonce, but different economics or a wallet self-send: never a
  // successful stock trade, even when that transaction's receipt says success.
  const receipt = await pilotChain.getTransactionReceipt({ hash: mined.hash });
  if (!sameHash(receipt.transactionHash, mined.hash)) throw new Error("Replacement receipt hash mismatch.");
  const [safe, canonical, actualFee] = await Promise.all([
    pilotChain.getBlock({ blockTag: "safe" }),
    pilotChain.getBlock({ blockNumber: receipt.blockNumber }),
    readActualTransactionFee(pilotChain, mined.hash, receipt.blockHash),
  ]);
  if (canonical.hash !== receipt.blockHash) throw new Error("Replacement receipt is not on the canonical chain.");
  const cancelled = mined.to?.toLowerCase() === q.wallet.toLowerCase() && mined.value === 0n &&
    (mined.input === "0x" || canonicalAttribution(mined.input));
  return {
    hash: mined.hash, tracking, amountOut: null, networkFees: serializeFee(actualFee),
    status: safe.number < receipt.blockNumber ? "pending" as const : cancelled ? "cancelled" as const : "changed" as const,
  };
}
