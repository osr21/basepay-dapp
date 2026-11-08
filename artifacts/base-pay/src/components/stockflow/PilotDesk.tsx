import { useEffect, useMemo, useState } from "react";
import { formatUnits, formatEther } from "viem";
import type { StockflowStock, StockflowTradeQuote } from "@workspace/api-client-react";
import { useStockflowTrading, BASESCAN_TX, BASESCAN_ADDR, type TradeSide, type StockflowTrading, type TxView } from "@/lib/useStockflowTrading";
import { STOCKFLOW_USDC } from "@/lib/stockflow-trade-contract";
import { truncateAddress } from "@/lib/wagmi";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Panel, Empty, ErrorBox, Skeleton, StockGlyph, btnPrimary, btnGhost, btnDanger, field, usd, when, errMsg } from "./atoms";
import { PilotAdmin } from "./PilotAdmin";
import { NetworkFees } from "./NetworkFees";
import { PaidNetworkFees, HistoricalNetworkFees } from "./PaidNetworkFees";

const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const fmt = (raw: string | bigint, d: number) => { const s = formatUnits(BigInt(raw), d); const [a, b = ""] = s.split("."); return b ? `${a}.${b.slice(0, 6)}` : a; };

function Addr({ a, label }: { a: string; label?: string }) {
  return <a href={`${BASESCAN_ADDR}${a}`} target="_blank" rel="noreferrer" title={a} className="font-mono text-foreground underline decoration-dotted underline-offset-2 hover:text-[hsl(var(--sf-ochre))]">{label ?? truncateAddress(a)}</a>;
}

function useTick(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!active) return; const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, [active]);
  return now;
}

export function PilotDesk({ stocks, catalogueReady }: { stocks: StockflowStock[]; catalogueReady: boolean }) {
  const t = useStockflowTrading(stocks);
  return (
    <div className="space-y-6">
      <div className="sf-rise grid gap-px overflow-hidden rounded-xl border border-[hsl(var(--sf-clay)/0.3)] bg-[hsl(var(--sf-clay)/0.25)] text-xs sm:grid-cols-2 lg:grid-cols-4" data-testid="text-pilot-disclosures">
        {[
          ["Real money", "Trades swap real USDC and tokenized stock on Base Mainnet through Aerodrome. EOA and EIP-7702 wallets only; contract-wallet trading is not supported in this pilot. Losses are possible."],
          ["Fees and gas", "Every approval, trade and revoke needs Base ETH for gas. Pool fees are included in the quote; no BasePay service fee is added to these pilot swaps. This is not gasless."],
          ["Not KYC", "Country is self-declared and operator-reviewed. That is not KYC and not legal clearance in your jurisdiction."],
          ["Budgets not enforced", "Local planning policies do not limit pilot trades. The server caps each quote at 100 USDC (buy input or sell quoted output); that is a per-quote pilot cap, not an onchain or autonomous budget."],
        ].map(([k, v]) => (
          <div key={k} className="min-w-0 bg-[hsl(var(--sf-ink))] p-3"><p className="font-mono text-[10px] uppercase tracking-wider text-[hsl(var(--sf-clay))]">{k}</p><p className="mt-1 text-secondary-foreground">{v}</p></div>
        ))}
      </div>
      <AccessPanel t={t} />
      {t.journalWarning && <JournalWarning text={t.journalWarning} hash={t.txs.find((x) => x.kind === "swap")?.hash ?? null} />}
      {t.error && <ErrorBox message={t.error} />}
      {t.notice && <p role="status" className="rounded-lg border border-[hsl(var(--sf-verdigris)/0.3)] bg-[hsl(var(--sf-verdigris)/0.07)] px-3 py-2 text-xs text-[hsl(var(--sf-verdigris))]" data-testid="text-pilot-notice">{t.notice}</p>}
      <PendingPanel t={t} />
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <TradeTicket t={t} stocks={stocks} catalogueReady={catalogueReady} />
        <div className="min-w-0 space-y-6">
          <HistoryPanel t={t} />
          <RevokePanel t={t} stocks={stocks} />
        </div>
      </div>
      {t.matches && t.session.data?.isAdmin && <PilotAdmin />}
    </div>
  );
}

function AccessPanel({ t }: { t: StockflowTrading }) {
  const s = t.session.data;
  const state = !t.address ? "Connect a wallet" : t.mismatch ? "Signed in as another wallet" : !t.matches ? "Not signed in" : !s?.enabled ? "Pilot disabled" : !s.approved ? "Not approved" : "Approved";
  const tone = t.canTrade ? "verdigris" : t.mismatch || (t.matches && !s?.approved) ? "clay" : "ochre";
  return (
    <Panel kicker="Approved wallets only" title="Pilot access" delay={40}
      actions={<>
        {t.address && !t.onMainnet && <button className={btnGhost} onClick={t.switchToMainnet} disabled={!!t.busy} data-testid="button-switch-mainnet">Switch to Base Mainnet</button>}
        {t.address && !t.matches && <button className={btnPrimary} onClick={t.signIn} disabled={!!t.busy} data-testid="button-pilot-signin">{t.busy === "Signing in" ? "Check wallet…" : t.mismatch ? "Sign in as connected wallet" : "Sign in with wallet"}</button>}
        {t.cookieWallet && <button className={btnGhost} onClick={t.signOut} disabled={!!t.busy} data-testid="button-pilot-signout">Sign out</button>}
      </>}>
      {t.session.isLoading ? <Skeleton rows={2} /> : t.session.isError ? <ErrorBox message={`Session check failed: ${errMsg(t.session.error)}`} onRetry={() => t.session.refetch()} /> : (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border font-mono text-[11px] md:grid-cols-4">
            {[
              ["Connected", t.address ? truncateAddress(t.address) : "None"],
              ["Signed-in cookie", t.cookieWallet ? truncateAddress(t.cookieWallet) : "None"],
              ["Network", t.chainId === 8453 ? "Base Mainnet" : `Chain ${t.chainId}`],
              ["Status", state],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0 bg-[hsl(var(--sf-ink))] p-3"><dt className="uppercase tracking-wider text-muted-foreground">{k}</dt><dd className={`mt-1 ${k === "Status" ? `text-[hsl(var(--sf-${tone}))]` : "text-[hsl(var(--sf-paper))]"}`} data-testid={`text-access-${k.toLowerCase().replace(/\W+/g, "-")}`}>{v}</dd></div>
            ))}
          </dl>
          {t.mismatch && <ErrorBox message="The pilot session belongs to a different wallet than the one connected. Trading is blocked until you sign in again with the connected wallet." />}
          {t.matches && s && !t.canTrade && <p className="text-xs text-muted-foreground" data-testid="text-access-reason">{s.reason}</p>}
          {t.matches && s?.participant && (
            <p className="font-mono text-[11px] text-muted-foreground" data-testid="text-access-grant">Declared country {s.participant.countryCode} · grant {s.participant.approved ? "active" : "revoked"} until {when(s.participant.expiresAt)}</p>
          )}
          {!t.address && <p className="text-xs text-muted-foreground">Connect a wallet, then sign a one-time message to start a pilot session. Signing costs nothing and moves no funds.</p>}
        </div>
      )}
    </Panel>
  );
}

function TradeTicket({ t, stocks, catalogueReady }: { t: StockflowTrading; stocks: StockflowStock[]; catalogueReady: boolean }) {
  const [stockAddr, setStockAddr] = useState("");
  const [side, setSide] = useState<TradeSide>("buy");
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState(50);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const stock = stocks.find((s) => s.address === stockAddr) ?? null;
  const tradable = stocks.filter((s) => s.pausedFeatures.length === 0);
  const q = t.quote;
  const now = useTick(!!q);
  const left = q ? Math.max(0, Math.floor((Date.parse(q.expiresAt) - now) / 1000)) : 0;
  const expired = !!q && left <= 0;
  const swap = t.txs.find((x) => x.kind === "swap");
  const changeInput = (fn: () => void) => { fn(); if (t.quote) t.clearTrade(); };
  const disabled = !t.canTrade || !t.onMainnet || !!t.busy;
  const feeEstimate = t.fees.status === "ready" ? t.fees.estimate : null;
  const nextApprovalFee = feeEstimate?.reset ?? feeEstimate?.approval;
  const approvalBlocked = !feeEstimate || feeEstimate.funding === "insufficient" || (!!nextApprovalFee && (nextApprovalFee.totalWei === null || feeEstimate.eth < nextApprovalFee.totalWei));
  const swapBlocked = !feeEstimate || !q || feeEstimate.allowance < BigInt(q.amountIn) || feeEstimate.swap.totalWei === null ||
    feeEstimate.eth < feeEstimate.swap.totalWei;

  useEffect(() => { if (stock) void t.refreshBalances(stock.address); }, [stock?.address, t.address]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Panel kicker="Base Mainnet · Aerodrome" title="Trade ticket" delay={80}>
      {!catalogueReady ? <Skeleton rows={4} /> : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0"><label htmlFor="tt-stock" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Stock</label>
              <select id="tt-stock" className={field} value={stockAddr} onChange={(e) => changeInput(() => setStockAddr(e.target.value))} data-testid="select-trade-stock">
                <option value="">Choose…</option>
                {tradable.map((s) => <option key={s.address} value={s.address}>{s.symbol} · {s.name}</option>)}
              </select></div>
            <div><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Direction</span>
              <div className="grid grid-cols-2 rounded-lg border border-border p-0.5" role="radiogroup">
                {(["buy", "sell"] as const).map((k) => (
                  <button key={k} role="radio" aria-checked={side === k} onClick={() => changeInput(() => { setSide(k); setAmount(""); })} data-testid={`button-side-${k}`}
                    className={`rounded-md py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors ${side === k ? (k === "buy" ? "bg-[hsl(var(--sf-verdigris))] text-[hsl(var(--sf-ink))]" : "bg-[hsl(var(--sf-clay))] text-[hsl(var(--sf-ink))]") : "text-muted-foreground hover:text-foreground"}`}>{k}</button>
                ))}
              </div></div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <div className="min-w-0"><label htmlFor="tt-amt" className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{side === "buy" ? "Spend USDC" : `Sell ${stock?.symbol ?? "stock"} tokens`}</label>
              <input id="tt-amt" inputMode="decimal" className={field} value={amount} onChange={(e) => changeInput(() => setAmount(e.target.value))} placeholder={side === "buy" ? "25.00" : "0.05"} data-testid="input-trade-amount" /></div>
            <div><span className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Max slippage</span>
              <div className="flex gap-1">{[10, 25, 50, 100].map((b) => (
                <button key={b} onClick={() => changeInput(() => setSlip(b))} aria-pressed={slip === b} data-testid={`button-slippage-${b}`}
                  className={`rounded-md border px-2 py-2 font-mono text-[11px] ${slip === b ? "border-[hsl(var(--sf-ochre))] text-[hsl(var(--sf-ochre))]" : "border-border text-muted-foreground"}`}>{pct(b)}</button>
              ))}</div></div>
          </div>
          {t.balances && t.address && (
            <p className="font-mono text-[11px] text-muted-foreground" data-testid="text-trade-balances">
              Wallet: {fmt(t.balances.usdc, 6)} USDC · {formatEther(t.balances.eth).slice(0, 9)} ETH for gas
              {stock && t.balances.stock != null && t.balances.stockAddress === stock.address ? ` · ${fmt(t.balances.stock, stock.decimals)} ${stock.symbol}` : ""}
              {t.balances.eth === 0n && <span className="block text-[hsl(var(--sf-clay))]">No ETH: you cannot pay gas for approval or trade.</span>}
            </p>
          )}
          {t.balanceError && <p role="alert" className="font-mono text-[11px] text-[hsl(var(--sf-clay))]" data-testid="text-balance-error">{t.balanceError}</p>}
          {stock && <p className="font-mono text-[10px] text-muted-foreground">Reference NAV {stock.referencePrice != null ? usd(stock.referencePrice) : "unavailable"} per share. Reference only; execution price comes from the pool quote below.</p>}
          <button className={`${btnPrimary} w-full`} disabled={disabled || !stock || !amount} onClick={() => stock && t.requestQuote(stock.address, side, amount, slip)} data-testid="button-get-quote">
            {t.busy === "Requesting quote" ? "Quoting…" : q ? "Request fresh quote" : "1 · Get quote"}
          </button>
          {!t.canTrade && <p className="text-xs text-muted-foreground">Quoting and trading unlock once the connected wallet is signed in and approved by an operator.</p>}

          {q && stock && <QuoteCard q={q} stock={stock} left={left} />}
          {q && !swap && <NetworkFees state={t.fees} refresh={() => void t.refreshFees()} disabled={disabled || expired} />}
          {q && expired && !swap && <ErrorBox message="This quote expired. Request a fresh quote and review the new numbers before continuing." />}

          {q && !expired && !swap && (
            <div className="grid gap-2 sm:grid-cols-2">
              <button className={btnGhost} disabled={disabled || approvalBlocked} onClick={t.approveExact} data-testid="button-approve-exact">
                {t.busy === "Approving exact amount" ? "Approving…" : `2 · Approve exactly ${fmt(q.amountIn, q.decimalsIn)} ${q.side === "buy" ? "USDC" : q.symbol}`}
              </button>
              <button className={btnPrimary} disabled={disabled} onClick={() => { setAck(false); setConfirmOpen(true); void t.refreshFees(); }} data-testid="button-open-confirm-trade">3 · Review and confirm</button>
            </div>
          )}
          {t.prepared && !swap && <p className="font-mono text-[10px] text-muted-foreground" data-testid="text-prepared">Prepared: allowance {fmt(t.prepared.allowance, q?.decimalsIn ?? 6)} · balance {fmt(t.prepared.balance, q?.decimalsIn ?? 6)} · {t.prepared.approvalRequired ? "approval required" : "approval sufficient"} · server simulation {t.prepared.simulated ? "passed" : "not passed"}</p>}
          {t.txs.length > 0 && <TxList txs={t.txs} />}
          {swap && (
            <div className={`rounded-xl border p-4 text-sm ${t.tradeDone === "success" ? "border-[hsl(var(--sf-verdigris)/0.4)] text-[hsl(var(--sf-verdigris))]" : t.tradeDone === "reverted" || t.tradeDone === "replaced" ? "border-[hsl(var(--sf-clay)/0.4)] text-[hsl(var(--sf-clay))]" : "border-[hsl(var(--sf-ochre)/0.4)] text-[hsl(var(--sf-ochre))]"}`} data-testid="text-trade-outcome">
              {t.tradeDone === "success" ? "The server verified the exact quoted swap under its mined hash and Base's safe block has passed it." : t.tradeDone === "reverted" ? "Swap reverted onchain. No tokens moved; gas was spent." : t.tradeDone === "cancelled" ? "Your wallet cancellation is safe-confirmed. This was not a stock trade. Nothing was resent." : t.tradeDone === "changed" ? "A different transaction used this swap's nonce. It is not counted as a stock trade. Check its hash for what it did; nothing was resent." : t.tradeDone === "replaced" ? "Wallet replacement observed. The server is verifying the mined transaction and waiting for Base's safe block. It is not yet a confirmed stock trade and will not be resent." : "Swap submitted. Waiting for server verification and Base's safe block — do not resend."}
              {t.tradeDone && <button className={`${btnGhost} ml-3`} onClick={t.clearTrade} data-testid="button-new-trade">New trade</button>}
            </div>
          )}
        </div>
      )}
      <AlertDialog open={confirmOpen && !!q} onOpenChange={setConfirmOpen}>
        <AlertDialogContent className="sf max-h-[90dvh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="sf-display">Confirm real-money trade</AlertDialogTitle>
            <AlertDialogDescription>Your wallet will be asked to sign an exactInputSingle call to the fixed Aerodrome router, built locally from the quote below. Gas is paid in ETH.</AlertDialogDescription>
          </AlertDialogHeader>
          {q && stock && <QuoteCard q={q} stock={stock} left={left} />}
          <dl className="grid grid-cols-2 gap-2 rounded-lg border border-border p-3 font-mono text-[11px]" data-testid="text-confirm-balances">
            <div><dt className="text-muted-foreground">USDC balance (fresh read)</dt><dd>{t.balances ? fmt(t.balances.usdc, 6) : "reading…"}</dd></div>
            <div><dt className="text-muted-foreground">{q?.symbol ?? "Stock"} balance</dt><dd>{t.balances?.stock != null && stock ? fmt(t.balances.stock, stock.decimals) : "reading…"}</dd></div>
            <div><dt className="text-muted-foreground">ETH for gas</dt><dd>{t.balances ? formatEther(t.balances.eth).slice(0, 10) : "reading…"}</dd></div>
          </dl>
          <NetworkFees state={t.fees} refresh={() => void t.refreshFees()} disabled={disabled || expired} />
          <label className="flex items-start gap-2 text-xs text-secondary-foreground">
            <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="checkbox-confirm-real-money" />
            <span>I understand this swaps real funds on Base Mainnet, may fill as low as the minimum output, and is not limited by my local planning budgets.</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-trade">Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={!ack || expired || disabled || swapBlocked} onClick={() => { setConfirmOpen(false); void t.confirmTrade(); }} data-testid="button-confirm-trade"
              className="bg-[hsl(var(--sf-ochre))] text-[hsl(var(--sf-ink))] hover:bg-[hsl(var(--sf-ochre)/0.85)]">Sign trade</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

function QuoteCard({ q, stock, left }: { q: StockflowTradeQuote; stock: StockflowStock; left: number }) {
  const inSym = q.side === "buy" ? "USDC" : q.symbol, outSym = q.side === "buy" ? q.symbol : "USDC";
  const rows: [string, React.ReactNode][] = [
    ["You send", `${fmt(q.amountIn, q.decimalsIn)} ${inSym}`],
    ["Expected", `${fmt(q.amountOut, q.decimalsOut)} ${outSym}`],
    ["Minimum out", `${fmt(q.minimumOut, q.decimalsOut)} ${outSym}`],
    ["Slippage", pct(q.slippageBps)],
    ["Price impact", <span className={q.priceImpactBps > 100 ? "text-[hsl(var(--sf-clay))]" : ""}>{pct(q.priceImpactBps)}</span>],
    ["Expires in", <span className={left <= 15 ? "text-[hsl(var(--sf-clay))]" : ""} data-testid="text-quote-countdown">{left > 0 ? `${left}s` : "Expired"}</span>],
    ["Pool", <Addr a={q.pool} />],
    ["Router", <Addr a={q.router} />],
    ["Recipient", <Addr a={q.wallet} />],
    ["Quote block", q.blockNumber],
  ];
  return (
    <div className="sf-rise min-w-0 rounded-xl border border-[hsl(var(--sf-ochre)/0.3)] bg-[hsl(var(--sf-ink))] p-4" data-testid="card-quote">
      <div className="mb-3 flex items-center gap-2"><StockGlyph stock={stock} /><span className="sf-display text-lg text-[hsl(var(--sf-paper))]">{q.side === "buy" ? "Buy" : "Sell"} {q.symbol}</span></div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-[11px]">
        {rows.map(([k, v]) => <div key={k} className="min-w-0"><dt className="uppercase tracking-wider text-muted-foreground">{k}</dt><dd className="mt-0.5 text-[hsl(var(--sf-paper))]">{v}</dd></div>)}
      </dl>
      <p className="mt-3 text-[10px] text-muted-foreground">Execution quote from the pool. Separate from reference NAV ({stock.referencePrice != null ? usd(stock.referencePrice) : "unavailable"}).</p>
    </div>
  );
}

function JournalWarning({ text, hash }: { text: string; hash: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="alert" className="rounded-xl border-2 border-[hsl(var(--sf-clay))] bg-[hsl(var(--sf-clay)/0.12)] p-4 text-sm text-[hsl(var(--sf-clay))]" data-testid="alert-journal-failed">
      <p className="font-semibold">Swap hash NOT saved in this browser</p>
      <p className="mt-1 text-xs">{text}</p>
      {hash && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="min-w-0 break-all rounded bg-[hsl(var(--sf-ink))] px-2 py-1 font-mono text-[11px] text-[hsl(var(--sf-paper))]" data-testid="text-unsaved-hash">{hash}</code>
          <button className={btnDanger} onClick={() => { void navigator.clipboard?.writeText(hash).then(() => setCopied(true)); }} data-testid="button-copy-hash">{copied ? "Copied" : "Copy hash"}</button>
        </div>
      )}
    </div>
  );
}

function TxList({ txs }: { txs: TxView[] }) {
  const label = { reset: "Allowance reset to 0", approve: "Exact approval", swap: "Swap", revoke: "Revoke allowance" } as const;
  return (
    <ul className="space-y-1.5" data-testid="list-transactions">
      {txs.map((x) => (
        <li key={x.hash} className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2 font-mono text-[11px]">
          <span className="text-foreground">{label[x.kind]}</span>
          <span className={x.status === "success" ? "text-[hsl(var(--sf-verdigris))]" : x.status === "reverted" ? "text-[hsl(var(--sf-clay))]" : "text-[hsl(var(--sf-ochre))]"}>{x.status === "pending" ? "awaiting receipt" : x.status === "replaced" ? "replaced in wallet: see verified history" : x.status === "success" ? "receipt included (success)" : x.status}</span>
          {x.replacement && <a className="underline decoration-dotted text-[hsl(var(--sf-clay))]" href={`${BASESCAN_TX}${x.replacement}`} target="_blank" rel="noreferrer">replacement {truncateAddress(x.replacement)}</a>}
          <a className="ml-auto underline decoration-dotted" href={`${BASESCAN_TX}${x.hash}`} target="_blank" rel="noreferrer" data-testid={`link-tx-${x.hash}`}>{truncateAddress(x.hash)} on Basescan</a>
          <PaidNetworkFees reviewed={x.reviewedFee} actual={x.actualFee} pending={x.status === "pending"} />
        </li>
      ))}
    </ul>
  );
}

function PendingPanel({ t }: { t: StockflowTrading }) {
  if (!t.pending.length) return null;
  return (
    <div className="sf-rise space-y-2 rounded-xl border border-[hsl(var(--sf-ochre)/0.4)] bg-[hsl(var(--sf-ochre)/0.06)] p-4" data-testid="panel-pending-trades">
      <p className="text-sm text-[hsl(var(--sf-ochre))]">Submitted swaps awaiting final verification. Recovery only checks history; it never resends. {t.matches ? "" : "Sign in with this wallet to record them, even if pilot access was revoked."}</p>
      {t.pending.map((p) => (
        <div key={p.hash} className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span>{p.side} {p.symbol}</span>
          <span className="text-muted-foreground">swap receipt: {p.receipt === "unknown" ? "onchain status unknown" : p.receipt}</span>
          {(p.replacementHashes ?? (p.replacedBy ? [p.replacedBy] : [])).map(hash => <a key={hash} className="text-[hsl(var(--sf-clay))] underline decoration-dotted" href={`${BASESCAN_TX}${hash}`} target="_blank" rel="noreferrer">replacement {truncateAddress(hash)}</a>)}
          {p.recordError && <span className="text-[hsl(var(--sf-clay))]">history recording failed: {p.recordError}</span>}
          <a className="underline decoration-dotted" href={`${BASESCAN_TX}${p.hash}`} target="_blank" rel="noreferrer">{truncateAddress(p.hash)}</a>
          <span className="ml-auto flex gap-2">
            <button className={btnGhost} onClick={t.recover} disabled={!t.matches || !!t.busy} data-testid={`button-retry-record-${p.hash}`}>Retry recording</button>
            <button className={btnGhost} onClick={() => t.dismissPending(p.hash)} data-testid={`button-dismiss-pending-${p.hash}`}>Dismiss</button>
          </span>
        </div>
      ))}
    </div>
  );
}

function HistoryPanel({ t }: { t: StockflowTrading }) {
  const h = t.history;
  return (
    <Panel kicker="Chain-verified by server" title="Pilot trade history" delay={100}>
      {!t.matches ? <Empty title="Sign in to view history" body="History is tied to your pilot session and verified against Base receipts." />
        : h.isLoading ? <Skeleton rows={3} />
        : h.isError ? <ErrorBox message={`History unavailable: ${errMsg(h.error)}`} onRetry={() => h.refetch()} />
        : !h.data?.length ? <Empty title="No pilot trades yet" body="Recorded swaps appear here once their transaction hash is verified." />
        : (<>
          <p className="mb-2 text-[10px] text-muted-foreground">Entries stay pending until Base's safe block passes the transaction, which can take minutes after the receipt is included.</p>
          <ul className="max-h-80 divide-y divide-border overflow-y-auto">
            {h.data.map((r) => (
              <li key={r.hash} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5" data-testid={`row-trade-${r.hash}`}>
                <span className="font-mono text-sm font-semibold">{r.side === "buy" ? "Buy" : "Sell"} {r.symbol}</span>
                <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase ${r.status === "confirmed" ? "border-[hsl(var(--sf-verdigris)/0.35)] text-[hsl(var(--sf-verdigris))]" : r.status !== "pending" ? "border-[hsl(var(--sf-clay)/0.35)] text-[hsl(var(--sf-clay))]" : "border-[hsl(var(--sf-ochre)/0.35)] text-[hsl(var(--sf-ochre))]"}`}>{r.status === "confirmed" ? "safe-confirmed" : r.status === "pending" ? "awaiting verification / safe block" : r.status}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">{when(r.createdAt)}</span>
                <p className="w-full font-mono text-[11px] text-muted-foreground">
                  {r.status === "cancelled" || r.status === "changed" ? "Not a stock trade" : `${fmt(r.amountIn, r.decimalsIn)} quoted input`}{r.amountOut != null ? ` → ${fmt(r.amountOut, r.decimalsOut)} out` : ""} · <a className="underline decoration-dotted" href={`${BASESCAN_TX}${r.hash}`} target="_blank" rel="noreferrer">mined / tracked hash</a>
                  {r.originalHash !== r.hash && <> · <a className="underline decoration-dotted" href={`${BASESCAN_TX}${r.originalHash}`} target="_blank" rel="noreferrer">original hash</a></>}
                  {r.replacementHashes?.filter(hash => hash !== r.hash).map(hash => <a key={hash} className="ml-2 underline decoration-dotted" href={`${BASESCAN_TX}${hash}`} target="_blank" rel="noreferrer">replacement {truncateAddress(hash)}</a>)}
                </p>
                <HistoricalNetworkFees reviewed={r.reviewedSwapFee} actual={r.networkFees} nonSwap={r.status === "cancelled" || r.status === "changed"} />
              </li>
            ))}
          </ul></>
        )}
    </Panel>
  );
}

function RevokePanel({ t, stocks }: { t: StockflowTrading; stocks: StockflowStock[] }) {
  const [token, setToken] = useState<string>(STOCKFLOW_USDC);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const opts = useMemo(() => [{ address: STOCKFLOW_USDC as string, symbol: "USDC", decimals: 6 }, ...stocks.map((s) => ({ address: s.address, symbol: s.symbol, decimals: s.decimals }))], [stocks]);
  const sel = opts.find((o) => o.address === token) ?? opts[0];
  const read = () => { setReadErr(null); setAllowance(null); t.readAllowance(token).then(setAllowance).catch((e) => setReadErr(errMsg(e))); };
  useEffect(() => { if (t.address) read(); else setAllowance(null); }, [token, t.address]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Panel kicker="Works without pilot access" title="Revoke router allowance" delay={120}>
      {!t.address ? <Empty title="Connect a wallet" body="Check and zero the Aerodrome router allowance for USDC or any catalogue stock." /> : (
        <div className="space-y-3">
          <select className={field} value={token} onChange={(e) => setToken(e.target.value)} aria-label="Token" data-testid="select-revoke-token">
            {opts.map((o) => <option key={o.address} value={o.address}>{o.symbol}</option>)}
          </select>
          <p className="font-mono text-[11px] text-muted-foreground" data-testid="text-router-allowance">
            Router <Addr a={"0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F"} /> may spend: {readErr ? <span className="text-[hsl(var(--sf-clay))]">{readErr}</span> : allowance == null ? "reading…" : `${fmt(allowance, sel.decimals)} ${sel.symbol}`}
          </p>
          <button className={btnDanger} disabled={!!t.busy || allowance === 0n} onClick={() => t.revokeAllowance(token, read)} data-testid="button-revoke-allowance">
            {t.busy === "Revoking router allowance" ? "Revoking…" : "Set allowance to 0"}
          </button>
          <p className="text-[10px] text-muted-foreground">Sends approve(router, 0) on Base Mainnet. Requires ETH for gas.</p>
        </div>
      )}
    </Panel>
  );
}
