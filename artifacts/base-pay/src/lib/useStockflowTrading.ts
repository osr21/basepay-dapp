import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useChainId, useConfig, useSwitchChain } from "wagmi";
import { getWalletClient } from "wagmi/actions";
import { useQueryClient } from "@tanstack/react-query";
import { createPublicClient, http, parseUnits, type Address, type Hash } from "viem";
import { base } from "viem/chains";
import { publicActionsL2 } from "viem/op-stack";
import {
  useGetStockflowPilotSession, getGetStockflowPilotSessionQueryKey,
  useListStockflowTradeHistory, getListStockflowTradeHistoryQueryKey, getGetStockflowPositionsQueryKey,
  getStockflowPilotSession, createStockflowPilotChallenge, authenticateStockflowPilot, logoutStockflowPilot,
  createStockflowTradeQuote, prepareStockflowTrade, recordStockflowTrade,
} from "@workspace/api-client-react";
import type { StockflowStock, StockflowTradeQuote, PrepareStockflowTrade200 } from "@workspace/api-client-react";
import { STOCKFLOW_ROUTER, STOCKFLOW_USDC, stockflowErc20Abi, stockflowSwapAbi, validatedTradeParams } from "@/lib/stockflow-trade-contract";
import { loadPending, upsertPending, removePending, replacementHashes, withReplacement, type PendingTrade } from "@/lib/stockflow-pending";
import { DATA_SUFFIX } from "@/lib/wagmi";
import { estimateTradeNetworkFees, requireTransactionFunds, readActualTransactionFee, serializeFee, type TransactionFee, type NetworkFeeState } from "@/lib/stockflow-network-fees";

export const MAINNET_ID = 8453;
export const BASESCAN_TX = "https://basescan.org/tx/";
export const BASESCAN_ADDR = "https://basescan.org/address/";
const client = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") }).extend(publicActionsL2());
const lower = (a?: string | null) => (a ?? "").toLowerCase();
const message = (e: unknown) => {
  const m = e instanceof Error ? (e as Error & { shortMessage?: string }).shortMessage ?? e.message : "Request failed";
  return m.length > 600 ? m.slice(0, 600) : m;
};

export type TradeSide = "buy" | "sell";
export type TxView = { kind: "reset" | "approve" | "swap" | "revoke"; hash: Hash; status: "pending" | "success" | "reverted" | "replaced"; replacement?: Hash; reviewedFee?: TransactionFee | null; actualFee?: TransactionFee };
export type Balances = { eth: bigint; usdc: bigint; stock: bigint | null; stockAddress: string | null };

/** Parse a decimal amount into raw token units (USDC 6dp for buys, stock decimals for sells). */
export function toRaw(value: string, decimals: number) {
  const v = value.trim();
  if (!new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(v)) throw new Error(`Enter a positive amount with at most ${decimals} decimals.`);
  const raw = parseUnits(v, decimals);
  if (raw <= 0n) throw new Error("Amount must be greater than zero.");
  return raw;
}

export function useStockflowTrading(catalogue: StockflowStock[]) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const config = useConfig();
  const qc = useQueryClient();
  const { switchChainAsync } = useSwitchChain();

  // Live refs, re-checked after every await.
  const addrRef = useRef(lower(address)); addrRef.current = lower(address);
  const chainRef = useRef(chainId); chainRef.current = chainId;
  const catRef = useRef(catalogue); catRef.current = catalogue;
  const lock = useRef(false);
  const generation = useRef(0);
  const submittedQuotes = useRef(new Set<string>());

  const session = useGetStockflowPilotSession({ query: { queryKey: getGetStockflowPilotSessionQueryKey(), refetchInterval: 30_000 } });
  const s = session.data;
  const cookieWallet = s?.authenticated ? lower(s.address) : "";
  const matches = !!address && !!cookieWallet && cookieWallet === lower(address);
  const mismatch = !!address && !!cookieWallet && cookieWallet !== lower(address);
  const canTrade = matches && !!s?.enabled && !!s?.approved;
  const historyKey = [...getListStockflowTradeHistoryQueryKey(), lower(address)] as const;
  const history = useListStockflowTradeHistory({ query: { queryKey: historyKey, enabled: matches, refetchInterval: 10_000 } });

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quote, setQuote] = useState<StockflowTradeQuote | null>(null);
  const [prepared, setPrepared] = useState<PrepareStockflowTrade200 | null>(null);
  const [txs, setTxs] = useState<TxView[]>([]);
  const [tradeDone, setTradeDone] = useState<"success" | "reverted" | "replaced" | "cancelled" | "changed" | null>(null);
  const [journalWarning, setJournalWarning] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingTrade[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [fees, setFees] = useState<NetworkFeeState>({ status: "idle" });
  const feeRequest = useRef(0);
  const quoteRef = useRef(quote); quoteRef.current = quote;

  const clearTrade = useCallback(() => { feeRequest.current++; quoteRef.current = null; setFees({ status: "idle" }); setQuote(null); setPrepared(null); setTxs([]); setTradeDone(null); setJournalWarning(null); }, []);

  // Account or chain switch: invalidate every in-flight operation and drop all quote state.
  useEffect(() => {
    generation.current++;
    clearTrade(); setError(null); setNotice(null); setBusy(null); setBalances(null); setBalanceError(null); lock.current = false;
    try { setPending(address ? loadPending(address) : []); }
    catch (e) { setPending([]); setError(message(e)); }
  }, [address, chainId, clearTrade]);

  const liveStock = (stockAddress: string) => {
    const st = catRef.current.find((x) => lower(x.address) === lower(stockAddress));
    if (!st) throw new Error("Stock is no longer in the live catalogue.");
    if (st.pausedFeatures.length) throw new Error(`${st.symbol} is paused by the issuer (${st.pausedFeatures.join(", ")}).`);
    return st;
  };
  const guard = (owner: string, gen: number) => {
    if (gen !== generation.current || addrRef.current !== owner) throw new Error("Connected account or network changed. Operation stopped; nothing further was sent.");
  };
  const freshAccess = async (owner: string, gen: number) => {
    const live = await getStockflowPilotSession();
    guard(owner, gen);
    qc.setQueryData(getGetStockflowPilotSessionQueryKey(), live);
    if (!live.authenticated || lower(live.address) !== owner) throw new Error("Pilot sign-in does not match the connected wallet. Sign in again.");
    if (!live.enabled || !live.approved) throw new Error(`Pilot access unavailable: ${live.reason}`);
    if (live.participant && Date.parse(live.participant.expiresAt) <= Date.now()) throw new Error("Pilot grant has expired.");
  };
  const mainnetWallet = async (owner: string, gen: number) => {
    if (chainRef.current !== MAINNET_ID) throw new Error("Switch to Base Mainnet with the Switch button first.");
    const w = await getWalletClient(config, { chainId: MAINNET_ID, account: owner as Address });
    guard(owner, gen);
    if (lower(w.account.address) !== owner) throw new Error("Wallet account changed.");
    if ((await w.getChainId()) !== MAINNET_ID) throw new Error("Wallet is not on Base Mainnet.");
    guard(owner, gen);
    return w;
  };

  // Immediately before every write: fixed account, fresh access, unexpired quote, wallet actually on 8453.
  const preWrite = async (owner: string, gen: number, w: { getChainId: () => Promise<number> }, q: StockflowTradeQuote | null) => {
    await freshAccess(owner, gen);
    if (q) validatedTradeParams(q, owner as Address, liveStock(q.stockAddress));
    if ((await w.getChainId()) !== MAINNET_ID) throw new Error("Wallet is not on Base Mainnet.");
    guard(owner, gen);
    if (q) validatedTradeParams(q, owner as Address, liveStock(q.stockAddress));
  };

  const run = useCallback(async (label: string, fn: (owner: string, gen: number) => Promise<void>) => {
    if (lock.current) return; // synchronous lock: one wallet operation at a time
    const owner = addrRef.current;
    if (!owner) { setError("Connect a wallet first."); return; }
    lock.current = true;
    const gen = generation.current;
    setBusy(label); setError(null); setNotice(null);
    try { await fn(owner, gen); }
    catch (e) { if (gen === generation.current) setError(message(e)); }
    finally { if (gen === generation.current) { setBusy(null); lock.current = false; } }
  }, []);

  const refreshBalances = useCallback(async (stockAddress?: string | null) => {
    const owner = addrRef.current as Address;
    if (!owner) return;
    const gen = generation.current;
    setBalances(null); setBalanceError(null);
    try {
    const [eth, usdc, stock] = await Promise.all([
      client.getBalance({ address: owner }),
      client.readContract({ address: STOCKFLOW_USDC, abi: stockflowErc20Abi, functionName: "balanceOf", args: [owner] }),
      stockAddress ? client.readContract({ address: stockAddress as Address, abi: stockflowErc20Abi, functionName: "balanceOf", args: [owner] }) : Promise.resolve(null),
    ]);
    if (gen === generation.current && addrRef.current === owner) setBalances({ eth, usdc, stock, stockAddress: stockAddress ?? null });
    } catch (e) {
      if (gen === generation.current) setBalanceError(`Balance read failed: ${message(e)}`);
    }
  }, []);

  const afterTrade = (owner: string) => {
    void qc.invalidateQueries({ queryKey: getListStockflowTradeHistoryQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetStockflowPositionsQueryKey(owner) });
    void qc.invalidateQueries({ queryKey: getGetStockflowPositionsQueryKey(address ?? "") });
  };

  const pushTx = (gen: number, t: TxView) => { if (gen === generation.current) setTxs((l) => [...l.filter((x) => x.hash !== t.hash), t]); };
  // A receipt is only trusted for the exact hash we submitted. A wallet speed-up/cancel
  // returns the replacement's receipt; that never counts as the original succeeding.
  const waitTx = async (gen: number, t: TxView, onReplacement?: (hash: Hash) => void): Promise<{ status: "success" | "reverted" } | { status: "replaced"; replacement: Hash }> => {
    pushTx(gen, t);
    const r = await client.waitForTransactionReceipt({
      hash: t.hash, timeout: 240_000,
      onReplaced: ({ transaction }) => { onReplacement?.(transaction.hash); },
    });
    if (lower(r.transactionHash) !== lower(t.hash)) {
      onReplacement?.(r.transactionHash);
      pushTx(gen, { ...t, status: "replaced", replacement: r.transactionHash });
      return { status: "replaced", replacement: r.transactionHash };
    }
    const status = r.status === "success" ? "success" : "reverted";
    pushTx(gen, { ...t, status });
    // A fee read failure must not turn an included transaction into a failed
    // trade. Reverted transactions also pay network fees.
    const actualFee = await readActualTransactionFee(client, t.hash, r.blockHash);
    pushTx(gen, { ...t, status, actualFee });
    return { status };
  };
  const waitOk = async (gen: number, t: TxView) => {
    const r = await waitTx(gen, t);
    if (r.status === "replaced") throw new Error(`Transaction ${t.hash} was replaced or cancelled in the wallet by ${r.replacement}. Its outcome is unknown; nothing further was sent.`);
    return r.status === "success";
  };

  /* ── sign-in ── */
  const signIn = () => run("Signing in", async (owner, gen) => {
    const ch = await createStockflowPilotChallenge({ address: owner });
    guard(owner, gen);
    const w = await getWalletClient(config, { account: owner as Address });
    guard(owner, gen);
    const signature = await w.signMessage({ account: w.account, message: ch.message }); // exactly the server message
    guard(owner, gen);
    const next = await authenticateStockflowPilot({ address: owner, challengeId: ch.id, signature });
    guard(owner, gen);
    qc.setQueryData(getGetStockflowPilotSessionQueryKey(), next);
    void qc.invalidateQueries({ queryKey: getListStockflowTradeHistoryQueryKey() });
  });
  const signOut = () => run("Signing out", async () => {
    await logoutStockflowPilot();
    clearTrade();
    await qc.invalidateQueries({ queryKey: getGetStockflowPilotSessionQueryKey() });
    qc.removeQueries({ queryKey: getListStockflowTradeHistoryQueryKey() });
  });
  const switchToMainnet = () => run("Switching network", async () => { await switchChainAsync({ chainId: MAINNET_ID }); });

  /* ── quote ── */
  const requestQuote = (stockAddress: string, side: TradeSide, amount: string, slippageBps: number) => run("Requesting quote", async (owner, gen) => {
    clearTrade();
    if (chainRef.current !== MAINNET_ID) throw new Error("Switch to Base Mainnet before quoting.");
    if (![10, 25, 50, 100].includes(slippageBps)) throw new Error("Slippage must be between 0.10% and 1.00%.");
    const stock = liveStock(stockAddress);
    const raw = toRaw(amount, side === "buy" ? 6 : stock.decimals);
    await freshAccess(owner, gen);
    const q = await createStockflowTradeQuote({ stockAddress: stock.address, side, amount: amount.trim(), slippageBps });
    guard(owner, gen);
    validatedTradeParams(q, owner as Address, liveStock(stockAddress));
    if (q.side !== side || q.amountIn !== raw.toString() || q.slippageBps !== slippageBps) throw new Error("Quote does not match the requested amount or slippage.");
    setQuote(q);
    void refreshBalances(stock.address);
  });

  // Prepare must return the exact economics the user saw; never silently replace them.
  const prepareSame = async (q: StockflowTradeQuote, owner: string, gen: number) => {
    const p = await prepareStockflowTrade({ quoteId: q.id });
    guard(owner, gen);
    const pq = p.quote;
    if (pq.id !== q.id || pq.amountIn !== q.amountIn || pq.minimumOut !== q.minimumOut || pq.amountOut !== q.amountOut ||
        lower(pq.pool) !== lower(q.pool) || pq.deadline !== q.deadline || pq.side !== q.side) {
      throw new Error("Server returned different trade economics. Request a fresh quote and review it again.");
    }
    const params = validatedTradeParams(pq, owner as Address, liveStock(q.stockAddress));
    setPrepared(p);
    return { p, params };
  };

  /* ── approve exact ── */
  const approveExact = () => run("Approving exact amount", async (owner, gen) => {
    const q = quote; if (!q) throw new Error("Request a quote first.");
    const reviewedFees = fees.status === "ready" ? fees.estimate : null;
    await freshAccess(owner, gen);
    const { p, params } = await prepareSame(q, owner, gen);
    if (!p.approvalRequired) { setNotice("Router allowance already covers this exact amount. No approval sent."); return; }
    const w = await mainnetWallet(owner, gen);
    const beforeApproval = await readNetworkFees(q, owner as Address);
    guard(owner, gen);
    const current = beforeApproval.allowance;
    if (beforeApproval.funding === "insufficient") throw new Error("Insufficient ETH for the estimated Base network fees, including L1 data and operator fees.");
    const nextFee = beforeApproval.reset ?? beforeApproval.approval;
    if (nextFee) requireTransactionFunds(nextFee, beforeApproval.eth);
    if (current > 0n && current < params.amountIn) {
      const { request } = await client.simulateContract({ account: owner as Address, address: params.tokenIn, abi: stockflowErc20Abi, functionName: "approve", args: [STOCKFLOW_ROUTER, 0n] });
      await preWrite(owner, gen, w, q);
      const h = await w.writeContract({ ...request, account: owner as Address, chain: base });
      if (!(await waitOk(gen, { kind: "reset", hash: h, status: "pending", reviewedFee: reviewedFees?.reset }))) throw new Error("Allowance reset reverted. Nothing else was sent.");
      guard(owner, gen);
      await freshAccess(owner, gen);
      validatedTradeParams(q, owner as Address, liveStock(q.stockAddress)); // re-checks expiry and wallet
      if ((await w.getChainId()) !== MAINNET_ID) throw new Error("Wallet left Base Mainnet.");
      guard(owner, gen);
    }
    // Reset may have spent ETH or changed allowance: never reuse its estimate.
    const approvalFees = await readNetworkFees(q, owner as Address);
    guard(owner, gen);
    if (!approvalFees.approval) { setNotice("Router allowance now covers this amount. No further approval sent."); return; }
    requireTransactionFunds(approvalFees.approval, approvalFees.eth);
    const { request } = await client.simulateContract({ account: owner as Address, address: params.tokenIn, abi: stockflowErc20Abi, functionName: "approve", args: [STOCKFLOW_ROUTER, params.amountIn] });
    await preWrite(owner, gen, w, q);
    const h = await w.writeContract({ ...request, account: owner as Address, chain: base });
    if (!(await waitOk(gen, { kind: "approve", hash: h, status: "pending", reviewedFee: reviewedFees?.approval }))) throw new Error("Approval reverted. No trade was sent.");
    guard(owner, gen);
    await prepareSame(q, owner, gen);
  });

  const readNetworkFees = async (q: StockflowTradeQuote, owner: Address) => {
    const params = validatedTradeParams(q, owner, liveStock(q.stockAddress));
    const [allowance, eth] = await Promise.all([
      client.readContract({ address: params.tokenIn, abi: stockflowErc20Abi, functionName: "allowance", args: [owner, STOCKFLOW_ROUTER] }),
      client.getBalance({ address: owner }),
    ]);
    return estimateTradeNetworkFees(client, owner, params, allowance, eth, DATA_SUFFIX);
  };

  const refreshFees = useCallback(async () => {
    const q = quote; const owner = addrRef.current;
    if (!q || !owner || chainRef.current !== MAINNET_ID || quoteRef.current !== q || lower(q.wallet) !== owner) return;
    const gen = generation.current;
    const requestId = ++feeRequest.current;
    const isCurrent = () => gen === generation.current && requestId === feeRequest.current &&
      addrRef.current === owner && chainRef.current === MAINNET_ID && quoteRef.current === q;
    setFees({ status: "loading" });
    void refreshBalances(q.stockAddress);
    try {
      const estimate = await readNetworkFees(q, owner as Address);
      if (isCurrent()) {
        validatedTradeParams(q, owner as Address, liveStock(q.stockAddress));
        setFees({ status: "ready", estimate });
      }
    } catch (e) {
      if (isCurrent()) setFees({ status: "error", message: message(e).slice(0, 180) });
    }
  }, [quote, refreshBalances]); // eslint-disable-line react-hooks/exhaustive-deps

  // New quote, preparation/allowance update, or transaction receipt invalidates fees.
  // Polls also notice external allowance changes and current fee/balance conditions.
  useEffect(() => {
    if (!quote || !address || chainId !== MAINNET_ID || txs.some((t) => t.kind === "swap")) return;
    void refreshFees();
    const timer = setInterval(() => void refreshFees(), 15_000);
    return () => { clearInterval(timer); feeRequest.current++; };
  }, [quote, address, chainId, prepared?.allowance, txs, refreshFees]);

  /* ── confirm trade ── */
  const confirmTrade = () => run("Submitting trade", async (owner, gen) => {
    const q = quote; if (!q) throw new Error("Request a quote first.");
    const submissionKey = `${owner}:${q.id}`;
    if (submittedQuotes.current.has(submissionKey) || loadPending(owner).some(p => p.quoteId === q.id)) {
      throw new Error("This quote already has a submitted swap. Retry recording instead; nothing was resent.");
    }
    // Capture exactly what was displayed at review. The mandatory pre-write
    // estimate below is a fresh safety check, not a replacement review.
    const reviewedFee = fees.status === "ready" ? fees.estimate.swap : null;
    await freshAccess(owner, gen);
    const { p, params } = await prepareSame(q, owner, gen);
    if (p.approvalRequired) throw new Error("Exact router approval is still required.");
    if (!p.simulated) throw new Error("Server simulation did not pass. Trade not sent.");
    const freshFees = await readNetworkFees(q, owner as Address);
    guard(owner, gen);
    if (freshFees.allowance < params.amountIn) throw new Error("Router allowance changed. Approve the exact amount again.");
    requireTransactionFunds(freshFees.swap, freshFees.eth);
    const w = await mainnetWallet(owner, gen);
    validatedTradeParams(q, owner as Address, liveStock(q.stockAddress));
    const { request } = await client.simulateContract({
      account: owner as Address, address: STOCKFLOW_ROUTER, abi: stockflowSwapAbi, functionName: "exactInputSingle", args: [params], value: 0n,
    });
    await preWrite(owner, gen, w, q);
    const hash = await w.writeContract({ ...request, account: owner as Address, chain: base });
    submittedQuotes.current.add(submissionKey);
    // Journal immediately, before anything else can fail.
    let entry: PendingTrade = { wallet: owner, quoteId: q.id, hash, symbol: q.symbol, side: q.side, at: Date.now(), receipt: "unknown", recordError: null, reviewedSwapFee: reviewedFee ? serializeFee(reviewedFee) : null };
    const journal = () => {
      try { upsertPending(entry); }
      catch (e) { if (gen === generation.current) setJournalWarning(`Could not save this swap to browser storage (${message(e)}). Original hash: ${hash}; replacements: ${replacementHashes(entry).join(", ") || "none"}. Copy these hashes before reloading.`); }
      if (gen === generation.current) setPending((l) => [entry, ...l.filter((x) => x.hash !== hash)]);
    };
    journal();
    guard(owner, gen);
    // Anchor the original's verified sender/nonce on the server while it is
    // still visible to the RPC. Failed recording never triggers another write.
    await recordEntry(entry, gen);
    guard(owner, gen);
    const res = await waitTx(gen, { kind: "swap", hash, status: "pending", reviewedFee }, replacement => {
      entry = withReplacement(entry, replacement);
      journal(); // persist before any more awaits, including account switches
    });
    guard(owner, gen);
    if (res.status === "replaced") {
      setTradeDone("replaced");
    } else {
      entry = { ...entry, receipt: res.status };
      journal();
    }
    const recordErr = await recordEntry(entry, gen);
    afterTrade(owner);
    void refreshBalances(q.stockAddress);
    if (recordErr) throw new Error(`Saving the swap outcome failed: ${recordErr}. Hashes are retained. Do not resend — use Retry recording.`);
  });

  const recordEntry = async (entry: PendingTrade, gen: number) => {
    try {
      guard(lower(entry.wallet), gen);
      // Reconciliation requires identity only, not a current trading grant.
      const live = await getStockflowPilotSession();
      guard(lower(entry.wallet), gen);
      if (!live.authenticated || lower(live.address) !== lower(entry.wallet)) throw new Error("Sign in with the submitted swap's wallet to recover it.");
      const row = await recordStockflowTrade({
        quoteId: entry.quoteId, hash: entry.hash, replacementHashes: replacementHashes(entry).slice(-20),
        ...(entry.reviewedSwapFee ? { reviewedSwapFee: entry.reviewedSwapFee } : {}),
      });
      guard(lower(entry.wallet), gen);
      const next = {
        ...entry, status: row.status,
        replacementHashes: [...new Set([...replacementHashes(entry), ...row.replacementHashes])] as Hash[], recordError: null,
      };
      if (row.status === "pending") {
        upsertPending(next);
        setPending((l) => [next, ...l.filter((x) => x.hash !== entry.hash)]);
      } else {
        removePending(entry.wallet, entry.hash);
        setPending((l) => l.filter((x) => x.hash !== entry.hash));
      }
      setTradeDone(row.status === "confirmed" ? "success" : row.status === "failed" ? "reverted" :
        row.status === "cancelled" || row.status === "changed" ? row.status : replacementHashes(next).length ? "replaced" : null);
      return null;
    } catch (e) {
      const next = { ...entry, recordError: message(e) };
      try { upsertPending(next); } catch { /* keep in memory */ }
      if (gen === generation.current) setPending((l) => [next, ...l.filter((x) => x.hash !== entry.hash)]);
      return next.recordError;
    }
  };

  // Recover journaled trades once the cookie wallet matches the connected wallet. Never resubmits.
  const recovered = useRef<string>("");
  const recover = useCallback(() => run("Recovering pending trades", async (owner, gen) => {
    const list = loadPending(owner);
    const failures: string[] = [];
    for (const p of list) {
      guard(owner, gen);
      const err = await recordEntry(p, gen);
      if (err) failures.push(`${p.hash.slice(0, 10)}…: ${err}`);
    }
    afterTrade(owner);
    if (failures.length) throw new Error(`History recording failed for ${failures.length} submitted swap(s); onchain status may be unknown to the server. Hashes are retained, nothing was resent. ${failures.join("; ")}`);
  }), [run]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!matches || !address) { recovered.current = ""; return; }
    const k = lower(address);
    if (recovered.current === k) return;
    recovered.current = k;
    let has = false;
    try { has = loadPending(address).length > 0; } catch { has = false; }
    if (has) void recover();
  }, [matches, address, recover]);
  useEffect(() => {
    if (!matches || !pending.length) return;
    const timer = setInterval(() => { void recover(); }, 10_000);
    return () => clearInterval(timer);
  }, [matches, pending.length, recover]);

  /* ── revoke router allowance (independent of pilot access) ── */
  const readAllowance = useCallback(async (token: string) => {
    const owner = addrRef.current as Address;
    if (!owner) throw new Error("Connect a wallet first.");
    return client.readContract({ address: token as Address, abi: stockflowErc20Abi, functionName: "allowance", args: [owner, STOCKFLOW_ROUTER] });
  }, []);
  const revokeAllowance = (token: string, onDone: () => void) => run("Revoking router allowance", async (owner, gen) => {
    if (lower(token) !== lower(STOCKFLOW_USDC)) liveStockAny(token);
    const current = await readAllowance(token);
    guard(owner, gen);
    if (current === 0n) { setNotice("Router allowance is already zero. Nothing sent."); onDone(); return; }
    const w = await mainnetWallet(owner, gen);
    const { request } = await client.simulateContract({ account: owner as Address, address: token as Address, abi: stockflowErc20Abi, functionName: "approve", args: [STOCKFLOW_ROUTER, 0n] });
    if ((await w.getChainId()) !== MAINNET_ID) throw new Error("Wallet is not on Base Mainnet.");
    guard(owner, gen);
    const h = await w.writeContract({ ...request, account: owner as Address, chain: base });
    if (!(await waitOk(gen, { kind: "revoke", hash: h, status: "pending" }))) throw new Error("Revoke transaction reverted. Allowance unchanged.");
    if (quote && lower(quote.tokenIn) === lower(token)) clearTrade();
    setNotice("Router allowance set to zero.");
    onDone();
  });
  // Revocation is allowed even for paused stocks; only require catalogue membership.
  const liveStockAny = (a: string) => {
    if (!catRef.current.some((x) => lower(x.address) === lower(a))) throw new Error("Token is not in the live catalogue.");
  };

  const dismissPending = (hash: string) => {
    if (!address) return;
    removePending(address, hash);
    setPending((l) => l.filter((x) => x.hash !== hash));
  };

  return useMemo(() => ({
    address, isConnected, chainId, onMainnet: chainId === MAINNET_ID,
    session, cookieWallet, matches, mismatch, canTrade, history,
    busy, error, notice, quote, prepared, txs, tradeDone, pending, balances, balanceError, fees, refreshFees, journalWarning,
    signIn, signOut, switchToMainnet, requestQuote, approveExact, confirmTrade, clearTrade,
    recover, dismissPending, readAllowance, revokeAllowance, refreshBalances,
    clearError: () => setError(null),
  }), [address, isConnected, chainId, session, cookieWallet, matches, mismatch, canTrade, history, busy, error, notice, quote, prepared, txs, tradeDone, pending, balances, balanceError, fees, refreshFees, journalWarning]); // eslint-disable-line react-hooks/exhaustive-deps
}

export type StockflowTrading = ReturnType<typeof useStockflowTrading>;
