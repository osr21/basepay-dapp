import { useEffect, useRef, useState } from "react";
import { useSignMessage } from "wagmi";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetStockflowIncome, syncStockflowIncome, setStockflowIncomePolicy, reviewStockflowProposal,
  type StockflowIncome, type StockflowIncomePolicy,
} from "@workspace/api-client-react";
import { formatUnits } from "viem";
import { buildOwnershipMessage } from "@/lib/walletProof";
import { policyState, type Policy } from "@/lib/stockflow-logic";

const button = "rounded-lg border border-border px-3 py-2 text-xs font-semibold hover:bg-secondary disabled:opacity-40";
const input = "rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono";
type Proof = { signature: string; timestamp: number };
const errorMessage = (e: unknown) => {
  const api = e as { data?: { error?: string }; message?: string };
  return api.data?.error ?? api.message ?? "Income request failed.";
};

// Match the contract's canonical field order. Signatures bind the complete
// snapshot, not only a local ID that could later refer to different rules.
export function incomePolicySnapshot(p: Policy): StockflowIncomePolicy {
  return { id: p.id, name: p.name, incomePct: p.incomePct, maxPerPurchase: p.maxPerPurchase,
    dailyMax: p.dailyMax, expiresAt: p.expiresAt, status: p.status, createdAt: p.createdAt,
    updatedAt: p.updatedAt, allocations: p.allocations.map(a => ({ address: a.address, symbol: a.symbol, weight: a.weight })) };
}

/** Parent keys this component by wallet; pending promises are ignored on unmount
 * before they can submit a follow-up request or expose another wallet's result. */
export function IncomePanel({ address, policy }: { address: string | undefined; policy: Policy | null }) {
  const wallet = address?.toLowerCase() ?? "";
  const { signMessageAsync } = useSignMessage();
  const client = useQueryClient();
  const key = ["stockflow-income", wallet];
  const alive = useRef(true);
  const running = useRef(false);
  const [proof, setProof] = useState<Proof | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [txHash, setTxHash] = useState("");
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const query = useGetStockflowIncome(wallet, proof ?? { signature: "", timestamp: 0 }, {
    query: { queryKey: key, enabled: !!wallet && !!proof, refetchInterval: 30_000, retry: false, staleTime: 0 },
  });
  useEffect(() => {
    const timer = setInterval(() => {
      if (proof && Date.now() / 1000 - proof.timestamp >= 240) setProof(null);
    }, 5000);
    return () => clearInterval(timer);
  }, [proof]);
  const sign = async (action: string, fields: Record<string, string> = {}): Promise<Proof> => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signMessageAsync({ account: wallet as `0x${string}`, message: buildOwnershipMessage(action, fields, timestamp) });
    if (!alive.current) throw new Error("Wallet changed. No request was submitted.");
    return { signature, timestamp };
  };
  const run = async (work: () => Promise<StockflowIncome>, success: string | ((data: StockflowIncome) => string)) => {
    if (!wallet || running.current) return;
    running.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      await client.cancelQueries({ queryKey: key });
      const data = await work();
      if (!alive.current) return;
      await client.cancelQueries({ queryKey: key });
      client.setQueryData(key, data);
      setNotice(typeof success === "function" ? success(data) : success);
    } catch (e) { if (alive.current) setError(errorMessage(e)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  const synchronize = (historicalHash?: string) => run(async () => {
    const p = proof && Date.now() / 1000 - proof.timestamp < 240 ? proof : await sign("stockflow-income");
    if (!alive.current) throw new Error("Wallet changed.");
    const data = await syncStockflowIncome(wallet, { ...p, ...(historicalHash ? { txHash: historicalHash } : {}) });
    if (alive.current) { setProof(p); setTxHash(""); }
    return data;
  }, "Receipts verified. Proposals still require review; no trades were placed.");
  // Poll only after explicit consent/unlock. Expired proof never opens another
  // wallet prompt; the user chooses when to unlock again.
  useEffect(() => {
    if (!proof) return;
    const timer = setInterval(() => {
      if (!running.current && Date.now() / 1000 - proof.timestamp < 240) void synchronize();
    }, 60_000);
    return () => clearInterval(timer);
  }, [proof]); // synchronize uses this proof and wallet; the parent remounts on account switches.

  const savePolicy = (p: Policy | null) => run(async () => {
    const snapshot = p ? incomePolicySnapshot(p) : null;
    const auth = await sign("stockflow-policy", { policy: JSON.stringify(snapshot) });
    return setStockflowIncomePolicy(wallet, { policy: snapshot, ...auth });
  }, p ? "Income policy snapshot saved. Sync to generate proposals." : "New proposals paused. Unreviewed proposals invalidated.");
  const review = (id: string, status: "reviewed" | "dismissed") => run(async () => {
    const auth = await sign("stockflow-review", { id, status });
    return reviewStockflowProposal(wallet, id, { status, ...auth });
  }, data => data.proposals.find(p => p.id === id)?.status === status
    ? `${status === "reviewed" ? "Review" : "Dismissal"} recorded. No trade was placed.`
    : "The proposal is no longer reviewable. Its updated status is shown below.");

  const data = proof ? query.data : undefined;
  const policyChanged = !!data?.policy && !!policy && data.policy.id === policy.id
    && JSON.stringify(data.policy) !== JSON.stringify(incomePolicySnapshot(policy));
  const lagging = data?.scannedThroughBlock && data.headBlock && BigInt(data.scannedThroughBlock) < BigInt(data.headBlock);
  return (
    <section className="rounded-2xl border border-border bg-card/60 p-5 space-y-4" aria-label="Received income" data-testid="stockflow-income">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Base Mainnet · read-only</p>
          <h2 className="sf-display text-xl">Received payments → allocation proposals</h2></div>
        <button className={button} disabled={!wallet || busy} onClick={() => void synchronize()}>{busy ? "Working…" : proof ? "Sync receipts" : "Unlock and sync receipts"}</button>
      </div>
      <p className="text-xs text-muted-foreground">Verify incoming USDC and EURC with 12 Base confirmations. Receipts, the saved income-policy snapshot and review decisions persist across sessions. This never signs or sends a transaction.</p>
      {!wallet ? <p className="text-sm">Connect a wallet to view its receipts. Disconnected drafts are never ingested.</p> : (
        <>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={busy || !policy || policyState(policy, Date.now()) !== "active"} onClick={() => void savePolicy(policy)}>Use selected local policy for income</button>
            <button className={button} disabled={busy || !data?.policy} onClick={() => void savePolicy(null)}>Pause new proposals</button>
          </div>
          <p className="text-xs text-muted-foreground">Saving uses a separate server snapshot. Local edits, revocation or deletion do not change it automatically: save the updated policy or pause here. Existing receipts are proposed once, not again after rule changes.</p>
          {data?.policy && <p className="text-sm">Saved income policy: <strong>{data.policy.name}</strong> · {data.policy.incomePct}% · ${data.policy.maxPerPurchase}/purchase · ${data.policy.dailyMax}/UTC day · expires {new Date(data.policy.expiresAt).toLocaleString()}.</p>}
          {policyChanged && <p role="status" className="text-sm text-amber-500">The selected local policy differs from the saved income snapshot.</p>}
          {data && !data.policy && <p className="text-sm">No income policy is enabled. Select a local rule above and save it to generate reviewable proposals.</p>}
          <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); if (/^0x[0-9a-fA-F]{64}$/.test(txHash)) void synchronize(txHash); }}>
            <label className="sr-only" htmlFor="sf-income-hash">Historical Base transaction hash</label>
            <input id="sf-income-hash" className={`${input} min-w-0 flex-1`} value={txHash} onChange={e => setTxHash(e.target.value.trim())} placeholder="Historical Base transaction hash (0x…)" />
            <button className={button} disabled={busy || !/^0x[0-9a-fA-F]{64}$/.test(txHash)}>Verify transaction</button>
          </form>
          {!proof && <p className="text-xs text-muted-foreground">Unlock with a wallet message to see private receipt links and proposals. Access expires after four minutes; no automatic signature prompts.</p>}
          {query.isLoading && <p role="status">Loading saved income…</p>}
          {data && <>
            <p className="text-xs text-muted-foreground">Last verified {data.syncedAt ? new Date(data.syncedAt).toLocaleString() : "never"}. Automatic discovery starts about 24 hours before the first sync and scans 2,000 blocks per sync. Older paid BasePay requests and manually supplied hashes are verified independently.
              {data.scannedThroughBlock && <> Scanned {data.scanStartBlock}–{data.scannedThroughBlock}; observed head {data.headBlock}.</>}
              {lagging && <strong> Catch-up incomplete — sync again or leave unlocked for automatic updates.</strong>}</p>
            <h3 className="font-semibold text-sm">Verified transfer history</h3>
            {!data.receipts.length && <p className="text-sm text-muted-foreground">No supported incoming transfers found in the scanned range yet.</p>}
            <ul className="max-h-80 overflow-y-auto space-y-2">
              {[...data.receipts].reverse().map(r => <li key={r.id} className="rounded-lg border border-border p-3 text-xs">
                <a className="underline" href={`https://basescan.org/tx/${r.txHash}`} target="_blank" rel="noreferrer">{formatUnits(BigInt(r.amountAtomic), 6)} {r.token} · log {r.logIndex}</a>
                <p>{r.status} · {r.confirmations}/{data.requiredConfirmations} confirmations · {r.paymentRequestIds.length ? `BasePay receipt ${r.paymentRequestIds.join(", ")}` : "Direct incoming transfer"}</p>
                <p className="text-muted-foreground">{new Date(r.receivedAt).toLocaleString()}</p>
              </li>)}
            </ul>
            <h3 className="font-semibold text-sm">Proposals — manual review only</h3>
            <p className="text-xs text-muted-foreground">Amounts are USD planning allocations, not execution quotes or reserved funds. The daily planning cap is shared across policy versions. Dismissed and invalidated proposals still count that day; no budget is recycled.</p>
            {!data.proposals.length && <p className="text-sm text-muted-foreground">No proposals yet. A saved active policy and confirmed income are required.</p>}
            <ul className="max-h-[500px] overflow-y-auto space-y-3">
              {[...data.proposals].reverse().map(p => <li key={p.id} className="rounded-xl border border-border p-3 text-sm space-y-2">
                <p><strong>${p.totalUsd}</strong> · {p.policy.name} · <span className="font-mono">{p.status.replaceAll("_", " ")}</span></p>
                <p className="text-xs text-muted-foreground">Receipt log {data.receipts.find(r => r.id === p.receiptId)?.logIndex} · {p.policy.incomePct}% income · ${p.policy.maxPerPurchase}/purchase · ${p.policy.dailyMax}/day · created {new Date(p.createdAt).toLocaleString()}</p>
                <ul className="font-mono text-xs">{p.lines.map(l => <li key={l.address}>{l.symbol}: ${l.amountUsd}</li>)}</ul>
                {p.reason && <p className="text-xs" role="status">{p.reason}</p>}
                {p.status === "pending_review" && <div className="flex flex-wrap gap-2">
                  <button className={button} disabled={busy} onClick={() => void review(p.id, "reviewed")}>Mark reviewed — no trade</button>
                  <button className={button} disabled={busy} onClick={() => void review(p.id, "dismissed")}>Dismiss proposal</button>
                </div>}
                {p.reviewedAt && <p className="text-xs text-muted-foreground">Decision recorded {new Date(p.reviewedAt).toLocaleString()}</p>}
              </li>)}
            </ul>
          </>}
        </>
      )}
      {(error || query.isError) && <p role="alert" className="text-sm text-red-500">{error ?? errorMessage(query.error)}</p>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
    </section>
  );
}
