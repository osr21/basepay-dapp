import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const m = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111", chain: 8453,
  approved: true, cookie: "0x1111111111111111111111111111111111111111",
  record: vi.fn(), quote: vi.fn(), prepare: vi.fn(), wait: vi.fn(), write: vi.fn(),
}));
const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x4444444444444444444444444444444444444444";
const HASH = `0x${"a".repeat(64)}` as const;
const REPLACEMENT = `0x${"b".repeat(64)}` as const;
const SECOND = `0x${"c".repeat(64)}` as const;
const STOCK = "0x2222222222222222222222222222222222222222";
const session = () => ({ authenticated: true, address: m.cookie, enabled: m.approved, approved: m.approved, reason: "revoked", participant: null });
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: m.address, isConnected: true }), useChainId: () => m.chain,
  useConfig: () => ({}), useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
}));
vi.mock("wagmi/actions", () => ({
  getWalletClient: async () => ({ account: { address: OWNER }, getChainId: async () => 8453, writeContract: m.write }),
}));
vi.mock("@/lib/wagmi", () => ({ DATA_SUFFIX: undefined }));
// The independently tested fee estimator is outside this replacement fixture.
// Keep it offline and permit the next mocked write without weakening app gates.
vi.mock("@/lib/stockflow-network-fees", async orig => ({
  ...await orig<typeof import("../src/lib/stockflow-network-fees")>(),
  estimateTradeNetworkFees: async () => ({
    funding: "sufficient", allowance: 100_000_000n, eth: 1n,
    swap: { execution: { status: "available", wei: 1n }, l1Data: { status: "available", wei: 0n }, operator: { status: "available", wei: 0n }, totalWei: 1n },
    transactions: [],
  }),
  requireTransactionFunds: () => {},
}));
vi.mock("viem", async orig => ({
  ...await orig<typeof import("viem")>(),
  createPublicClient: () => ({
    extend() { return this; },
    getBalance: async () => 1n, readContract: async () => 100000000n,
    simulateContract: async () => ({ request: {} }), waitForTransactionReceipt: m.wait,
  }),
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetStockflowPilotSession: () => ({ data: session() }),
  getGetStockflowPilotSessionQueryKey: () => ["session"],
  useListStockflowTradeHistory: () => ({ data: [] }), getListStockflowTradeHistoryQueryKey: () => ["history"],
  getGetStockflowPositionsQueryKey: (w: string) => ["positions", w],
  getStockflowPilotSession: async () => session(),
  createStockflowTradeQuote: m.quote, prepareStockflowTrade: m.prepare, recordStockflowTrade: m.record,
  createStockflowPilotChallenge: vi.fn(), authenticateStockflowPilot: vi.fn(), logoutStockflowPilot: vi.fn(),
}));
import { useStockflowTrading } from "../src/lib/useStockflowTrading";
import { loadPending, upsertPending } from "../src/lib/stockflow-pending";
import { STOCKFLOW_FACTORY, STOCKFLOW_ROUTER, STOCKFLOW_USDC } from "../src/lib/stockflow-trade-contract";
const stock = { address: STOCK, symbol: "TEST", name: "Test stock", decimals: 8, multiplier: 1, referencePrice: null, priceUpdatedAt: null, iconUrl: null, pausedFeatures: [] };
function quote() {
  return {
    id: "replacement-quote", chainId: 8453, wallet: OWNER, stockAddress: STOCK, symbol: "TEST", side: "buy",
    router: STOCKFLOW_ROUTER, factory: STOCKFLOW_FACTORY, pool: OTHER, tickSpacing: 10,
    tokenIn: STOCKFLOW_USDC, tokenOut: STOCK, decimalsIn: 6, decimalsOut: 8,
    amountIn: "100000", amountOut: "50000", minimumOut: "49750", slippageBps: 50, priceImpactBps: 3,
    expiresAt: new Date(Date.now() + 45000).toISOString(), deadline: Math.floor(Date.now() / 1000) + 60, blockNumber: "100",
  };
}
const wrapper = ({ children }: { children: ReactNode }) =>
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
function row(status = "pending", hashes: string[] = []) {
  return { quoteId: "replacement-quote", hash: hashes.at(-1) ?? HASH, originalHash: HASH, replacementHashes: hashes, status };
}
function stored() {
  return { wallet: OWNER, quoteId: "replacement-quote", hash: HASH, symbol: "TEST", side: "buy" as const, at: 1, receipt: "unknown" as const, recordError: null };
}
async function setupTrade() {
  const hook = renderHook(() => useStockflowTrading([stock]), { wrapper });
  await act(async () => { await hook.result.current.requestQuote(STOCK, "buy", "0.1", 50); });
  return hook;
}
beforeEach(() => {
  localStorage.clear(); vi.resetAllMocks();
  m.address = OWNER; m.cookie = OWNER; m.chain = 8453; m.approved = true;
  m.quote.mockImplementation(async () => quote());
  m.prepare.mockImplementation(async () => ({ quote: quote(), approvalRequired: false, simulated: true }));
  m.write.mockResolvedValue(HASH);
  m.record.mockResolvedValue(row());
  m.wait.mockResolvedValue({ transactionHash: HASH, status: "success" });
});
afterEach(() => { cleanup(); });

describe("wallet replacement reconciliation (mock wallets only)", () => {
  it("anchors before waiting, journals every speed-up, and records the actual mined hash once", async () => {
    m.record.mockResolvedValueOnce(row()).mockResolvedValue(row("confirmed", [REPLACEMENT, SECOND]));
    m.wait.mockImplementation(async ({ onReplaced }) => {
      expect(m.record).toHaveBeenCalledTimes(1);
      onReplaced({ transaction: { hash: REPLACEMENT } });
      expect(loadPending(OWNER)[0].replacementHashes).toEqual([REPLACEMENT]);
      onReplaced({ transaction: { hash: SECOND } });
      expect(loadPending(OWNER)[0].replacementHashes).toEqual([REPLACEMENT, SECOND]);
      return { transactionHash: SECOND, status: "success" };
    });
    const { result } = await setupTrade();
    await act(async () => { await result.current.confirmTrade(); });
    expect(m.record).toHaveBeenLastCalledWith(expect.objectContaining({ quoteId: "replacement-quote", hash: HASH, replacementHashes: [REPLACEMENT, SECOND] }));
    expect(result.current.tradeDone).toBe("success"); expect(loadPending(OWNER)).toEqual([]);
    await act(async () => { await result.current.confirmTrade(); });
    expect(m.write).toHaveBeenCalledTimes(1);
    expect(result.current.error).toMatch(/already has a submitted swap/);
  });

  it.each([["cancelled", "cancelled"], ["changed", "changed"], ["failed", "reverted"]] as const)(
    "never calls a %s replacement a successful stock trade", async (serverStatus, outcome) => {
      m.record.mockResolvedValueOnce(row()).mockResolvedValue(row(serverStatus, [REPLACEMENT]));
      m.wait.mockResolvedValue({ transactionHash: REPLACEMENT, status: "success" });
      const { result } = await setupTrade();
      await act(async () => { await result.current.confirmTrade(); });
      expect(result.current.tradeDone).toBe(outcome); expect(m.write).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps an unsafe speed-up pending until the server confirms it", async () => {
    m.record.mockResolvedValueOnce(row()).mockResolvedValue(row("pending", [REPLACEMENT]));
    m.wait.mockResolvedValue({ transactionHash: REPLACEMENT, status: "success" });
    const { result } = await setupTrade();
    await act(async () => { await result.current.confirmTrade(); });
    expect(result.current.tradeDone).toBe("replaced");
    expect(loadPending(OWNER)[0].replacementHashes).toEqual([REPLACEMENT]);
    expect(result.current.pending).toHaveLength(1);
  });

  it("retains links on a recording failure, then recovers after reload and eligibility revocation without a wallet write", async () => {
    m.record.mockResolvedValueOnce(row()).mockRejectedValue(new Error("RPC unavailable"));
    m.wait.mockResolvedValue({ transactionHash: REPLACEMENT, status: "success" });
    const first = await setupTrade();
    await act(async () => { await first.result.current.confirmTrade(); });
    expect(loadPending(OWNER)[0].replacedBy).toBe(REPLACEMENT);
    first.unmount();
    m.approved = false; m.write.mockClear();
    m.record.mockResolvedValue(row("confirmed", [REPLACEMENT]));
    const second = renderHook(() => useStockflowTrading([stock]), { wrapper });
    await waitFor(() => expect(second.result.current.pending).toEqual([]));
    expect(second.result.current.canTrade).toBe(false);
    expect(m.record).toHaveBeenLastCalledWith(expect.objectContaining({ quoteId: "replacement-quote", hash: HASH, replacementHashes: [REPLACEMENT] }));
    expect(m.write).not.toHaveBeenCalled();
    expect(loadPending(OWNER)).toEqual([]);
  });

  it("recovers legacy replacedBy journals and malformed hints cannot escape the wallet journal", async () => {
    upsertPending({ ...stored(), replacedBy: REPLACEMENT });
    localStorage.setItem(`basepay-stockflow-pilot-pending:8453:${OTHER}`, JSON.stringify([stored(), { ...stored(), wallet: OTHER, replacedBy: "bad", replacementHashes: [SECOND, 12] }]));
    expect(loadPending(OTHER)).toHaveLength(1);
    expect(loadPending(OTHER)[0].replacementHashes).toEqual([SECOND]);
    m.record.mockResolvedValue(row("cancelled", [REPLACEMENT]));
    const { result } = renderHook(() => useStockflowTrading([stock]), { wrapper });
    await waitFor(() => expect(m.record).toHaveBeenCalled());
    await waitFor(() => expect(result.current.tradeDone).toBe("cancelled"));
    expect(m.record).toHaveBeenCalledWith({ quoteId: "replacement-quote", hash: HASH, replacementHashes: [REPLACEMENT] });
    expect(m.write).not.toHaveBeenCalled();
  });

  it.each(["account", "chain"] as const)("isolates an in-flight replacement after a %s switch", async change => {
    let release!: (receipt: object) => void;
    let notify!: (hash: string) => void;
    m.wait.mockImplementation(({ onReplaced }) => {
      notify = hash => onReplaced({ transaction: { hash } });
      return new Promise(resolve => { release = resolve; });
    });
    const { result, rerender } = await setupTrade();
    let operation!: Promise<void>;
    act(() => { operation = result.current.confirmTrade(); });
    await waitFor(() => expect(m.wait).toHaveBeenCalled());
    if (change === "account") m.address = OTHER; else m.chain = 84532;
    rerender();
    await act(async () => { notify(REPLACEMENT); release({ transactionHash: REPLACEMENT, status: "success" }); await operation; });
    expect(m.record).toHaveBeenCalledTimes(1);
    expect(loadPending(OWNER)[0].replacementHashes).toEqual([REPLACEMENT]);
    expect(loadPending(OTHER)).toEqual([]);
    expect(result.current.tradeDone).toBeNull();
    expect(result.current.txs).toEqual([]);
    expect(m.write).toHaveBeenCalledTimes(1);
  });

  it("does not send old-wallet hashes using a different cookie identity", async () => {
    upsertPending({ ...stored(), replacedBy: REPLACEMENT });
    m.cookie = OTHER;
    const { result } = renderHook(() => useStockflowTrading([stock]), { wrapper });
    await act(async () => { await result.current.recover(); });
    expect(m.record).not.toHaveBeenCalled(); expect(m.write).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/Sign in/);
  });

  it("blocks another submission of a quote already present in the browser journal", async () => {
    const { result } = await setupTrade();
    upsertPending(stored());
    await act(async () => { await result.current.confirmTrade(); });
    expect(m.write).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/already has a submitted/);
  });
});
