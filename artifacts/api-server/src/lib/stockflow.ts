import { z } from "zod";
import { createPublicClient, fallback, http, formatUnits, parseAbi, type Address } from "viem";
import { base } from "viem/chains";

const tokenSchema = z.object({
  contract_address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int().min(0).max(36),
  multiplier: z.number().positive().finite().optional(),
  nav_price: z.number().positive().finite().optional(),
  nav_price_updated_at: z.string().datetime().optional(),
  icon_url: z.string().url().optional(),
  paused_features: z.array(z.union([z.string(), z.number()])).optional(),
});
const pageSchema = z.object({
  tokens: z.array(tokenSchema),
  next_page_token: z.string().optional(),
});
export type StockflowStock = {
  address: string; symbol: string; name: string; decimals: number;
  multiplier: number | null; referencePrice: number | null;
  priceUpdatedAt: string | null; iconUrl: string | null; pausedFeatures: string[];
};
type Catalogue = { stocks: StockflowStock[]; fetchedAt: string; source: string; chainId: number };
let cache: Catalogue | undefined;
let pending: Promise<Catalogue> | undefined;
const SOURCE = "https://api.coinbase.com/v1/tokenized-stocks";

export async function getStockflowCatalogue(): Promise<Catalogue> {
  if (cache && Date.now() - Date.parse(cache.fetchedAt) < 60_000) return cache;
  if (pending) return pending;
  pending = (async () => {
    const stocks: StockflowStock[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 10; page++) {
      const url = new URL(SOURCE);
      url.searchParams.set("page_size", "500");
      if (cursor) url.searchParams.set("page_token", cursor);
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`Stock reference API returned ${response.status}`);
      const data = pageSchema.parse(await response.json());
      for (const t of data.tokens) {
        const key = t.contract_address.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        stocks.push({
          address: t.contract_address, symbol: t.symbol, name: t.name, decimals: t.decimals,
          multiplier: t.multiplier ?? null, referencePrice: t.nav_price ?? null,
          priceUpdatedAt: t.nav_price_updated_at ?? null, iconUrl: t.icon_url ?? null,
          pausedFeatures: (t.paused_features ?? []).map(String),
        });
      }
      cursor = data.next_page_token;
      if (!cursor) break;
      if (page === 9) throw new Error("Stock catalogue pagination exceeded safety bound");
    }
    const result = { stocks, fetchedAt: new Date().toISOString(), source: SOURCE, chainId: base.id };
    cache = result;
    return result;
  })();
  try { return await pending; } finally { pending = undefined; }
}

const publicClient = createPublicClient({
  chain: base,
  transport: fallback([
    http("https://mainnet.base.org", { timeout: 12_000, retryCount: 1 }),
    http("https://base-rpc.publicnode.com", { timeout: 12_000, retryCount: 1 }),
  ]),
});
const abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function balanceOfUI(address account) view returns (uint256)",
]);

export async function getStockflowBalances(wallet: Address) {
  const { stocks } = await getStockflowCatalogue();
  const blockNumber = await publicClient.getBlockNumber();
  const results = await publicClient.multicall({
    blockNumber,
    allowFailure: true,
    contracts: stocks.flatMap(stock => [
      { address: stock.address as Address, abi, functionName: "balanceOf" as const, args: [wallet] as const },
      { address: stock.address as Address, abi, functionName: "balanceOfUI" as const, args: [wallet] as const },
    ]),
  });
  let failedReads = 0;
  let failedBalances = 0;
  const positions = stocks.flatMap((stock, i) => {
    const raw = results[i * 2];
    const shares = results[i * 2 + 1];
    if (!raw || raw.status !== "success") { failedReads++; failedBalances++; return []; }
    if (shares?.status !== "success") failedReads++;
    if (raw.result === 0n) return [];
    const tokenBalance = formatUnits(raw.result, stock.decimals);
    const fresh = stock.priceUpdatedAt && Date.now() - Date.parse(stock.priceUpdatedAt) <= 86_400_000;
    const value = fresh && stock.referencePrice != null ? Number(tokenBalance) * stock.referencePrice : null;
    return [{
      address: stock.address, rawBalance: raw.result.toString(), tokenBalance,
      shareBalance: shares?.status === "success" ? formatUnits(shares.result, stock.decimals) : null,
      referenceValue: value != null && Number.isFinite(value) ? value : null,
    }];
  });
  if (stocks.length && failedBalances === stocks.length) throw new Error("All stock balance reads failed");
  return { wallet, positions, failedReads, fetchedAt: new Date().toISOString(), blockNumber: blockNumber.toString() };
}
