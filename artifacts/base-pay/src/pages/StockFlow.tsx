import { useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { useListStockflowStocks, useGetStockflowPositions, getListStockflowStocksQueryKey, getGetStockflowPositionsQueryKey } from "@workspace/api-client-react";
import type { StockflowStock, StockflowCatalogue } from "@workspace/api-client-react";
import { useStockflowSandbox } from "@/lib/stockflowSandbox";
import { truncateAddress } from "@/lib/wagmi";
import { usd, when, uid, errMsg, Panel, btnPrimary, btnGhost, btnDanger, field, StatusTag, Skeleton, Empty, ErrorBox, StockGlyph, RefreshIcon } from "@/components/stockflow/atoms";
import { PilotDesk } from "@/components/stockflow/PilotDesk";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  scopeFor, storageKey, loadScope, saveScope, priceStatus, policyState, validatePolicy, buildPreview, weightTotal,
  type Policy, type Allocation, type AuditEntry, type ScopeState,
} from "@/lib/stockflow-logic";

import { IncomePanel } from "@/components/stockflow/IncomePanel";

const SEPOLIA_ID = 84532;
const SEPOLIA_TX = "https://sepolia.basescan.org/tx/";
const SEPOLIA_ADDR = "https://sepolia.basescan.org/address/";


/* ───────────── page ───────────── */
export default function StockFlowPage() {
  const { address } = useAccount();
  const [mode, setMode] = useState<"reference" | "pilot" | "sandbox">("reference");
  const scope = scopeFor(address);

  useEffect(() => {
    const prev = document.title;
    document.title = "BasePay StockFlow — Income to stock allocation, with limits";
    let meta = document.querySelector('meta[name="description"]');
    const prevDesc = meta?.getAttribute("content") ?? null;
    if (!meta) { meta = document.createElement("meta"); meta.setAttribute("name", "description"); document.head.appendChild(meta); }
    meta.setAttribute("content", "BasePay StockFlow: plan how payment income becomes tokenized stock allocations on Base, with per-purchase, daily and expiry limits. Planner previews are reference only; approved wallets may run manual Base Mainnet pilot trades.");
    return () => { document.title = prev; if (prevDesc !== null) meta?.setAttribute("content", prevDesc); };
  }, []);

  return (
    <div className="sf mx-auto min-w-0 max-w-6xl space-y-6 pb-16 [overflow-wrap:anywhere]">
      <header className="sf-rise relative overflow-hidden rounded-3xl border border-[hsl(var(--sf-ochre)/0.18)] bg-[hsl(var(--sf-ink))] p-6 md:p-10">
        <div className="sf-grid pointer-events-none absolute inset-0 opacity-70" />
        <div className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[hsl(var(--sf-ochre)/0.12)] blur-3xl" />
        <div className="relative grid gap-6 md:grid-cols-[1.4fr_1fr] md:items-end">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-[hsl(var(--sf-ochre))]">BasePay / allocation desk</p>
            <h1 className="sf-display mt-3 text-4xl leading-[1.05] text-[hsl(var(--sf-paper))] md:text-6xl">BasePay StockFlow</h1>
            <p className="mt-4 max-w-xl text-sm leading-relaxed text-secondary-foreground">
              Decide, in advance, how much of the income you receive should become tokenized stock — and where the hard edges are. You set the share, the caps and the expiry. Nothing runs on its own. Approved pilot wallets can place manual, individually confirmed Base Mainnet trades.
            </p>
          </div>
          <dl className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-[hsl(var(--sf-ochre)/0.18)] bg-[hsl(var(--sf-ochre)/0.18)] font-mono text-[11px]">
            {[["Planner", "Review only"], ["Pilot", "Manual, approved wallets"], ["Income", "Wallet-scoped"]].map(([k, v]) => (
              <div key={k} className="bg-[hsl(var(--sf-ink))] p-3">
                <dt className="uppercase tracking-wider text-muted-foreground">{k}</dt>
                <dd className="mt-1 text-[hsl(var(--sf-paper))]">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
      </header>

      <div role="tablist" aria-label="StockFlow mode" className="sf-rise inline-flex rounded-xl border border-border bg-card/60 p-1" style={{ animationDelay: "60ms" }}>
        {([["reference", "Planner", "mainnet reference data"], ["pilot", "Base Mainnet", "approved pilot trading"], ["sandbox", "Base Sepolia", "demo sandbox"]] as const).map(([k, a, b]) => (
          <button key={k} role="tab" aria-selected={mode === k} data-testid={`tab-${k}`} onClick={() => setMode(k)}
            className={`rounded-lg px-4 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--sf-ochre))] ${mode === k ? (k === "reference" ? "bg-[hsl(var(--sf-paper))] text-[hsl(var(--sf-ink))]" : k === "pilot" ? "bg-[hsl(var(--sf-ochre))] text-[hsl(var(--sf-ink))]" : "bg-[hsl(var(--sf-verdigris))] text-[hsl(var(--sf-ink))]") : "text-muted-foreground hover:text-foreground"}`}>
            <span className="block text-sm font-semibold">{a}</span>
            <span className="block font-mono text-[10px] uppercase tracking-wider opacity-80">{b}</span>
          </button>
        ))}
      </div>

      {mode === "reference" ? <ReferenceWorkspace key={scope} scope={scope} address={address} /> : mode === "pilot" ? <PilotTab /> : <Sandbox />}
    </div>
  );
}

function PilotTab() {
  const cat = useListStockflowStocks({ query: { queryKey: getListStockflowStocksQueryKey(), refetchInterval: 120_000 } });
  return <PilotDesk stocks={cat.data?.stocks ?? []} catalogueReady={!!cat.data} />;
}

/* ───────────── reference workspace (mainnet, read-only) ───────────── */
function ReferenceWorkspace({ scope, address }: { scope: string; address: string | undefined }) {
  const now = Date.now();
  const cat = useListStockflowStocks({ query: { queryKey: getListStockflowStocksQueryKey(), refetchInterval: 120_000 } });
  const stocks = useMemo(() => cat.data?.stocks ?? [], [cat.data]);

  // State is loaded per scope; the parent keys this component on scope so an account switch remounts with a clean slate.
  const [initial] = useState(() => {
    try { return { data: loadScope(scope), error: null as string | null }; }
    catch (e) { return { data: { policies: [], audit: [] } as ScopeState, error: errMsg(e) }; }
  });
  const [state, setState] = useState<ScopeState>(initial.data);
  const [storageError, setStorageError] = useState<string | null>(initial.error);
  const commit = (fn: (s: ScopeState) => ScopeState) => {
    if (initial.error) return false; // Never overwrite unreadable existing data.
    try {
      const next = fn(state);
      saveScope(scope, next);
      setState(next); setStorageError(null); return true;
    } catch (e) { setStorageError(`Changes were not saved: ${errMsg(e)}`); return false; }
  };
  const log = (kind: AuditEntry["kind"], detail: string) => (s: ScopeState): ScopeState => ({ ...s, audit: [{ id: uid(), at: Date.now(), kind, detail }, ...s.audit] });

  const [editing, setEditing] = useState<Policy | "new" | null>(null);
  const [selected, setSelected] = useState<string | null>(state.policies[0]?.id ?? null);

  return (
    <div className="space-y-6">
      {storageError && <ErrorBox message={storageError} />}
      <div className="sf-rise flex flex-wrap items-center gap-3 rounded-xl border border-[hsl(var(--sf-verdigris)/0.25)] bg-[hsl(var(--sf-verdigris)/0.06)] px-4 py-3 text-xs text-secondary-foreground" data-testid="text-storage-scope">
        <span className="font-mono uppercase tracking-wider text-[hsl(var(--sf-verdigris))]">Local only</span>
        <span>
          {address ? <>Policies for <span className="font-mono text-foreground">{truncateAddress(address)}</span> live in this browser only.</> : <>No wallet connected — you are editing a separate <strong className="text-foreground">disconnected draft</strong>. It never merges into a wallet's policies.</>}
          {" "}Local rules stay here unless explicitly saved as an income-policy snapshot below. These planning budgets do not enforce pilot trades. Key <span className="font-mono">{storageKey(scope)}</span>.
        </span>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.15fr_1fr]">
        <Catalogue query={cat} now={now} />
        <Positions address={address} catalogue={stocks} />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.15fr]">
        <Panel kicker="Boundaries" title="Allocation planning rules" delay={120}
          actions={<button className={btnPrimary} onClick={() => setEditing("new")} data-testid="button-new-policy" disabled={editing !== null}>New policy</button>}>
          {editing && (
            <PolicyEditor
              initial={editing === "new" ? null : editing}
              stocks={stocks}
              onCancel={() => setEditing(null)}
              onSave={(p, isNew) => {
                const saved = commit((s) => log(isNew ? "created" : "edited", `${p.name}: ${p.incomePct}% of income, ${usd(p.maxPerPurchase)}/purchase, ${usd(p.dailyMax)}/day, ${p.allocations.map((a) => `${a.symbol} ${a.weight}%`).join(", ")}`)(
                  { ...s, policies: isNew ? [p, ...s.policies] : s.policies.map((x) => (x.id === p.id ? p : x)) }));
                if (!saved) return;
                setSelected(p.id); setEditing(null);
              }}
            />
          )}
          {!editing && state.policies.length === 0 && (
            <Empty title="No boundaries yet" body="A policy decides what share of income may become stock, how much per purchase and per day, until when, and into which assets." action={<button className={btnPrimary} onClick={() => setEditing("new")} data-testid="button-new-policy-empty">Draw the first one</button>} />
          )}
          {!editing && state.policies.length > 0 && (
            <ul className="space-y-3">
              {state.policies.map((p) => (
                <PolicyRow key={p.id} p={p} now={now} selected={selected === p.id}
                  onSelect={() => setSelected(p.id)}
                  onEdit={() => setEditing(p)}
                  onRevoke={() => commit((s) => log("revoked", p.name)({ ...s, policies: s.policies.map((x) => (x.id === p.id ? { ...x, status: "revoked", updatedAt: Date.now() } : x)) }))}
                  onDelete={() => { commit((s) => log("deleted", p.name)({ ...s, policies: s.policies.filter((x) => x.id !== p.id) })); if (selected === p.id) setSelected(null); }}
                />
              ))}
            </ul>
          )}
        </Panel>

        <PreviewPanel policy={state.policies.find((p) => p.id === selected) ?? null} stocks={stocks} catalogueReady={!!cat.data}
          onPreview={(detail) => commit(log("previewed", detail))} />
      </div>

      <IncomePanel key={scope} address={address} policy={state.policies.find(p => p.id === selected) ?? null} />

      <AuditPanel audit={state.audit} onClear={() => commit((s) => ({ ...s, audit: [{ id: uid(), at: Date.now(), kind: "cleared", detail: "Audit history cleared" }] }))} />
    </div>
  );
}

function Catalogue({ query, now }: { query: ReturnType<typeof useListStockflowStocks<StockflowCatalogue>>; now: number }) {
  const [q, setQ] = useState("");
  const stocks = query.data?.stocks ?? [];
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return stocks;
    return stocks.filter((s) => s.symbol.toLowerCase().includes(t) || s.name.toLowerCase().includes(t) || s.address.toLowerCase().includes(t));
  }, [stocks, q]);

  return (
    <Panel kicker={query.data ? `Chain ${query.data.chainId} · ${query.data.source}` : "Catalogue"} title="Tokenized stock catalogue" delay={80}
      actions={<button className={btnGhost} onClick={() => query.refetch()} disabled={query.isFetching} data-testid="button-refresh-catalogue"><RefreshIcon spinning={query.isFetching} />Refresh</button>}>
      <label className="sr-only" htmlFor="sf-search">Search catalogue</label>
      <input id="sf-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search symbol, name or address" className={field} data-testid="input-search-catalogue" />
      <div className="mt-4">
        {query.isLoading ? <Skeleton rows={5} />
          : query.isError ? <ErrorBox message={`Catalogue unavailable: ${errMsg(query.error)}`} onRetry={() => query.refetch()} />
          : stocks.length === 0 ? <Empty title="Catalogue is empty" body="The source returned no tokenized stocks right now. Try refreshing later." />
          : filtered.length === 0 ? <Empty title={`Nothing matches "${q}"`} body="Search covers symbol, company name and contract address." action={<button className={btnGhost} onClick={() => setQ("")}>Clear search</button>} />
          : (
            <ul className="max-h-[420px] space-y-1.5 overflow-y-auto pr-1" aria-live="polite">
              {filtered.map((s) => {
                const st = priceStatus(s, now);
                return (
                  <li key={s.address} data-testid={`row-stock-${s.symbol}`} className="flex items-center gap-3 rounded-lg border border-transparent px-2 py-2 hover:border-border hover:bg-secondary/40">
                    <StockGlyph stock={s} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="font-mono text-sm font-semibold">{s.symbol}</span>{s.pausedFeatures.length > 0 && <span title={`Paused: ${s.pausedFeatures.join(", ")}`}><StatusTag status="paused" /></span>}</div>
                      <p className="truncate text-xs text-muted-foreground">{s.name}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-mono text-sm">{st === "unavailable" ? <span className="text-muted-foreground">Unavailable</span> : usd(s.referencePrice as number)}</p>
                      <div className="mt-0.5 flex items-center justify-end gap-1.5">
                        <StatusTag status={st} />
                      </div>
                      {s.priceUpdatedAt && <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{when(s.priceUpdatedAt)}</p>}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
      </div>
      {query.data && <p className="mt-3 font-mono text-[10px] text-muted-foreground">Reference NAV per share, already multiplier-adjusted. Not a quote. Fetched {when(query.data.fetchedAt)} · {filtered.length}/{stocks.length} shown</p>}
    </Panel>
  );
}

function Positions({ address, catalogue }: { address: string | undefined; catalogue: StockflowStock[] }) {
  const wallet = address ?? "";
  const q = useGetStockflowPositions(wallet, { query: { enabled: !!wallet, queryKey: getGetStockflowPositionsQueryKey(wallet), refetchInterval: 60_000 } });
  const bySym = useMemo(() => new Map(catalogue.map((s) => [s.address.toLowerCase(), s])), [catalogue]);
  const held = (q.data?.positions ?? []).filter((p) => p.rawBalance !== "0");
  const total = held.reduce((s, p) => s + (p.referenceValue ?? 0), 0);
  const anyMissing = held.some((p) => p.referenceValue == null);

  return (
    <Panel kicker="Public onchain balances" title="Wallet positions" delay={100}
      actions={address && <button className={btnGhost} onClick={() => q.refetch()} disabled={q.isFetching} data-testid="button-refresh-positions"><RefreshIcon spinning={q.isFetching} />Refresh</button>}>
      {!address ? <Empty title="Connect to read positions" body="StockFlow reads public Base balances for catalogue stocks. Use Connect Wallet at the top right." />
        : q.isLoading ? <Skeleton rows={3} />
        : q.isError ? <ErrorBox message={`Could not read positions: ${errMsg(q.error)}`} onRetry={() => q.refetch()} />
        : (
          <div className="space-y-3">
            {q.data && q.data.failedReads > 0 && (
              <p role="status" className="rounded-lg border border-[hsl(var(--sf-ochre)/0.3)] bg-[hsl(var(--sf-ochre)/0.07)] px-3 py-2 text-xs text-[hsl(var(--sf-ochre))]" data-testid="text-partial-positions">
                Partial read: {q.data.failedReads} balance {q.data.failedReads === 1 ? "lookup" : "lookups"} failed. Totals below exclude them.
              </p>
            )}
            {held.length === 0 ? <Empty title={q.data?.failedReads ? "No positions found in successful reads" : "No catalogue stocks held"} body={q.data?.failedReads ? "Some lookups failed, so holdings cannot be ruled out. Refresh to retry." : "This wallet holds none of the listed tokenized stocks on Base Mainnet."} />
              : (
                <>
                  <div className="flex items-baseline justify-between rounded-xl bg-[hsl(var(--sf-ink))] px-4 py-3">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Reference value</span>
                    <span className="sf-display text-2xl text-[hsl(var(--sf-paper))]" data-testid="text-positions-total">{usd(total)}{anyMissing && <span className="ml-1 text-xs text-muted-foreground">+ unpriced</span>}</span>
                  </div>
                  <ul className="divide-y divide-border">
                    {held.map((p) => {
                      const s = bySym.get(p.address.toLowerCase());
                      return (
                        <li key={p.address} className="flex items-center gap-3 py-2.5" data-testid={`row-position-${p.address}`}>
                          {s ? <StockGlyph stock={s} /> : <StockGlyph stock={{ symbol: "?", iconUrl: null }} />}
                          <div className="min-w-0 flex-1">
                            <p className="font-mono text-sm font-semibold">{s?.symbol ?? truncateAddress(p.address)}</p>
                            <p className="font-mono text-[11px] text-muted-foreground">{p.tokenBalance} tokens{p.shareBalance != null ? ` · ${p.shareBalance} shares` : " · shares unavailable"}</p>
                          </div>
                          <p className="font-mono text-sm">{p.referenceValue != null ? usd(p.referenceValue) : <span className="text-muted-foreground">Unavailable</span>}</p>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            {q.data && <p className="font-mono text-[10px] text-muted-foreground">Block {q.data.blockNumber} · {when(q.data.fetchedAt)}</p>}
          </div>
        )}
    </Panel>
  );
}

function PolicyRow({ p, now, selected, onSelect, onEdit, onRevoke, onDelete }: { p: Policy; now: number; selected: boolean; onSelect: () => void; onEdit: () => void; onRevoke: () => void; onDelete: () => void }) {
  const st = policyState(p, now);
  const [confirm, setConfirm] = useState<"revoke" | "delete" | null>(null);
  return (
    <li className={`rounded-xl border p-4 transition-colors ${selected ? "border-[hsl(var(--sf-ochre)/0.55)] bg-[hsl(var(--sf-ochre)/0.05)]" : "border-border"}`} data-testid={`card-policy-${p.id}`}>
      <button onClick={onSelect} className="w-full text-left focus-visible:outline-none" aria-pressed={selected} data-testid={`button-select-policy-${p.id}`}>
        <div className="flex items-center justify-between gap-2">
          <span className="sf-display text-lg">{p.name}</span>
          <StatusTag status={st} />
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px] text-muted-foreground sm:grid-cols-4">
          <div><dt>Income</dt><dd className="text-foreground">{p.incomePct}%</dd></div>
          <div><dt>Per buy</dt><dd className="text-foreground">{usd(p.maxPerPurchase)}</dd></div>
          <div><dt>Per day</dt><dd className="text-foreground">{usd(p.dailyMax)}</dd></div>
          <div><dt>Expires</dt><dd className="text-foreground">{new Date(p.expiresAt).toLocaleDateString()}</dd></div>
        </dl>
        <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-secondary" aria-label="Weights">
          {p.allocations.map((a, i) => <span key={a.address} style={{ width: `${a.weight}%`, background: `hsl(${[36, 166, 12, 200, 290, 90][i % 6]} 60% 58%)` }} title={`${a.symbol} ${a.weight}%`} />)}
        </div>
        <p className="mt-1.5 font-mono text-[10px] text-muted-foreground">{p.allocations.map((a) => `${a.symbol} ${a.weight}%`).join(" · ")}</p>
      </button>
      <div className="mt-3 flex flex-wrap gap-2">
        <button className={btnGhost} onClick={onEdit} disabled={st === "revoked"} data-testid={`button-edit-policy-${p.id}`}>Edit</button>
        <button className={btnGhost} onClick={() => setConfirm("revoke")} disabled={st === "revoked"} data-testid={`button-revoke-policy-${p.id}`}>Revoke</button>
        <button className={btnDanger} onClick={() => setConfirm("delete")} data-testid={`button-delete-policy-${p.id}`}>Delete</button>
      </div>
      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent className="sf">
          <AlertDialogHeader>
            <AlertDialogTitle className="sf-display">{confirm === "delete" ? `Delete "${p.name}"?` : `Revoke "${p.name}"?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "delete" ? "The policy is removed from this browser. The audit history keeps a record that it was deleted." : "A revoked policy stays visible for reference but can no longer produce previews or be edited."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-confirm">Keep it</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-action" onClick={() => { if (confirm === "delete") onDelete(); else onRevoke(); setConfirm(null); }}
              className="bg-[hsl(var(--sf-clay))] text-[hsl(var(--sf-ink))] hover:bg-[hsl(var(--sf-clay)/0.85)]">
              {confirm === "delete" ? "Delete" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function L({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div><label htmlFor={id} className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</label>{children}</div>;
}

function PolicyEditor({ initial, stocks, onSave, onCancel }: { initial: Policy | null; stocks: StockflowStock[]; onSave: (p: Policy, isNew: boolean) => void; onCancel: () => void }) {
  const toDate = (t: number) => new Date(t - new Date(t).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const [name, setName] = useState(initial?.name ?? "");
  const [pct, setPct] = useState(String(initial?.incomePct ?? 10));
  const [perBuy, setPerBuy] = useState(String(initial?.maxPerPurchase ?? 25));
  const [daily, setDaily] = useState(String(initial?.dailyMax ?? 100));
  const [expiry, setExpiry] = useState(toDate(initial?.expiresAt ?? Date.now() + 30 * 86400e3));
  const [allocs, setAllocs] = useState<Allocation[]>(initial?.allocations ?? []);
  const [pick, setPick] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const available = stocks.filter((s) => !allocs.some((a) => a.address.toLowerCase() === s.address.toLowerCase()));
  const total = weightTotal(allocs);

  const add = () => {
    const s = stocks.find((x) => x.address === pick);
    if (!s) return;
    setAllocs([...allocs, { address: s.address, symbol: s.symbol, weight: 0 }]); setPick("");
  };
  const even = () => {
    if (!allocs.length) return;
    const base = Math.floor((100 / allocs.length) * 100) / 100;
    setAllocs(allocs.map((a, i) => ({ ...a, weight: i === allocs.length - 1 ? Math.round((100 - base * (allocs.length - 1)) * 100) / 100 : base })));
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const expiresAt = new Date(`${expiry}T23:59:59`).getTime();
    const draft = { name: name.trim(), incomePct: Number(pct), maxPerPurchase: Number(perBuy), dailyMax: Number(daily), expiresAt, allocations: allocs.map((a) => ({ ...a, weight: Number(a.weight) })) };
    const errs = validatePolicy(draft, Date.now());
    setErrors(errs);
    if (errs.length) return;
    const t = Date.now();
    onSave(initial ? { ...initial, ...draft, updatedAt: t } : { ...draft, id: uid(), status: "active", createdAt: t, updatedAt: t }, !initial);
  };

  return (
    <form onSubmit={submit} className="sf-rise space-y-4" noValidate aria-label={initial ? "Edit policy" : "New policy"}>
      <L id="pf-name" label="Policy name"><input id="pf-name" className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Payday core" data-testid="input-policy-name" /></L>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <L id="pf-pct" label="% of income"><input id="pf-pct" inputMode="decimal" className={field} value={pct} onChange={(e) => setPct(e.target.value)} data-testid="input-policy-pct" /></L>
        <L id="pf-buy" label="Max / purchase $"><input id="pf-buy" inputMode="decimal" className={field} value={perBuy} onChange={(e) => setPerBuy(e.target.value)} data-testid="input-policy-per-purchase" /></L>
        <L id="pf-day" label="Max / day $"><input id="pf-day" inputMode="decimal" className={field} value={daily} onChange={(e) => setDaily(e.target.value)} data-testid="input-policy-daily" /></L>
        <L id="pf-exp" label="Expires"><input id="pf-exp" type="date" className={field} value={expiry} onChange={(e) => setExpiry(e.target.value)} data-testid="input-policy-expiry" /></L>
      </div>

      <fieldset className="rounded-xl border border-border p-3">
        <legend className="px-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Asset allowlist and weights</legend>
        <div className="flex gap-2">
          <label htmlFor="pf-pick" className="sr-only">Add asset</label>
          <select id="pf-pick" className={field} value={pick} onChange={(e) => setPick(e.target.value)} disabled={!available.length} data-testid="select-policy-asset">
            <option value="">{stocks.length ? "Choose an asset to allow" : "Catalogue not loaded"}</option>
            {available.map((s) => <option key={s.address} value={s.address}>{s.symbol} — {s.name}</option>)}
          </select>
          <button type="button" className={btnGhost} onClick={add} disabled={!pick} data-testid="button-add-asset">Allow</button>
        </div>
        {allocs.length > 0 && (
          <ul className="mt-3 space-y-2">
            {allocs.map((a, i) => (
              <li key={a.address} className="flex items-center gap-2">
                <span className="w-16 font-mono text-sm">{a.symbol}</span>
                <label htmlFor={`pf-w-${i}`} className="sr-only">{a.symbol} weight</label>
                <input id={`pf-w-${i}`} inputMode="decimal" className={`${field} w-24`} value={String(a.weight)} onChange={(e) => setAllocs(allocs.map((x, j) => (j === i ? { ...x, weight: e.target.value as unknown as number } : x)))} data-testid={`input-weight-${a.symbol}`} />
                <span className="font-mono text-xs text-muted-foreground">%</span>
                <button type="button" aria-label={`Remove ${a.symbol}`} className={`${btnGhost} ml-auto`} onClick={() => setAllocs(allocs.filter((_, j) => j !== i))} data-testid={`button-remove-asset-${a.symbol}`}>Remove</button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex items-center justify-between">
          <span className={`font-mono text-xs ${Math.abs(total - 100) < 0.001 ? "text-[hsl(var(--sf-verdigris))]" : "text-[hsl(var(--sf-ochre))]"}`} data-testid="text-weight-total">Total {total} / 100</span>
          <button type="button" className={btnGhost} onClick={even} disabled={!allocs.length} data-testid="button-even-split">Even split</button>
        </div>
      </fieldset>

      {errors.length > 0 && (
        <ul role="alert" className="space-y-1 rounded-lg border border-[hsl(var(--sf-clay)/0.35)] bg-[hsl(var(--sf-clay)/0.07)] px-3 py-2 text-xs text-[hsl(var(--sf-clay))]">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={btnGhost} onClick={onCancel} data-testid="button-cancel-policy">Cancel</button>
        <button type="submit" className={btnPrimary} data-testid="button-save-policy">{initial ? "Save changes" : "Create policy"}</button>
      </div>
    </form>
  );
}

function PreviewPanel({ policy, stocks, catalogueReady, onPreview }: { policy: Policy | null; stocks: StockflowStock[]; catalogueReady: boolean; onPreview: (detail: string) => void }) {
  const [income, setIncome] = useState("");
  const [result, setResult] = useState<ReturnType<typeof buildPreview> | null>(null);
  useEffect(() => { setResult(null); }, [policy?.id, policy?.updatedAt, stocks, income]);

  const run = (e: React.FormEvent) => {
    e.preventDefault();
    if (!policy) return;
    const pv = buildPreview(policy, Number(income), stocks, Date.now());
    setResult(pv);
    if (!pv.blocked) onPreview(`${policy.name}: income ${usd(pv.income)} -> ${usd(pv.total)} reference allocation`);
  };

  return (
    <Panel kicker="Reference only · does not limit pilot trades" title="Allocation preview" delay={140}>
      {!policy ? <Empty title="Select a policy" body="Pick a policy on the left, enter an income amount you received, and see how the limits would shape it." />
        : (
          <div className="space-y-4">
            <form onSubmit={run} className="flex flex-wrap items-end gap-2">
              <div className="min-w-[160px] flex-1">
                <label htmlFor="pv-income" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Income received (USD) under "{policy.name}"</label>
                <input id="pv-income" inputMode="decimal" className={field} value={income} onChange={(e) => setIncome(e.target.value)} placeholder="1840.00" data-testid="input-preview-income" />
              </div>
              <button type="submit" className={btnPrimary} disabled={!catalogueReady} data-testid="button-run-preview">Preview</button>
            </form>
            {!catalogueReady && <p className="text-xs text-muted-foreground">Waiting for the catalogue before pricing a preview.</p>}
            {result?.blocked && <ErrorBox message={result.blocked} />}
            {result && !result.blocked && (
              <div className="sf-rise space-y-3" data-testid="preview-result">
                <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl bg-border font-mono text-xs">
                  {[["Income", usd(result.income)], [`${policy.incomePct}% share`, usd(result.budget)], ["After limits", usd(result.total)]].map(([k, v]) => (
                    <div key={k} className="bg-[hsl(var(--sf-ink))] p-3"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</p><p className="mt-1 text-base text-[hsl(var(--sf-paper))]">{v}</p></div>
                  ))}
                </div>
                {result.cappedByDaily && <p className="text-xs text-[hsl(var(--sf-ochre))]">Daily maximum of {usd(policy.dailyMax)} applied.</p>}
                <ul className="divide-y divide-border">
                  {result.lines.map((l) => (
                    <li key={l.address} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5" data-testid={`row-preview-${l.symbol}`}>
                      <span className="w-14 font-mono text-sm font-semibold">{l.symbol}</span>
                      <span className="font-mono text-xs text-muted-foreground">{l.weight}%</span>
                      <StatusTag status={l.status} />
                      {l.paused && <StatusTag status="paused" />}
                      <span className="ml-auto text-right font-mono text-sm">
                        {usd(l.amount)}
                        <span className="block text-[11px] text-muted-foreground">
                          {l.referenceShares != null ? `~${l.referenceShares.toFixed(6)} tokens at ${usd(l.price as number)}` : l.status === "stale" ? "NAV older than 24h — no token estimate" : "NAV unavailable — no token estimate"}
                        </span>
                      </span>
                      {l.cappedByPurchase && <p className="w-full text-[11px] text-[hsl(var(--sf-ochre))]">Capped at per-purchase maximum {usd(policy.maxPerPurchase)}.</p>}
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] leading-relaxed text-muted-foreground">Reference arithmetic only. Not a quote, not an order, and no funds move. Real fills would differ with market price, fees and availability.</p>
              </div>
            )}
          </div>
        )}
    </Panel>
  );
}

function AuditPanel({ audit, onClear }: { audit: AuditEntry[]; onClear: () => void }) {
  const tone: Record<AuditEntry["kind"], string> = { created: "sf-verdigris", edited: "sf-ochre", revoked: "sf-clay", deleted: "sf-clay", previewed: "sf-paper", cleared: "sf-paper" };
  return (
    <Panel kicker="This browser only" title="Audit history" delay={160}
      actions={audit.length > 0 && <button className={btnGhost} onClick={onClear} data-testid="button-clear-audit">Clear</button>}>
      {audit.length === 0 ? <Empty title="A quiet ledger" body="Every policy change and preview you run is recorded here, locally, with a timestamp." />
        : (
          <ol className="max-h-80 space-y-0 overflow-y-auto">
            {audit.map((a) => (
              <li key={a.id} className="grid grid-cols-[auto_1fr] gap-x-3 border-l border-border py-2 pl-4 relative" data-testid={`row-audit-${a.id}`}>
                <span className="absolute -left-[4px] top-3.5 h-2 w-2 rounded-full" style={{ background: `hsl(var(--${tone[a.kind]}))` }} />
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground w-20">{a.kind}</span>
                <span className="text-sm">{a.detail}<span className="block font-mono text-[10px] text-muted-foreground">{when(a.at)}</span></span>
              </li>
            ))}
          </ol>
        )}
    </Panel>
  );
}

/* ───────────── Base Sepolia sandbox ───────────── */
function Sandbox() {
  const sb = useStockflowSandbox();
  const [maxPer, setMaxPer] = useState("25");
  const [daily, setDaily] = useState("100");
  const [days, setDays] = useState("7");
  const [amount, setAmount] = useState("");

  const onSepolia = sb.chainId === SEPOLIA_ID;
  const s = sb.state;
  const expired = s ? s.expiresAt * 1000 <= Date.now() : false;

  return (
    <div className="space-y-6">
      <div className="sf-rise rounded-xl border border-[hsl(var(--sf-verdigris)/0.35)] bg-[hsl(var(--sf-verdigris)/0.07)] px-4 py-3 text-xs leading-relaxed text-secondary-foreground">
        <span className="font-mono uppercase tracking-wider text-[hsl(var(--sf-verdigris))]">Sandbox · Base Sepolia testnet</span>
        <p className="mt-1">A contract you deploy holds virtual <strong className="text-foreground">demoUSD</strong> and virtual <strong className="text-foreground">demo shares</strong> at a fixed illustrative 100 demoUSD per share. These are not real tokens, stocks or USDC and have no value. Transactions are real testnet transactions and need Sepolia ETH for gas.</p>
      </div>

      {!sb.isConnected ? (
        <Panel kicker="Sandbox" title="Connect a wallet to begin"><Empty title="No wallet" body="Connect with the button at the top right. The sandbox is deployed from, and owned by, your own wallet." /></Panel>
      ) : !onSepolia ? (
        <Panel kicker="Sandbox" title="Switch to Base Sepolia">
          <Empty title={`Connected to chain ${sb.chainId}`} body="The sandbox only runs on Base Sepolia (84532), kept apart from mainnet reference data." action={<button className={btnPrimary} onClick={() => sb.switchToTestnet()} disabled={sb.pending} data-testid="button-switch-testnet">{sb.pending ? "Switching…" : "Switch to Base Sepolia"}</button>} />
        </Panel>
      ) : !sb.contractAddress ? (
        <Panel kicker="Sandbox" title="Deploy your sandbox">
          <Empty title="Nothing deployed yet" body="Deploying creates a contract owned by your wallet, funded with 1,000 demoUSD and a default policy of 25 per buy, 100 per day, expiring in 7 days." action={<button className={btnPrimary} onClick={() => sb.deploy()} disabled={sb.pending} data-testid="button-deploy-sandbox">{sb.pending ? "Confirm in wallet…" : "Deploy sandbox"}</button>} />
        </Panel>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
          <Panel kicker="Sandbox contract" title="Virtual balances"
            actions={<button className={btnGhost} onClick={() => sb.refresh()} disabled={sb.pending} data-testid="button-refresh-sandbox"><RefreshIcon spinning={sb.pending} />Refresh</button>}>
            <a href={SEPOLIA_ADDR + sb.contractAddress} target="_blank" rel="noreferrer" className="font-mono text-xs text-[hsl(var(--sf-verdigris))] underline-offset-4 hover:underline" data-testid="link-sandbox-contract">{truncateAddress(sb.contractAddress)} on Sepolia BaseScan</a>
            {!s ? <div className="mt-4"><Skeleton rows={3} /></div> : (
              <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border font-mono text-xs">
                {[["demoUSD balance", s.balance], ["Demo shares", s.position], ["Spent today", s.spent], ["Max / buy", s.maxPerTrade], ["Max / day", s.dailyLimit], ["Expires", s.expiresAt ? when(s.expiresAt * 1000) : "—"]].map(([k, v]) => (
                  <div key={k} className="bg-[hsl(var(--sf-ink))] p-3"><dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{k}</dt><dd className="mt-1 text-sm text-[hsl(var(--sf-paper))]" data-testid={`text-sandbox-${k.replace(/\W+/g, "-").toLowerCase()}`}>{v}</dd></div>
                ))}
              </dl>
            )}
            {s && <div className="mt-3"><StatusTag status={!s.active ? "revoked" : expired ? "expired" : "active"} /></div>}
          </Panel>

          <div className="space-y-6">
            <Panel kicker="Onchain policy" title="Limits">
              <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); sb.savePolicy(maxPer, daily, Number(days)); }}>
                <div className="grid grid-cols-3 gap-3">
                  {([["sb-max", "Max / buy", maxPer, setMaxPer], ["sb-day", "Max / day", daily, setDaily], ["sb-days", "Days", days, setDays]] as const).map(([id, l, v, set]) => (
                    <div key={id}><label htmlFor={id} className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{l}</label><input id={id} inputMode="decimal" className={field} value={v} onChange={(e) => set(e.target.value)} data-testid={`input-${id}`} /></div>
                  ))}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  <button type="button" className={btnDanger} onClick={() => sb.revoke()} disabled={sb.pending || !s?.active} data-testid="button-revoke-sandbox">Revoke policy</button>
                  <button type="submit" className={btnPrimary} disabled={sb.pending || !(Number(maxPer) > 0 && Number(daily) >= Number(maxPer) && Number(days) > 0)} data-testid="button-save-sandbox-policy">Save policy</button>
                </div>
              </form>
            </Panel>
            <Panel kicker="Virtual purchase" title="Buy demo shares">
              <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); sb.buy(amount); }}>
                <div className="min-w-[140px] flex-1">
                  <label htmlFor="sb-amt" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Amount (demoUSD)</label>
                  <input id="sb-amt" inputMode="decimal" className={field} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="20" data-testid="input-sandbox-amount" />
                </div>
                <button type="submit" className={btnPrimary} disabled={sb.pending || !(Number(amount) > 0) || !s?.active || expired} data-testid="button-buy-sandbox">{sb.pending ? "Pending…" : "Buy demo shares"}</button>
              </form>
              {Number(amount) > 0 && <p className="mt-2 font-mono text-[11px] text-muted-foreground">= {(Number(amount) / 100).toFixed(4)} demo shares at the fixed 100 demoUSD illustration. The contract enforces your limits.</p>}
            </Panel>
          </div>
        </div>
      )}

      {sb.error && <ErrorBox message={sb.error} onRetry={sb.isConnected ? () => sb.refresh() : undefined} />}
      {sb.lastTx && (
        <p className="font-mono text-xs text-muted-foreground" data-testid="text-last-tx">
          Last transaction: <a className="text-[hsl(var(--sf-verdigris))] underline-offset-4 hover:underline" href={SEPOLIA_TX + sb.lastTx} target="_blank" rel="noreferrer" data-testid="link-last-tx">{truncateAddress(sb.lastTx)} on Sepolia BaseScan</a>
        </p>
      )}
    </div>
  );
}
