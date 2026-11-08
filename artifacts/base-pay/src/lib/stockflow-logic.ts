// Pure logic for BasePay StockFlow. No network, no execution. Local-only.
export const STALE_MS = 24 * 60 * 60 * 1000;
export const STORAGE_PREFIX = "basepay.stockflow.v1";
export const DRAFT_SCOPE = "draft";

export type PriceStatus = "fresh" | "stale" | "unavailable";

export interface StockLike {
  address: string;
  symbol: string;
  referencePrice: number | null;
  priceUpdatedAt: string | null;
  pausedFeatures: string[];
}

export interface Allocation { address: string; symbol: string; weight: number }

export interface Policy {
  id: string;
  name: string;
  incomePct: number;
  maxPerPurchase: number;
  dailyMax: number;
  expiresAt: number;
  allocations: Allocation[];
  status: "active" | "revoked";
  createdAt: number;
  updatedAt: number;
}

export interface AuditEntry { id: string; at: number; kind: "created" | "edited" | "revoked" | "deleted" | "previewed" | "cleared"; detail: string }

export interface ScopeState { policies: Policy[]; audit: AuditEntry[] }

export function scopeFor(address: string | undefined | null): string {
  return address ? address.toLowerCase() : DRAFT_SCOPE;
}
export function storageKey(scope: string): string {
  return `${STORAGE_PREFIX}:${scope}`;
}

export function priceStatus(stock: Pick<StockLike, "referencePrice" | "priceUpdatedAt">, now: number): PriceStatus {
  if (stock.referencePrice == null || !Number.isFinite(stock.referencePrice) || stock.referencePrice <= 0) return "unavailable";
  if (!stock.priceUpdatedAt) return "unavailable";
  const t = Date.parse(stock.priceUpdatedAt);
  if (!Number.isFinite(t) || t > now + 60_000) return "unavailable";
  // Strict 24h window, weekends included.
  return now - t > STALE_MS ? "stale" : "fresh";
}

export function weightTotal(allocs: Allocation[]): number {
  return Math.round(allocs.reduce((s, a) => s + (Number(a.weight) || 0), 0) * 100) / 100;
}

export function validatePolicy(p: Omit<Policy, "id" | "status" | "createdAt" | "updatedAt">, now: number): string[] {
  const e: string[] = [];
  if (!p.name.trim()) e.push("Name the policy.");
  if (!(p.incomePct > 0 && p.incomePct <= 100)) e.push("Income share must be above 0 and at most 100%.");
  if (!Number.isFinite(p.maxPerPurchase) || !(p.maxPerPurchase > 0)) e.push("Per-purchase maximum must be finite and above 0.");
  if (!Number.isFinite(p.dailyMax) || !(p.dailyMax > 0)) e.push("Daily maximum must be finite and above 0.");
  if (p.maxPerPurchase > p.dailyMax) e.push("Per-purchase maximum cannot exceed the daily maximum.");
  if (!Number.isFinite(p.expiresAt) || !(p.expiresAt > now)) e.push("Expiry must be in the future.");
  if (p.allocations.length === 0) e.push("Allow at least one asset.");
  if (p.allocations.some((a) => !(a.weight > 0))) e.push("Every allowed asset needs a weight above 0.");
  if (new Set(p.allocations.map((a) => a.address.toLowerCase())).size !== p.allocations.length) e.push("Each asset can appear once.");
  if (Math.abs(weightTotal(p.allocations) - 100) > 0.001) e.push(`Weights must total 100 (currently ${weightTotal(p.allocations)}).`);
  return e;
}

export type PolicyState = "active" | "revoked" | "expired";
export function policyState(p: Policy, now: number): PolicyState {
  if (p.status === "revoked") return "revoked";
  return p.expiresAt <= now ? "expired" : "active";
}

export interface PreviewLine {
  address: string; symbol: string; weight: number;
  amount: number; cappedByPurchase: boolean;
  price: number | null; status: PriceStatus; paused: boolean;
   referenceShares: number | null; // Legacy field name: quantity is token units, not underlying shares.
}
export interface Preview { income: number; budget: number; total: number; cappedByDaily: boolean; lines: PreviewLine[]; blocked: string | null }

export function buildPreview(p: Policy, income: number, stocks: StockLike[], now: number): Preview {
  const st = policyState(p, now);
  const empty: Preview = { income, budget: 0, total: 0, cappedByDaily: false, lines: [], blocked: null };
  if (st !== "active") return { ...empty, blocked: st === "revoked" ? "Policy is revoked." : "Policy has expired." };
  if (!Number.isFinite(income) || !(income > 0)) return { ...empty, blocked: "Enter a finite income amount above 0." };
  const errors = validatePolicy(p, now);
  if (errors.length) return { ...empty, blocked: errors[0] };
  const budget = round2((income * p.incomePct) / 100);
  const daily = Math.min(budget, p.dailyMax);
  const cappedByDaily = budget > p.dailyMax;
  const map = new Map(stocks.map((s) => [s.address.toLowerCase(), s]));
  const lines: PreviewLine[] = p.allocations.map((a) => {
    const s = map.get(a.address.toLowerCase());
    const raw = (daily * a.weight) / 100;
    // Round down each leg: rounding thirds up must never exceed the daily cap.
    const amount = Math.floor(Math.min(raw, p.maxPerPurchase) * 100 + 1e-9) / 100;
    const status: PriceStatus = s ? priceStatus(s, now) : "unavailable";
    const price = s?.referencePrice ?? null;
    // NAV is already multiplier-adjusted: never apply the multiplier again.
    const referenceShares = status === "fresh" && price ? amount / price : null;
    return { address: a.address, symbol: a.symbol, weight: a.weight, amount, cappedByPurchase: raw > p.maxPerPurchase + 1e-9, price, status, paused: !!s && s.pausedFeatures.length > 0, referenceShares };
  });
  return { income, budget, total: round2(lines.reduce((x, l) => x + l.amount, 0)), cappedByDaily, lines, blocked: null };
}

function round2(n: number) { return Math.round(n * 100) / 100; }

export function parseScopeState(raw: string | null): ScopeState {
  if (!raw) return { policies: [], audit: [] };
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v?.policies) || !Array.isArray(v?.audit)) throw new Error();
    for (const p of v.policies) {
      if (!p || typeof p.id !== "string" || typeof p.name !== "string"
        || !Array.isArray(p.allocations) || !["active", "revoked"].includes(p.status)
        || ![p.incomePct, p.maxPerPurchase, p.dailyMax, p.expiresAt, p.createdAt, p.updatedAt].every(Number.isFinite)
        || p.allocations.some((a: Allocation) => !a || typeof a.address !== "string" || typeof a.symbol !== "string" || !Number.isFinite(a.weight))) throw new Error();
    }
    for (const a of v.audit) if (!a || typeof a.id !== "string" || typeof a.kind !== "string" || typeof a.detail !== "string" || !Number.isFinite(a.at)) throw new Error();
    return { policies: v.policies, audit: v.audit };
  } catch { throw new Error("Saved StockFlow data is unreadable. It has not been overwritten."); }
}

export function loadScope(scope: string, store: Pick<Storage, "getItem"> | null = safeStorage()): ScopeState {
  if (!store) throw new Error("Browser storage is unavailable. Rules cannot be saved.");
  return parseScopeState(store.getItem(storageKey(scope)));
}
export function saveScope(scope: string, state: ScopeState, store: Pick<Storage, "setItem"> | null = safeStorage()) {
  if (!store) throw new Error("Browser storage is unavailable. Rules were not saved.");
  store.setItem(storageKey(scope), JSON.stringify({ ...state, audit: state.audit.slice(0, 200) }));
}
function safeStorage(): Storage | null {
  try { return typeof window !== "undefined" ? window.localStorage : null; } catch { return null; }
}
