import { describe, it, expect } from "vitest";
import { priceStatus, validatePolicy, buildPreview, scopeFor, storageKey, loadScope, saveScope, type Policy } from "../src/lib/stockflow-logic";

const now = Date.parse("2025-06-09T12:00:00Z");
const stock = (o: Partial<{ address: string; referencePrice: number | null; priceUpdatedAt: string | null }>) => ({ address: "0xa", symbol: "AAA", referencePrice: 100, priceUpdatedAt: new Date(now - 1000).toISOString(), pausedFeatures: [], ...o });
const policy: Policy = { id: "p", name: "Core", incomePct: 10, maxPerPurchase: 60, dailyMax: 100, expiresAt: now + 1e9, status: "active", createdAt: now, updatedAt: now,
  allocations: [{ address: "0xa", symbol: "AAA", weight: 70 }, { address: "0xb", symbol: "BBB", weight: 30 }] };

describe("stockflow logic", () => {
  it("price status: missing NAV unavailable, >24h stale even on weekends", () => {
    expect(priceStatus(stock({ referencePrice: null }), now)).toBe("unavailable");
    expect(priceStatus(stock({ priceUpdatedAt: null }), now)).toBe("unavailable");
    expect(priceStatus(stock({ priceUpdatedAt: new Date(now - 25 * 3600e3).toISOString() }), now)).toBe("stale");
    expect(priceStatus(stock({}), now)).toBe("fresh");
  });
  it("validates weights total 100 and limits", () => {
    expect(validatePolicy(policy, now)).toEqual([]);
    expect(validatePolicy({ ...policy, allocations: [{ address: "0xa", symbol: "A", weight: 50 }] }, now).join()).toMatch(/total 100/);
    expect(validatePolicy({ ...policy, maxPerPurchase: 200 }, now).length).toBeGreaterThan(0);
  });
  it("preview caps and does not apply multiplier", () => {
    const pv = buildPreview(policy, 2000, [stock({}), stock({ address: "0xb", referencePrice: null })], now);
    expect(pv.budget).toBe(200);
    expect(pv.cappedByDaily).toBe(true);
    expect(pv.lines[0].amount).toBe(60);
    expect(pv.lines[0].cappedByPurchase).toBe(true);
    expect(pv.lines[0].referenceShares).toBeCloseTo(0.6);
    expect(pv.lines[1].referenceShares).toBeNull();
    expect(buildPreview({ ...policy, status: "revoked" }, 100, [], now).blocked).toMatch(/revoked/);
  });
  it("scopes storage per wallet", () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    saveScope(scopeFor("0xABC"), { policies: [policy], audit: [] }, store);
    expect(loadScope(scopeFor("0xabc"), store).policies).toHaveLength(1);
    expect(loadScope(scopeFor("0xdef"), store).policies).toHaveLength(0);
    expect(loadScope(scopeFor(undefined), store).policies).toHaveLength(0);
    expect(storageKey(scopeFor(undefined))).toMatch(/draft$/);
  });
  it("rejects non-finite values and never rounds allocations above a small cap", () => {
    expect(validatePolicy({ ...policy, dailyMax: Infinity }, now).length).toBeGreaterThan(0);
    expect(buildPreview(policy, Infinity, [], now).blocked).toMatch(/finite/);
    const p = { ...policy, incomePct: 100, dailyMax: 0.02, maxPerPurchase: 0.02,
      allocations: [{address:"a",symbol:"A",weight:33.33},{address:"b",symbol:"B",weight:33.33},{address:"c",symbol:"C",weight:33.34}] };
    expect(buildPreview(p, 0.02, [], now).total).toBeLessThanOrEqual(0.02);
  });
  it("reports failed persistence instead of silently losing rules", () => {
    const store = { setItem: () => { throw new Error("Quota exceeded"); } };
    expect(() => saveScope("draft", {policies:[policy],audit:[]}, store)).toThrow(/Quota/);
    expect(() => loadScope("draft", {getItem:() => "{broken"})).toThrow(/unreadable/);
    expect(priceStatus(stock({priceUpdatedAt:new Date(now+3600e3).toISOString()}),now)).toBe("unavailable");
  });
});
