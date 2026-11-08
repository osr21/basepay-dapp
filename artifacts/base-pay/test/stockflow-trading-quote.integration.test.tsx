import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const WALLET = "0x1111111111111111111111111111111111111111";
const STOCK = "0x2222222222222222222222222222222222222222";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ROUTER = "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F";
const FACTORY = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef";

const session = { authenticated: true, address: WALLET, isAdmin: false, enabled: true, approved: true, reason: "ok", participant: null };
const api = vi.hoisted(() => ({ createQuote: vi.fn(), getSession: vi.fn() }));

vi.mock("wagmi", () => ({
  useAccount: () => ({ address: "0x1111111111111111111111111111111111111111", isConnected: true }),
  useChainId: () => 8453,
  useConfig: () => ({}),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
}));
vi.mock("wagmi/actions", () => ({ getWalletClient: vi.fn(() => { throw new Error("no writes in tests"); }) }));
vi.mock("../src/lib/wagmi", () => ({ DATA_SUFFIX: undefined }));
vi.mock("viem", async (orig) => ({
  ...(await orig<typeof import("viem")>()),
  createPublicClient: () => ({ extend: () => ({ getBalance: async () => 0n, readContract: async () => 0n }) }),
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetStockflowPilotSession: () => ({ data: session }),
  getGetStockflowPilotSessionQueryKey: () => ["/api/stockflow/pilot/session"],
  useListStockflowTradeHistory: () => ({ data: [] }),
  getListStockflowTradeHistoryQueryKey: () => ["/api/stockflow/trading/history"],
  getGetStockflowPositionsQueryKey: (w: string) => ["/api/stockflow/positions", w],
  getStockflowPilotSession: api.getSession,
  createStockflowTradeQuote: api.createQuote,
  createStockflowPilotChallenge: vi.fn(), authenticateStockflowPilot: vi.fn(), logoutStockflowPilot: vi.fn(),
  prepareStockflowTrade: vi.fn(), recordStockflowTrade: vi.fn(),
}));

import { useStockflowTrading } from "../src/lib/useStockflowTrading";

const stock = { address: STOCK, symbol: "TSLA", name: "Tesla", decimals: 18, multiplier: 1, referencePrice: 250.1, priceUpdatedAt: null, iconUrl: null, pausedFeatures: [] };

function quoteFor(side: "buy" | "sell", amountIn: string) {
  const buy = side === "buy";
  const out = 1_000_000n;
  return {
    id: "q1", chainId: 8453, wallet: WALLET, stockAddress: STOCK, symbol: "TSLA", side,
    router: ROUTER, factory: FACTORY, pool: "0x3333333333333333333333333333333333333333", tickSpacing: 100,
    tokenIn: buy ? USDC : STOCK, tokenOut: buy ? STOCK : USDC, decimalsIn: buy ? 6 : 18, decimalsOut: buy ? 18 : 6,
    amountIn, amountOut: out.toString(), minimumOut: (out * 9950n / 10000n).toString(), slippageBps: 50, priceImpactBps: 12,
    expiresAt: new Date(Date.now() + 60_000).toISOString(), deadline: Math.floor(Date.now() / 1000) + 100, blockNumber: "1",
  };
}

const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;

describe("useStockflowTrading.requestQuote", () => {
  beforeEach(() => { api.createQuote.mockReset(); api.getSession.mockReset(); api.getSession.mockResolvedValue(session); });

  it.each([
    ["buy", "0.1", "100000"],
    ["buy", "25", "25000000"],
    ["sell", "0.001", "1000000000000000"],
  ] as const)("%s %s sends the decimal string unchanged and matches raw %s", async (side, amount, raw) => {
    api.createQuote.mockResolvedValue(quoteFor(side, raw));
    const { result } = renderHook(() => useStockflowTrading([stock]), { wrapper });
    await act(async () => { await result.current.requestQuote(STOCK, side, ` ${amount} `, 50); });
    expect(api.createQuote).toHaveBeenCalledWith({ stockAddress: STOCK, side, amount, slippageBps: 50 });
    await waitFor(() => expect(result.current.quote?.amountIn).toBe(raw));
    expect(result.current.error).toBeNull();
  });

  it("rejects a response whose raw amount does not match the decimal input", async () => {
    api.createQuote.mockResolvedValue(quoteFor("buy", "100001"));
    const { result } = renderHook(() => useStockflowTrading([stock]), { wrapper });
    await act(async () => { await result.current.requestQuote(STOCK, "buy", "0.1", 50); });
    expect(result.current.quote).toBeNull();
    expect(result.current.error).toMatch(/does not match/);
  });

  it("rejects a response with the wrong side", async () => {
    api.createQuote.mockResolvedValue(quoteFor("buy", "100000"));
    const { result } = renderHook(() => useStockflowTrading([stock]), { wrapper });
    await act(async () => { await result.current.requestQuote(STOCK, "sell", "0.0000000000001", 50); });
    expect(result.current.quote).toBeNull();
    expect(result.current.error).not.toBeNull();
  });
});
