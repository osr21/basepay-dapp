import { useState, useEffect } from "react";
import { useAccount } from "wagmi";
import { formatUnits } from "viem";

interface RelayStatus {
  relayAddress: string;
  balances: {
    usdc: { raw: string; formatted: string };
    eurc: { raw: string; formatted: string };
    eth:  { raw: string; formatted: string };
  };
}

interface DrainResult {
  recipient: string;
  transfers: { token: string; hash: string; amount: string }[];
  errors:    { token: string; error: string }[];
}

const BASE_URL = import.meta.env.BASE_URL ?? "/";

async function fetchRelayStatus(): Promise<RelayStatus> {
  const res = await fetch(`${BASE_URL}api/admin/relay-status`);
  if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? "Failed to fetch relay status");
  return res.json() as Promise<RelayStatus>;
}

async function drainRelay(recipient: string, adminKey: string): Promise<DrainResult> {
  const res = await fetch(`${BASE_URL}api/admin/relay-drain`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${adminKey}`,
    },
    body: JSON.stringify({ recipient }),
  });
  const data = await res.json() as DrainResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Drain request failed");
  return data;
}

export default function AdminPage() {
  const { address } = useAccount();

  const [status,    setStatus]    = useState<RelayStatus | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [statusErr, setStatusErr] = useState<string | undefined>();

  const [recipient, setRecipient] = useState("");
  const [adminKey,  setAdminKey]  = useState("");
  const [draining,  setDraining]  = useState(false);
  const [result,    setResult]    = useState<DrainResult | null>(null);
  const [drainErr,  setDrainErr]  = useState<string | undefined>();

  useEffect(() => {
    if (address && !recipient) setRecipient(address);
  }, [address]);

  async function loadStatus() {
    setLoading(true);
    setStatusErr(undefined);
    try {
      setStatus(await fetchRelayStatus());
    } catch (err) {
      setStatusErr(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadStatus(); }, []);

  async function handleDrain() {
    if (!recipient || !adminKey) return;
    setDraining(true);
    setDrainErr(undefined);
    setResult(null);
    try {
      const res = await drainRelay(recipient, adminKey);
      setResult(res);
      void loadStatus(); // refresh balances
    } catch (err) {
      setDrainErr(err instanceof Error ? err.message : String(err));
    } finally {
      setDraining(false);
    }
  }

  const hasTokens = status
    ? BigInt(status.balances.usdc.raw) > 0n || BigInt(status.balances.eurc.raw) > 0n
    : false;

  return (
    <div className="max-w-lg mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold mb-0.5">Relay Wallet Admin</h1>
        <p className="text-sm text-muted-foreground">
          View and drain USDC / EURC held by the BasePay relay wallet.
        </p>
      </div>

      {/* Balances card */}
      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-sm">Relay Wallet Balances</h2>
          <button
            onClick={loadStatus}
            disabled={loading}
            className="text-xs text-primary hover:underline disabled:opacity-40"
          >
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>

        {statusErr && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            {statusErr}
          </div>
        )}

        {status && (
          <>
            <div className="rounded-lg bg-secondary border border-border px-3 py-2 text-xs font-mono text-muted-foreground break-all">
              {status.relayAddress}
            </div>

            <div className="space-y-2">
              {[
                { label: "USDC", bal: status.balances.usdc, decimals: 6 },
                { label: "EURC", bal: status.balances.eurc, decimals: 6 },
                { label: "ETH",  bal: status.balances.eth,  decimals: 18 },
              ].map(({ label, bal, decimals }) => {
                const raw = BigInt(bal.raw);
                const isEmpty = raw === 0n;
                const formatted = parseFloat(formatUnits(raw, decimals)).toFixed(decimals === 18 ? 6 : 2);
                return (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-sm font-medium">{label}</span>
                    <span className={`text-sm font-semibold tabular-nums ${isEmpty ? "text-muted-foreground/40" : "text-foreground"}`}>
                      {formatted}
                    </span>
                  </div>
                );
              })}
            </div>

            {!hasTokens && (
              <div className="flex items-center gap-2 text-xs text-green-400 bg-green-500/5 border border-green-500/15 rounded-lg px-3 py-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                Relay wallet holds no USDC or EURC — nothing to drain.
              </div>
            )}
          </>
        )}
      </div>

      {/* Drain card */}
      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <h2 className="font-semibold text-sm">Drain to Wallet</h2>
        <p className="text-xs text-muted-foreground">
          Transfers all USDC and EURC from the relay wallet to the specified address. ETH is kept for future gas.
        </p>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium">Recipient Address</label>
            <input
              type="text"
              placeholder="0x…"
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary/50"
            />
            {address && recipient !== address && (
              <button
                type="button"
                onClick={() => setRecipient(address)}
                className="text-[11px] text-primary hover:underline"
              >
                Use connected wallet ({address.slice(0, 6)}…{address.slice(-4)})
              </button>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground font-medium">Admin Key (SESSION_SECRET)</label>
            <input
              type="password"
              placeholder="Paste your SESSION_SECRET here"
              value={adminKey}
              onChange={e => setAdminKey(e.target.value)}
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-primary/50"
            />
          </div>
        </div>

        {drainErr && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            {drainErr}
          </div>
        )}

        {result && (
          <div className="space-y-2">
            {result.transfers.map(t => (
              <div key={t.token} className="flex items-start gap-2 text-xs text-green-400 bg-green-500/5 border border-green-500/15 rounded-lg px-3 py-2">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="mt-px shrink-0"><polyline points="20 6 9 17 4 12"/></svg>
                <div>
                  <div className="font-semibold">{t.token} — {t.amount} transferred</div>
                  <a
                    href={`https://basescan.org/tx/${t.hash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-primary hover:underline break-all"
                  >
                    {t.hash.slice(0, 18)}…{t.hash.slice(-6)}
                  </a>
                </div>
              </div>
            ))}
            {result.errors.map(e => (
              <div key={e.token} className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
                {e.token} transfer failed: {e.error}
              </div>
            ))}
            {result.transfers.length === 0 && result.errors.length === 0 && (
              <div className="text-xs text-muted-foreground">No tokens to transfer — relay wallet was already empty.</div>
            )}
          </div>
        )}

        <button
          onClick={handleDrain}
          disabled={draining || !recipient || !adminKey || !hasTokens}
          className={`w-full py-2.5 rounded-lg font-semibold text-sm transition-all ${
            draining || !recipient || !adminKey || !hasTokens
              ? "bg-secondary text-muted-foreground cursor-not-allowed"
              : "bg-destructive text-white hover:bg-destructive/90"
          }`}
        >
          {draining ? "Transferring…" : !hasTokens ? "Nothing to Drain" : "Drain Relay Wallet"}
        </button>
      </div>

      <p className="text-xs text-center text-muted-foreground">
        Navigate directly to <span className="font-mono">/admin</span> — this page is not in the main nav.
      </p>
    </div>
  );
}
