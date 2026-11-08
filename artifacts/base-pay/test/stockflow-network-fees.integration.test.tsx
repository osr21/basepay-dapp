import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { baseFeeRpc, GAS_PRICE_ORACLE, SELECTORS, type BaseFeeRpc, type RpcRequest, type RpcTransaction } from "./helpers/base-fee-rpc";

const mocks = vi.hoisted(() => ({
  address: "0x1111111111111111111111111111111111111111", chainId: 8453,
  allowance: 25_000000n, eth: 10n ** 18n,
  createQuote: vi.fn(), prepare: vi.fn(), wallet: vi.fn(),
  l1: vi.fn(), operator: vi.fn(), gas: vi.fn(), read: vi.fn(),
  simulate: vi.fn(), write: vi.fn(), waitReceipt: vi.fn(), rawReceipt: vi.fn(), record: vi.fn(),
  rpcRequest: undefined as ((request: RpcRequest) => Promise<unknown>) | undefined,
}));
const WALLET = "0x1111111111111111111111111111111111111111";
const STOCK = "0x2222222222222222222222222222222222222222";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const session = { authenticated: true, address: WALLET, isAdmin: false, enabled: true, approved: true, reason: "ok", participant: null };
vi.mock("wagmi", () => ({
  useAccount: () => ({ address: mocks.address, isConnected: true }),
  useChainId: () => mocks.chainId, useConfig: () => ({}),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
}));
vi.mock("wagmi/actions", () => ({ getWalletClient: mocks.wallet }));
vi.mock("../src/lib/wagmi", () => ({ DATA_SUFFIX: "0xaabb" }));
vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  const mockedActions = {
    getBalance: async () => mocks.eth, readContract: mocks.read,
    estimateGas: mocks.gas, getGasPrice: async () => 10n,
    estimateL1Fee: mocks.l1, estimateOperatorFee: mocks.operator,
    simulateContract: mocks.simulate,
    waitForTransactionReceipt: mocks.waitReceipt, request: mocks.rawReceipt,
  };
  return {
    ...actual,
    createPublicClient: (options: Parameters<typeof actual.createPublicClient>[0]) => ({
      extend: (actions: ReturnType<typeof import("viem/op-stack").publicActionsL2>) => {
        // Keep method mocks for the existing lifecycle/deferred-promise cases.
        // The transport cases use the actual installed client and decorator,
        // overriding only EIP-1193 I/O, never the public fee actions.
        const client = actual.createPublicClient({
          ...options, cacheTime: 0,
          transport: actual.custom({
            request: (request: RpcRequest) => {
              if (!mocks.rpcRequest) throw new Error("No JSON-RPC fixture installed");
              return mocks.rpcRequest(request);
            },
          }, { retryCount: 0 }),
        }).extend(actions);
        return new Proxy(client, {
          get: (target, key) => mocks.rpcRequest ? Reflect.get(target, key) : Reflect.get(mockedActions, key),
        });
      },
    }),
  };
});
vi.mock("@workspace/api-client-react", () => ({
  useGetStockflowPilotSession: () => ({ data: session }),
  getGetStockflowPilotSessionQueryKey: () => ["/api/stockflow/pilot/session"],
  useListStockflowTradeHistory: () => ({ data: [] }),
  getListStockflowTradeHistoryQueryKey: () => ["/api/stockflow/trading/history"],
  getGetStockflowPositionsQueryKey: (w: string) => ["/api/stockflow/positions", w],
  getStockflowPilotSession: async () => session,
  createStockflowTradeQuote: mocks.createQuote,
  prepareStockflowTrade: mocks.prepare,
  createStockflowPilotChallenge: vi.fn(), authenticateStockflowPilot: vi.fn(), logoutStockflowPilot: vi.fn(),
  recordStockflowTrade: mocks.record,
}));

import { useStockflowTrading } from "../src/lib/useStockflowTrading";
import { NetworkFees } from "../src/components/stockflow/NetworkFees";
import { PaidNetworkFees, HistoricalNetworkFees } from "../src/components/stockflow/PaidNetworkFees";
import { loadPending } from "../src/lib/stockflow-pending";
import { deserializeFee, serializeFee } from "@workspace/base-fees";

const stocks = [{ address: STOCK, symbol: "TSLA", name: "Tesla", decimals: 18, multiplier: 1, referencePrice: 250, priceUpdatedAt: null, iconUrl: null, pausedFeatures: [] }];
const makeQuote = (id = "q1") => ({
  id, chainId: 8453, wallet: WALLET, stockAddress: STOCK, symbol: "TSLA", side: "buy",
  router: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F", factory: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  pool: "0x3333333333333333333333333333333333333333", tickSpacing: 100,
  tokenIn: USDC, tokenOut: STOCK, decimalsIn: 6, decimalsOut: 18,
  amountIn: "25000000", amountOut: "1000000", minimumOut: "995000", slippageBps: 50, priceImpactBps: 12,
  expiresAt: new Date(Date.now() + 60_000).toISOString(), deadline: Math.floor(Date.now() / 1000) + 100, blockNumber: "1",
});
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
const HASH = `0x${"ab".repeat(32)}` as const;
const BLOCK = `0x${"cd".repeat(32)}`;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rpcRequest = undefined;
  mocks.address = WALLET; mocks.chainId = 8453; mocks.allowance = 25_000000n; mocks.eth = 10n ** 18n;
  const quote = makeQuote();
  mocks.createQuote.mockResolvedValue(quote);
  mocks.prepare.mockImplementation(async () => ({
    quote, allowance: mocks.allowance.toString(), balance: "100000000", approvalRequired: mocks.allowance < 25_000000n, simulated: true,
  }));
  mocks.read.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "allowance") return mocks.allowance;
    if (functionName === "operatorFeeScalar" || functionName === "operatorFeeConstant") return 1n;
    return 100000000n;
  });
  mocks.gas.mockResolvedValue(100_000n);
  mocks.l1.mockResolvedValue(200n);
  mocks.operator.mockResolvedValue(30n);
  mocks.wallet.mockResolvedValue({ account: { address: WALLET }, getChainId: async () => 8453, writeContract: mocks.write });
  mocks.simulate.mockResolvedValue({ request: {} });
  mocks.write.mockResolvedValue(HASH);
  mocks.waitReceipt.mockResolvedValue({ transactionHash: HASH, blockHash: BLOCK, status: "success" });
  mocks.rawReceipt.mockResolvedValue({
    transactionHash: HASH, blockHash: BLOCK, blockNumber: "0x10", gasUsed: "0x186a0", effectiveGasPrice: "0x14",
    l1Fee: "0x190", operatorFeeScalar: "0x0", operatorFeeConstant: "0x0",
  });
  mocks.record.mockResolvedValue({ status: "confirmed", replacementHashes: [] });
  localStorage.clear();
});

describe("actual fees and the immutable reviewed estimate", () => {
  it.each(["success", "reverted"] as const)("shows real costs for a %s swap, without replacing the review estimate", async (status) => {
    mocks.waitReceipt.mockResolvedValue({ transactionHash: HASH, blockHash: BLOCK, status });
    mocks.record.mockResolvedValue({ status: status === "success" ? "confirmed" : "failed", replacementHashes: [] });
    const { result } = await quoted();
    // The safety-check estimate changes after review; it must not rewrite it.
    mocks.l1.mockResolvedValue(900n);
    await act(async () => { await result.current.confirmTrade(); });
    expect(result.current.txs).toHaveLength(1);
    const tx = result.current.txs[0];
    expect(tx.status).toBe(status);
    expect(tx.reviewedFee?.totalWei).toBe(1000230n);
    expect(tx.actualFee?.totalWei).toBe(2000400n);
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({
      hash: HASH, reviewedSwapFee: expect.objectContaining({ totalWei: "1000230" }),
    }));
    render(<PaidNetworkFees reviewed={tx.reviewedFee} actual={tx.actualFee} />);
    expect(screen.getByText("Reviewed network estimate: ~0.00000000000100023 ETH")).toBeTruthy();
    expect(screen.getByText("Actual network fee paid: 0.0000000000020004 ETH")).toBeTruthy();
  });
  it("does not change the trade outcome or make up zero when the raw receipt fee read fails", async () => {
    const { result } = await quoted();
    mocks.rawReceipt.mockRejectedValue(new Error("RPC unavailable"));
    await act(async () => { await result.current.confirmTrade(); });
    expect(result.current.tradeDone).toBe("success");
    expect(result.current.error).toBeNull();
    const tx = result.current.txs[0];
    expect(tx.actualFee?.totalWei).toBeNull();
    render(<PaidNetworkFees reviewed={tx.reviewedFee} actual={tx.actualFee} />);
    expect(screen.getByText("Actual network fee paid: Unavailable")).toBeTruthy();
    expect(screen.getByText(/missing components are not zero/)).toBeTruthy();
  });
  it("journals the reviewed estimate when recording fails, so recovery can keep it", async () => {
    const { result } = await quoted();
    mocks.record.mockRejectedValue(new Error("history offline"));
    await act(async () => { await result.current.confirmTrade(); });
    expect(loadPending(WALLET)[0].reviewedSwapFee?.totalWei).toBe("1000230");
    // A reload recovers from the existing JSON journal, not current estimates.
    mocks.record.mockResolvedValue({ status: "confirmed", replacementHashes: [] });
    await act(async () => { await result.current.recover(); });
    expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({
      reviewedSwapFee: expect.objectContaining({ totalWei: "1000230" }),
    }));
    expect(loadPending(WALLET)).toEqual([]);
  });
  it("displays historical swap fees separately from approval, pool and service fees", () => {
    const reviewed = deserializeFee({ executionWei: "100", l1DataWei: "20", operatorWei: "1", totalWei: "121" });
    render(<HistoricalNetworkFees reviewed={serializeFee(reviewed)} actual={{ executionWei: "1", l1DataWei: null, operatorWei: "0", totalWei: null }} />);
    expect(screen.getByText(/approval.reset costs excluded/)).toBeTruthy();
    expect(screen.getByText(/Pool fee: included in output/)).toBeTruthy();
    expect(screen.getByText("Actual network fee paid: Unavailable")).toBeTruthy();
    expect(screen.getByText("0.000000000000000001 ETH")).toBeTruthy();
    expect(screen.getByText("0 ETH")).toBeTruthy(); // explicitly present operator zero only
  });
  it("does not fabricate a reviewed or paid fee for legacy history", () => {
    render(<HistoricalNetworkFees reviewed={null} actual={null} />);
    expect(screen.getByText(/Reviewed network estimate: Unavailable . not recorded/)).toBeTruthy();
    expect(screen.getByText("Actual network fee paid: Unavailable")).toBeTruthy();
    expect(screen.queryByText("0 ETH")).toBeNull();
  });
  it("keeps reset and approval receipt costs and reviews separate", async () => {
    mocks.allowance = 1n;
    const approvalHash = `0x${"ef".repeat(32)}` as const;
    mocks.write.mockResolvedValueOnce(HASH).mockResolvedValueOnce(approvalHash);
    mocks.waitReceipt.mockImplementation(async ({ hash }: { hash: string }) => {
      mocks.allowance = hash === HASH ? 0n : 25_000000n;
      return { transactionHash: hash, blockHash: BLOCK, status: "success" };
    });
    mocks.rawReceipt.mockImplementation(async ({ params: [hash] }: { params: [string] }) => ({
      transactionHash: hash, blockHash: BLOCK, blockNumber: "0x10",
      gasUsed: hash === HASH ? "0x64" : "0xc8", effectiveGasPrice: "0x1", l1Fee: "0x1",
      operatorFeeScalar: "0x0", operatorFeeConstant: "0x0",
    }));
    const { result } = await quoted();
    await act(async () => { await result.current.approveExact(); });
    expect(result.current.error).toBeNull();
    expect(result.current.txs.map(t => [t.kind, t.actualFee?.totalWei])).toEqual([["reset", 101n], ["approve", 201n]]);
    expect(result.current.txs.every(t => t.reviewedFee?.totalWei === 1000230n)).toBe(true);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function quoted() {
  const hook = renderHook(() => useStockflowTrading(stocks), { wrapper });
  await act(async () => { await hook.result.current.requestQuote(STOCK, "buy", "25", 50); });
  await waitFor(() => expect(hook.result.current.fees.status).toBe("ready"));
  return hook;
}

describe("network fee lifecycle and signing safeguards", () => {
  it("automatically estimates a quote read-only and displays all three components", async () => {
    const { result } = await quoted();
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.simulate).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    render(<NetworkFees state={result.current.fees} refresh={vi.fn()} />);
    expect(screen.getByTestId("text-network-total").textContent).toContain("0.00000000000100023 ETH");
    expect(screen.getByText("L1 data")).toBeTruthy();
    expect(screen.getByText("Operator")).toBeTruthy();
    expect(screen.getByText(/Pool fee: included/)).toBeTruthy();
    expect(screen.getByText(/BasePay service fee: 0/)).toBeTruthy();
  });

  it("refreshes reset and approval costs when allowance changes externally", async () => {
    const { result } = await quoted();
    mocks.allowance = 1n;
    await act(async () => { await result.current.refreshFees(); });
    const state = result.current.fees;
    expect(state.status).toBe("ready");
    if (state.status !== "ready") return;
    expect(state.estimate.reset?.totalWei).toBe(1_000230n);
    expect(state.estimate.approval?.totalWei).toBe(1_000230n);
    expect(state.estimate.totalWei).toBe(3_000690n);
  });

  it("polls for external allowance changes without any write or wallet request", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { result } = await quoted();
    mocks.allowance = 0n;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    const state = result.current.fees;
    expect(state.status === "ready" && state.estimate.approval?.totalWei).toBe(1_000230n);
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("refreshes after preparation reveals a changed allowance", async () => {
    mocks.allowance = 1n;
    const { result } = await quoted();
    mocks.allowance = 25_000000n;
    await act(async () => { await result.current.approveExact(); });
    await waitFor(() => {
      const state = result.current.fees;
      expect(state.status === "ready" && state.estimate.approval).toBeNull();
    });
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each(["account", "chain"] as const)("discards an in-flight estimate on %s change", async (change) => {
    const { result, rerender } = await quoted();
    let resolve!: (fee: bigint) => void;
    mocks.l1.mockImplementationOnce(() => new Promise<bigint>((done) => { resolve = done; }));
    let old!: Promise<void>;
    act(() => { old = result.current.refreshFees(); });
    await waitFor(() => expect(result.current.fees.status).toBe("loading"));
    if (change === "account") mocks.address = "0x4444444444444444444444444444444444444444";
    else mocks.chainId = 1;
    rerender();
    await act(async () => { resolve(999n); await old; });
    expect(result.current.quote).toBeNull();
    expect(result.current.fees.status).toBe("idle");
  });

  it("does not apply an old quote's fee result to a new quote", async () => {
    const { result } = await quoted();
    let resolve!: (fee: bigint) => void;
    mocks.l1.mockImplementationOnce(() => new Promise<bigint>((done) => { resolve = done; }));
    let old!: Promise<void>;
    act(() => { old = result.current.refreshFees(); });
    await waitFor(() => expect(result.current.fees.status).toBe("loading"));
    mocks.createQuote.mockResolvedValue(makeQuote("q2"));
    await act(async () => { await result.current.requestQuote(STOCK, "buy", "25", 50); });
    await waitFor(() => expect(result.current.fees.status).toBe("ready"));
    await act(async () => { resolve(999n); await old; });
    const state = result.current.fees;
    expect(result.current.quote?.id).toBe("q2");
    expect(state.status === "ready" && state.estimate.swap.totalWei).toBe(1_000230n);
  });

  it("blocks a swap when ETH pays for execution but not full Base fees, even after review", async () => {
    const { result } = await quoted();
    // Balance falls after a sufficient estimate was shown.
    mocks.eth = 1_000000n;
    await act(async () => { await result.current.confirmTrade(); });
    expect(result.current.error).toMatch(/Insufficient ETH/);
    expect(mocks.simulate).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("blocks approval when the next full transaction cost exceeds ETH", async () => {
    mocks.allowance = 0n; mocks.eth = 1_000000n;
    const { result } = await quoted();
    await act(async () => { await result.current.approveExact(); });
    expect(result.current.error).toMatch(/Insufficient ETH/);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("renders missing L1 cost as unavailable and blocks swap submission", async () => {
    mocks.l1.mockRejectedValue(new Error("L1 fee oracle unavailable"));
    const { result } = await quoted();
    render(<NetworkFees state={result.current.fees} refresh={vi.fn()} />);
    expect(screen.getByTestId("text-network-total").textContent).toContain("Unavailable");
    expect(screen.getByText(/ETH sufficiency unknown/)).toBeTruthy();
    await act(async () => { await result.current.confirmTrade(); });
    expect(result.current.error).toMatch(/Full Base network fee unavailable/);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("shows insufficient ETH instead of suggesting execution-only fees are affordable", async () => {
    mocks.eth = 1_000000n;
    const { result } = await quoted();
    render(<NetworkFees state={result.current.fees} refresh={vi.fn()} />);
    expect(screen.getByTestId("text-insufficient-network-eth").textContent).toContain("Insufficient ETH");
  });
});

describe("fee display and signing safeguards through installed viem JSON-RPC actions", () => {
  let rpc: BaseFeeRpc;
  const install = (options: Parameters<typeof baseFeeRpc>[0] = {}) => {
    rpc = baseFeeRpc(options);
    mocks.rpcRequest = rpc.request;
  };
  afterEach(() => {
    expect(rpc.unexpected).toEqual([]);
    expect(rpc.requests.length).toBeGreaterThan(0);
    expect(rpc.requests.every(({ method }) =>
      ["eth_call", "eth_estimateGas", "eth_gasPrice", "eth_getBalance"].includes(method))).toBe(true);
    // None of these cases may request a wallet, signature, or transaction.
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.simulate).not.toHaveBeenCalled();
    expect(mocks.gas).not.toHaveBeenCalled();
    expect(mocks.l1).not.toHaveBeenCalled();
    expect(mocks.operator).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([
    { scalar: 0n, constant: 0n, total: 1_000_200n, text: "0.0000000000010002 ETH" },
    { scalar: 2_000_000n, constant: 7n, total: 1_200_207n, text: "0.000000000001200207 ETH" },
  ])("renders a complete quote with verified operator scalar=$scalar and constant=$constant", async ({ scalar, constant, total, text }) => {
    install({ scalar, constant });
    const { result } = await quoted();
    const state = result.current.fees;
    expect(state.status === "ready" && state.estimate.totalWei).toBe(total);
    expect(state.status === "ready" && state.estimate.funding).toBe("sufficient");
    render(<NetworkFees state={state} refresh={vi.fn()} />);
    expect(screen.getByTestId("text-network-total").textContent).toContain(text);
    const l1Calls = rpc.requests.filter(({ method, params }) => method === "eth_call"
      && (params![0] as RpcTransaction).to?.toLowerCase() === GAS_PRICE_ORACLE);
    expect(l1Calls).toHaveLength(1);
    expect((l1Calls[0].params![0] as RpcTransaction).data).toMatch(new RegExp(`^${SELECTORS.l1}`));
  });

  it.each(["scalar", "constant", "l1"] as const)(
    "renders %s RPC failures as unavailable and refuses to request a swap signature", async (read) => {
      install({ failures: { [read]: {} } });
      const { result } = await quoted();
      render(<NetworkFees state={result.current.fees} refresh={vi.fn()} />);
      expect(screen.getByTestId("text-network-total").textContent).toContain("Unavailable");
      expect(screen.getByText(/ETH sufficiency unknown/)).toBeTruthy();
      await act(async () => { await result.current.confirmTrade(); });
      expect(result.current.error).toMatch(/Full Base network fee unavailable/);
    },
  );

  it.each(["scalar", "constant", "gas"] as const)(
    "blocks signing when %s fails inside viem's operator estimator after the reviewed estimate", async (read) => {
      install();
      const { result } = await quoted();
      expect(result.current.fees.status === "ready" && result.current.fees.estimate.totalWei).toBe(1_200_207n);
      // Fresh pre-signing reads: independent parameters and execution succeed,
      // but the next internal operator read/estimate fails and viem returns 0.
      const failingRpc = baseFeeRpc({ failures: { [read]: { fromCall: 2 } } });
      rpc = failingRpc;
      mocks.rpcRequest = failingRpc.request;
      await act(async () => { await result.current.confirmTrade(); });
      expect(result.current.error).toMatch(/Full Base network fee unavailable/);
      expect(rpc.counts[read]).toBeGreaterThanOrEqual(2);
    },
  );
});
