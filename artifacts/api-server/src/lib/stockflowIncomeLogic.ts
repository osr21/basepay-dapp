import { decodeEventLog, parseAbiItem, type Hex } from "viem";
import { GetStockflowIncomeResponse } from "@workspace/api-zod";
import type { z } from "zod";

export type StockflowIncome = z.infer<typeof GetStockflowIncomeResponse>;
export type StockflowIncomePolicy = NonNullable<StockflowIncome["policy"]>;
export type StockflowIncomeReceipt = StockflowIncome["receipts"][number];

export const CONFIRMATIONS = 12;
export const TOKENS = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": "EURC",
} as const;
export const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
export type ChainLog = {
  address: string; topics: readonly Hex[]; data: Hex; logIndex: number;
};
export type ChainReceipt = {
  status: string; transactionHash: Hex; blockNumber: bigint; blockHash: Hex; logs: readonly ChainLog[];
};
export function emptyIncome(wallet: string): StockflowIncome {
  return { wallet: wallet.toLowerCase(), chainId: 8453, requiredConfirmations: CONFIRMATIONS,
    policy: null, receipts: [], proposals: [], scanStartBlock: null, scannedThroughBlock: null, scannedBlockHash: null, headBlock: null, syncedAt: null };
}

// Monetary planning uses cents and basis points, never a floating point receipt
// amount. Both supported token contracts use 6 decimals.
const cents = (v: number) => BigInt(Math.round(v * 100));
const min = (a: bigint, b: bigint) => a < b ? a : b;
export const dollars = (v: bigint) => `${v / 100n}.${String(v % 100n).padStart(2, "0")}`;
const fromDollars = (v: string) => BigInt(v.replace(".", ""));

export function policyError(p: StockflowIncomePolicy, now: number): string | null {
  if (p.status !== "active" || p.expiresAt <= now) return "The income policy is revoked or expired.";
  if (!p.name.trim() || p.maxPerPurchase > p.dailyMax) return "Invalid policy name or purchase/daily limit.";
  if (![p.incomePct, ...p.allocations.map(a => a.weight)].every(v => Number.isFinite(v) && v > 0 && v <= 100 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6))
    return "Percentages must be positive, at most 100 and have at most two decimal places.";
  if (![p.maxPerPurchase, p.dailyMax].every(v => Number.isFinite(v) && v >= 0.01 && v <= 1e9 && Math.abs(v * 100 - Math.round(v * 100)) < 1e-5))
    return "Limits must be positive USD amounts with at most two decimal places.";
  if (p.allocations.length === 0 || p.allocations.length > 50
    || p.allocations.reduce((sum, a) => sum + Math.round(a.weight * 100), 0) !== 10000
    || new Set(p.allocations.map(a => a.address.toLowerCase())).size !== p.allocations.length) return "Unique asset weights must total 100%.";
  return null;
}

export function extractIncome(wallet: string, tx: ChainReceipt, canonicalHash: string, timestamp: bigint, head: bigint): StockflowIncomeReceipt[] {
  if (tx.status !== "success" || tx.blockHash.toLowerCase() !== canonicalHash.toLowerCase() || tx.blockNumber > head) return [];
  const confirmations = Number(head - tx.blockNumber + 1n);
  const result: StockflowIncomeReceipt[] = [];
  for (const [receiptIndex, log] of tx.logs.entries()) {
    const tokenAddress = log.address.toLowerCase();
    const token = TOKENS[tokenAddress as keyof typeof TOKENS];
    if (!token) continue;
    try {
      const { args } = decodeEventLog({ abi: [TRANSFER], topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
      if (args.to.toLowerCase() !== wallet.toLowerCase() || args.from.toLowerCase() === wallet.toLowerCase() || args.value <= 0n) continue;
      const txHash = tx.transactionHash.toLowerCase();
      result.push({
        id: `8453:${wallet.toLowerCase()}:${txHash}:${receiptIndex}:${tokenAddress}`,
        txHash, logIndex: log.logIndex, receiptIndex, token, tokenAddress, amountAtomic: args.value.toString(),
        sender: args.from.toLowerCase(), blockNumber: tx.blockNumber.toString(), blockHash: tx.blockHash.toLowerCase(),
        receivedAt: new Date(Number(timestamp) * 1000).toISOString(), confirmations,
        status: confirmations >= CONFIRMATIONS ? "confirmed" : "confirming", paymentRequestIds: [],
      });
    } catch { /* Not a strictly decoded supported-token Transfer. */ }
  }
  return result;
}

/** Reconcile the entire previously known set, including receipts outside the
 * current discovery window. Missing canonical events invalidate old proposals. */
export function reconcileIncome(state: StockflowIncome, verified: StockflowIncomeReceipt[], now: number): StockflowIncome {
  const next = structuredClone(state);
  const found = new Map(verified.map(r => [r.id, r]));
  const changed = new Set<string>();
  next.receipts = next.receipts.map(old => {
    const fresh = found.get(old.id);
    found.delete(old.id);
    if (!fresh || fresh.blockHash !== old.blockHash || fresh.amountAtomic !== old.amountAtomic || fresh.status !== "confirmed") changed.add(old.id);
    return fresh ?? { ...old, confirmations: 0, status: "orphaned" as const };
  });
  next.receipts.push(...found.values());
  for (const p of next.proposals) {
    if (changed.has(p.receiptId)) {
      p.status = "invalidated"; p.reason = "Receipt is no longer confirmed at its original canonical block. Review is invalid.";
      p.reviewedAt = null;
    }
  }
  const policy = next.policy;
  if (!policy || policyError(policy, now)) {
    for (const p of next.proposals) if (p.status === "pending_review") {
      p.status = "invalidated"; p.reason = "Income policy is paused, revoked or expired.";
    }
    return next;
  }
  const date = new Date(now).toISOString();
  // A wallet-wide daily planning budget across all policy versions. Dismissal,
  // policy edits and reorgs do not free it: never recycle a proposal's budget.
  let used = next.proposals.filter(p => p.createdAt.slice(0, 10) === date.slice(0, 10))
    .reduce((sum, p) => sum + fromDollars(p.totalUsd), 0n);
  for (const receipt of [...next.receipts].sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || a.logIndex - b.logIndex)) {
    if (receipt.status !== "confirmed") continue;
    // One proposal per event, even after policy edits. Reorg invalidation is
    // terminal; a resurrected/replayed transaction never silently re-approves.
    if (next.proposals.some(p => p.receiptId === receipt.id)) continue;
    const remaining = cents(policy.dailyMax) > used ? cents(policy.dailyMax) - used : 0n;
    const budget = receipt.token === "USDC" ? min(BigInt(receipt.amountAtomic) * BigInt(Math.round(policy.incomePct * 100)) / 10000n / 10000n, remaining) : 0n;
    const lines = policy.allocations.map(a => ({
      address: a.address, symbol: a.symbol,
      amountUsd: dollars(min(budget * BigInt(Math.round(a.weight * 100)) / 10000n, cents(policy.maxPerPurchase))),
    }));
    const total = lines.reduce((sum, l) => sum + fromDollars(l.amountUsd), 0n);
    const reason = receipt.token === "EURC" ? "EURC requires a verified EUR/USD conversion rate. No USD allocation was assumed."
      : total === 0n ? "Daily proposal budget is exhausted or the allocation is below one cent." : null;
    next.proposals.push({
      id: receipt.id, receiptId: receipt.id, policy: structuredClone(policy), lines, totalUsd: dollars(total),
      status: reason ? "blocked" : "pending_review", reason, createdAt: date, reviewedAt: null,
    });
    used += total;
  }
  return next;
}
