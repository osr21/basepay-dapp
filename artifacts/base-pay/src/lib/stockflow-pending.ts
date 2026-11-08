// Browser journal for submitted mainnet swaps. Written the moment a hash exists so a
// reload, crash or failed history call never loses track of a real transaction.
import type { StoredTransactionFee } from "@workspace/base-fees";
export type PendingTrade = {
  wallet: string;
  quoteId: string;
  hash: `0x${string}`;
  symbol: string;
  side: "buy" | "sell";
  at: number;
  receipt: "unknown" | "success" | "reverted";
  recordError: string | null;
  reviewedSwapFee?: StoredTransactionFee | null;
  /** Hash of a wallet replacement/cancellation observed instead of the original swap. */
  replacedBy?: `0x${string}` | null;
  replacementHashes?: `0x${string}`[];
  status?: "pending" | "confirmed" | "failed" | "cancelled" | "changed";
};

const key = (wallet: string) => `basepay-stockflow-pilot-pending:8453:${wallet.toLowerCase()}`;
const isHash = (h: unknown): h is `0x${string}` => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);

export function loadPending(wallet: string): PendingTrade[] {
  const raw = localStorage.getItem(key(wallet));
  if (!raw) return [];
  const list = JSON.parse(raw) as unknown;
  if (!Array.isArray(list)) throw new Error("Stored pending trades are unreadable.");
  return list.filter((p): p is PendingTrade =>
    !!p && typeof p === "object" && isHash((p as PendingTrade).hash) &&
    typeof (p as PendingTrade).quoteId === "string" &&
    typeof (p as PendingTrade).wallet === "string" &&
    (p as PendingTrade).wallet.toLowerCase() === wallet.toLowerCase())
    .map(p => ({ ...p, replacementHashes: replacementHashes(p) }));
}

// Read legacy replacedBy journals too. The original hash remains the stable
// journal key; never turn a wallet hint into an asserted successful swap.
export function replacementHashes(entry: PendingTrade): `0x${string}`[] {
  const hints = Array.isArray(entry.replacementHashes) ? entry.replacementHashes : [];
  return [...new Set([...hints, entry.replacedBy].filter(isHash).map(h => h.toLowerCase()))]
    .filter(h => h !== entry.hash.toLowerCase()) as `0x${string}`[];
}
export function withReplacement(entry: PendingTrade, hash: `0x${string}`): PendingTrade {
  return { ...entry, receipt: "unknown", replacedBy: hash, replacementHashes: replacementHashes({ ...entry, replacementHashes: [...replacementHashes(entry), hash] }) };
}

export function upsertPending(entry: PendingTrade) {
  const list = loadPending(entry.wallet).filter((p) => p.hash.toLowerCase() !== entry.hash.toLowerCase());
  localStorage.setItem(key(entry.wallet), JSON.stringify([entry, ...list]));
}

export function removePending(wallet: string, hash: string) {
  const list = loadPending(wallet).filter((p) => p.hash.toLowerCase() !== hash.toLowerCase());
  if (list.length) localStorage.setItem(key(wallet), JSON.stringify(list));
  else localStorage.removeItem(key(wallet));
}
