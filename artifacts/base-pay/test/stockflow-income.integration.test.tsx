import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncomePanel, incomePolicySnapshot } from "../src/components/stockflow/IncomePanel";
import { buildOwnershipMessage } from "../src/lib/walletProof";
import type { Policy } from "../src/lib/stockflow-logic";
import type { StockflowIncome } from "@workspace/api-client-react";

const mocks = vi.hoisted(() => ({ sign: vi.fn(), get: vi.fn(), sync: vi.fn(), save: vi.fn(), review: vi.fn() }));
vi.mock("wagmi", () => ({ useSignMessage: () => ({ signMessageAsync: mocks.sign }) }));
vi.mock("@workspace/api-client-react", () => ({
  useGetStockflowIncome: (wallet: string, params: unknown, { query }: { query: Record<string, unknown> }) => useQuery({
    ...query, queryKey: query.queryKey as string[], queryFn: () => mocks.get(wallet, params),
  }),
  syncStockflowIncome: (...args: unknown[]) => mocks.sync(...args),
  setStockflowIncomePolicy: (...args: unknown[]) => mocks.save(...args),
  reviewStockflowProposal: (...args: unknown[]) => mocks.review(...args),
}));
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const tx = `0x${"ab".repeat(32)}`;
const rule: Policy = { id: "p", name: "Income rule", incomePct: 10, maxPerPurchase: 20, dailyMax: 30,
  expiresAt: Date.now() + 86400000, allocations: [{ address: B, symbol: "AAA", weight: 100 }],
  status: "active", createdAt: 1, updatedAt: 2 };
function ledger(wallet: string): StockflowIncome {
  return { wallet, chainId: 8453, requiredConfirmations: 12, policy: incomePolicySnapshot(rule), scanStartBlock: "10",
    scannedThroughBlock: "100", scannedBlockHash: tx, headBlock: "100", syncedAt: new Date().toISOString(),
    receipts: [{ id: `receipt-${wallet}`, txHash: tx, logIndex: 3, receiptIndex: 0, token: "USDC", tokenAddress: B,
      amountAtomic: wallet === A ? "42000000" : "9000000", sender: B, blockNumber: "50", blockHash: tx,
      receivedAt: new Date().toISOString(), confirmations: 51, status: "confirmed", paymentRequestIds: [] }],
    proposals: [{ id: `proposal-${wallet}`, receiptId: `receipt-${wallet}`, policy: incomePolicySnapshot(rule),
      totalUsd: "4.20", lines: [{ address: B, symbol: "AAA", amountUsd: "4.20" }], status: "pending_review",
      reason: null, createdAt: new Date().toISOString(), reviewedAt: null }] };
}
let persisted: Map<string, StockflowIncome>;
let clients: QueryClient[];
function wrapper(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  clients.push(client);
  return { client, Wrapper: ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> };
}
beforeEach(() => {
  clients = [];
  persisted = new Map([[A, ledger(A)], [B, ledger(B)]]);
  mocks.sign.mockReset().mockResolvedValue("0x1234");
  mocks.get.mockReset().mockImplementation(async wallet => structuredClone(persisted.get(wallet)));
  mocks.sync.mockReset().mockImplementation(async wallet => structuredClone(persisted.get(wallet)));
  mocks.save.mockReset().mockImplementation(async (wallet, { policy }) => {
    persisted.get(wallet)!.policy = policy; return structuredClone(persisted.get(wallet));
  });
  mocks.review.mockReset().mockImplementation(async (wallet, id, { status }) => {
    const p = persisted.get(wallet)!.proposals.find(p => p.id === id)!;
    p.status = status; return structuredClone(persisted.get(wallet));
  });
});
afterEach(() => { cleanup(); clients.forEach(c => c.clear()); });

describe("StockFlow income wallet UI", () => {
  it("never reads or signs for disconnected drafts", () => {
    const { Wrapper } = wrapper();
    render(<IncomePanel address={undefined} policy={rule} />, { wrapper: Wrapper });
    expect(screen.getByText(/Disconnected drafts are never ingested/)).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.sign).not.toHaveBeenCalled();
  });
  it("unlocks the scoped history, renders real amounts and records manual review without a trade", async () => {
    const { Wrapper } = wrapper();
    render(<IncomePanel address={A} policy={rule} />, { wrapper: Wrapper });
    expect(screen.queryByText(/42 USDC/)).toBeNull();
    fireEvent.click(screen.getByText("Unlock and sync receipts"));
    await screen.findByText(/42 USDC/);
    expect(mocks.sync.mock.calls[0]![0]).toBe(A);
    expect(screen.getByText(/pending review/)).toBeTruthy();
    fireEvent.click(screen.getByText("Mark reviewed — no trade"));
    await screen.findByText("Review recorded. No trade was placed.");
    expect(mocks.review.mock.calls[0]!.slice(0, 2)).toEqual([A, `proposal-${A}`]);
    expect(persisted.get(A)!.proposals[0]!.status).toBe("reviewed");
    // The only wallet operation this component imports is signMessage.
    expect(mocks.sign.mock.calls.length).toBe(2);
  });
  it("hides previous account data immediately and ignores late signing after account switching", async () => {
    const { Wrapper } = wrapper();
    let resolve!: (value: string) => void;
    mocks.sign.mockImplementationOnce(() => new Promise<string>(r => { resolve = r; }));
    const view = render(<IncomePanel key={A} address={A} policy={rule} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Unlock and sync receipts"));
    await waitFor(() => expect(mocks.sign).toHaveBeenCalled());
    view.rerender(<IncomePanel key={B} address={B} policy={null} />);
    resolve("0x1234");
    await waitFor(() => expect(screen.getByText("Unlock and sync receipts")).toBeTruthy());
    expect(mocks.sync).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Unlock and sync receipts"));
    await screen.findByText(/9 USDC/);
    expect(screen.queryByText(/42 USDC/)).toBeNull();
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.sync.mock.calls[0]![0]).toBe(B);
  });
  it("restores the server policy and decisions after a new session even with no local policies", async () => {
    persisted.get(A)!.proposals[0]!.status = "dismissed";
    const first = wrapper();
    const view = render(<IncomePanel address={A} policy={rule} />, { wrapper: first.Wrapper });
    fireEvent.click(screen.getByText("Unlock and sync receipts"));
    await screen.findByText("dismissed");
    view.unmount(); first.client.clear();
    const second = wrapper();
    render(<IncomePanel address={A} policy={null} />, { wrapper: second.Wrapper });
    fireEvent.click(screen.getByText("Unlock and sync receipts"));
    await screen.findByText(/42 USDC/);
    expect(screen.getByText("dismissed")).toBeTruthy();
    expect(screen.getAllByText("Income rule").length).toBeGreaterThan(0);
    expect(persisted.get(A)!.receipts).toHaveLength(1);
    expect(persisted.get(A)!.proposals).toHaveLength(1);
  });
  it("signs the exact canonical rule snapshot and can pause future proposals", async () => {
    const { Wrapper } = wrapper();
    render(<IncomePanel address={A} policy={rule} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Use selected local policy for income"));
    await screen.findByText("Income policy snapshot saved. Sync to generate proposals.");
    const call = mocks.save.mock.calls[0]!;
    const payload = call[1];
    expect(mocks.sign.mock.calls[0]![0].message).toBe(buildOwnershipMessage("stockflow-policy", { policy: JSON.stringify(payload.policy) }, payload.timestamp));
    expect(payload.policy).toEqual(incomePolicySnapshot(rule));
    fireEvent.click(screen.getByText("Unlock and sync receipts"));
    await screen.findByText(/42 USDC/);
    fireEvent.click(screen.getByText("Pause new proposals"));
    await screen.findByText("New proposals paused. Unreviewed proposals invalidated.");
    expect(mocks.save.mock.calls[1]![1].policy).toBeNull();
  });
  it("shows verification failures rather than reporting successful ingestion", async () => {
    mocks.sync.mockRejectedValueOnce({ data: { error: "Base temporarily unavailable" } });
    const { Wrapper } = wrapper();
    render(<IncomePanel address={A} policy={rule} />, { wrapper: Wrapper });
    fireEvent.click(screen.getByText("Unlock and sync receipts"));
    expect((await screen.findByRole("alert")).textContent).toBe("Base temporarily unavailable");
    expect(screen.queryByText(/42 USDC/)).toBeNull();
  });
});
