import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";
import { useSignMessage } from "wagmi";
import { WalletButton } from "@/components/Layout";

interface DeveloperKey {
  id: number;
  name: string;
  keyPrefix: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
  requestCount: number;
  revoked: boolean;
}

function api(path: string) {
  return `${import.meta.env.BASE_URL}api/${path}`;
}

function KeyIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="5.5"/>
      <path d="m21 2-9.6 9.6"/>
      <path d="m15.5 7.5 3 3L22 7l-3-3"/>
    </svg>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary border border-border hover:border-primary/40 transition-all text-xs text-muted-foreground hover:text-foreground"
      title="Copy to clipboard"
    >
      {copied
        ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
        : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
      }
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function DeveloperPage() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();

  // sessionAddress: the wallet address the current HttpOnly cookie is bound to.
  // null = no active session (not authenticated, or session expired).
  const [sessionAddress, setSessionAddress] = useState<string | null>(null);
  const [keys, setKeys] = useState<DeveloperKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // isAuthenticated is true only when the session cookie belongs to the
  // currently connected wallet.  If the user switches wallets, they need to
  // re-authenticate even if a valid cookie for another address still exists.
  const isAuthenticated =
    sessionAddress !== null &&
    address !== undefined &&
    sessionAddress === address.toLowerCase();

  // ── Check existing session on mount / wallet change ───────────────────────
  // GET /developer/session reads the HttpOnly cookie server-side and returns
  // the bound address.  The JWT itself never touches the browser's JS heap.
  useEffect(() => {
    let cancelled = false;
    if (!address) { setSessionAddress(null); return; }

    fetch(api("developer/session"))
      .then(r => r.json())
      .then((data: { authenticated: boolean; address: string | null }) => {
        if (cancelled) return;
        if (data.authenticated && data.address === address.toLowerCase()) {
          setSessionAddress(data.address);
        } else {
          setSessionAddress(null);
        }
      })
      .catch(() => { if (!cancelled) setSessionAddress(null); });

    return () => { cancelled = true; };
  }, [address]);

  // ── Load keys whenever the session becomes valid ──────────────────────────
  const loadKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      // No Authorization header — the browser sends the HttpOnly cookie automatically
      const res = await fetch(api("developer/keys"));
      const data = await res.json();
      if (res.ok) {
        setKeys(data);
      } else if (res.status === 401) {
        setSessionAddress(null); // cookie expired server-side
      }
    } finally {
      setKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) loadKeys();
  }, [isAuthenticated, loadKeys]);

  // ── Sign-in ───────────────────────────────────────────────────────────────
  async function authenticate() {
    if (!address) return;
    setAuthLoading(true);
    setError(null);
    try {
      const timestamp = Math.floor(Date.now() / 1000);
      const message = `BasePay Developer Portal\nAddress: ${address}\nTimestamp: ${timestamp}`;
      const signature = await signMessageAsync({ message });
      const res = await fetch(api("developer/auth"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, timestamp, signature }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Authentication failed");
      // Server sets the HttpOnly cookie; we just record the bound address in state
      setSessionAddress(data.address as string);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes("rejected")) {
        setError("Signature rejected — please sign to continue");
      } else {
        setError(e instanceof Error ? e.message : "Authentication failed");
      }
    } finally {
      setAuthLoading(false);
    }
  }

  // ── Sign-out ──────────────────────────────────────────────────────────────
  async function signOut() {
    try {
      await fetch(api("developer/logout"), { method: "POST" });
    } catch { /* best-effort */ }
    setSessionAddress(null);
    setKeys([]);
  }

  async function createKey() {
    if (!isAuthenticated || !newKeyName.trim()) return;
    setCreateLoading(true);
    setError(null);
    try {
      const res = await fetch(api("developer/keys"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create key");
      setRevealedKey(data.key);
      setNewKeyName("");
      setShowCreate(false);
      await loadKeys();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to create key");
    } finally {
      setCreateLoading(false);
    }
  }

  async function revokeKey(id: number) {
    if (!isAuthenticated) return;
    if (!window.confirm("Revoke this API key? Requests using it will immediately fail.")) return;
    const res = await fetch(api(`developer/keys/${id}`), { method: "DELETE" });
    if (res.ok) {
      await loadKeys();
    } else {
      const data = await res.json().catch(() => ({}));
      setError((data as { error?: string }).error ?? "Revoke failed");
    }
  }

  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4 text-primary">
          <KeyIcon />
        </div>
        <p className="text-muted-foreground mb-4">Connect your wallet to manage developer API keys</p>
        <WalletButton />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="max-w-md mx-auto py-10 space-y-6">
        <div className="text-center">
          <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center mx-auto mb-4 text-primary">
            <KeyIcon />
          </div>
          <h1 className="text-xl font-bold mb-2">Developer Portal</h1>
          <p className="text-sm text-muted-foreground">
            Create API keys to call the x402 relay endpoint without per-request USDC payment.
            Authenticate by signing a message — nothing is sent to any third party.
          </p>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">{error}</div>
        )}

        <div className="p-4 rounded-xl border border-border bg-card/50 space-y-2 text-xs text-muted-foreground">
          <p className="font-semibold text-foreground text-sm">You will sign the following message:</p>
          <pre className="font-mono bg-secondary rounded-md px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap">
            {`BasePay Developer Portal\nAddress: ${address}\nTimestamp: <current unix time>`}
          </pre>
        </div>

        <button
          onClick={authenticate}
          disabled={authLoading}
          className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-all disabled:opacity-50 shadow-[0_0_20px_hsl(221_83%_53%/0.3)]"
        >
          {authLoading ? "Waiting for signature…" : "Sign to Authenticate"}
        </button>
      </div>
    );
  }

  const activeKeys = keys.filter(k => !k.revoked);
  const revokedKeys = keys.filter(k => k.revoked);

  return (
    <div className="max-w-3xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Developer Portal</h1>
          <p className="text-sm text-muted-foreground">{activeKeys.length} active key{activeKeys.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowCreate(true)}
            disabled={activeKeys.length >= 10}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all disabled:opacity-40 shadow-[0_0_16px_hsl(221_83%_53%/0.25)]"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="16"/><line x1="8" x2="16" y1="12" y2="12"/></svg>
            Create Key
          </button>
          <button
            onClick={signOut}
            className="px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:text-foreground hover:border-border/80 transition-all"
          >
            Sign out
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex items-center gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
          {error}
        </div>
      )}

      {/* Newly revealed key — shown once */}
      {revealedKey && (
        <div className="p-4 rounded-xl border border-green-500/30 bg-green-500/5 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-green-400 font-semibold text-sm">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
              API Key Created — save this now!
            </div>
            <button onClick={() => setRevealedKey(null)} className="text-muted-foreground hover:text-foreground">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
            </button>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-xs bg-background rounded-lg px-3 py-2.5 border border-border break-all text-foreground">
              {revealedKey}
            </code>
            <CopyButton text={revealedKey} />
          </div>
          <p className="text-xs text-muted-foreground">
            This key is shown exactly once and cannot be recovered. Store it securely.
            Use it as the <code className="text-primary">X-API-Key</code> header when calling{" "}
            <code className="text-primary">POST /api/v2/relay</code>.
          </p>
        </div>
      )}

      {/* Usage info */}
      <div className="p-4 rounded-xl border border-border bg-card/30 text-sm space-y-1">
        <p className="font-semibold text-foreground">How to use</p>
        <p className="text-muted-foreground text-xs">
          Include your API key in the <code className="text-primary font-mono">X-API-Key</code> header to bypass
          the x402 payment gate on the relay endpoint. Keys are scoped to your wallet address.
        </p>
        <code className="block text-[11px] font-mono bg-secondary rounded-md px-3 py-2 text-muted-foreground mt-2">
          {"curl -X POST /api/v2/relay \\\n  -H 'X-API-Key: bpk_...' \\\n  -H 'Content-Type: application/json' \\\n  -d '{...}'"}
        </code>
      </div>

      {/* Keys table */}
      {keysLoading ? (
        <div className="text-center py-8 text-muted-foreground text-sm">Loading keys…</div>
      ) : activeKeys.length === 0 && revokedKeys.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-border rounded-xl">
          <div className="text-muted-foreground text-sm mb-2">No API keys yet</div>
          <button onClick={() => setShowCreate(true)} className="text-primary text-sm font-medium hover:underline">Create your first key →</button>
        </div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/30">
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Name</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Key</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Requests</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Last Used</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Created</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {activeKeys.map(k => (
                <tr key={k.id} className="hover:bg-secondary/20 transition-colors">
                  <td className="px-4 py-3 font-medium">{k.name}</td>
                  <td className="px-4 py-3">
                    <code className="font-mono text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
                      {k.keyPrefix}…
                    </code>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{k.requestCount.toLocaleString()}</td>
                  <td className="px-4 py-3 text-muted-foreground">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{timeAgo(k.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => revokeKey(k.id)}
                      className="px-2.5 py-1 rounded-md text-xs text-red-400 border border-red-500/20 hover:bg-red-500/10 transition-all"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
              {revokedKeys.map(k => (
                <tr key={k.id} className="opacity-40">
                  <td className="px-4 py-3 font-medium line-through">{k.name}</td>
                  <td className="px-4 py-3">
                    <code className="font-mono text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
                      {k.keyPrefix}…
                    </code>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{k.requestCount.toLocaleString()}</td>
                  <td className="px-4 py-3 text-muted-foreground">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{timeAgo(k.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    <span className="px-2 py-0.5 rounded-md text-xs text-muted-foreground border border-border">Revoked</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create Key Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowCreate(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-2xl border border-border bg-card shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-lg">Create API Key</h2>
              <button onClick={() => setShowCreate(false)} className="text-muted-foreground hover:text-foreground">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
              </button>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Key name</label>
              <input
                type="text"
                value={newKeyName}
                onChange={e => setNewKeyName(e.target.value)}
                onKeyDown={e => e.key === "Enter" && createKey()}
                placeholder="e.g. Production relay, Bot v2…"
                maxLength={80}
                autoFocus
                className="w-full px-3 py-2.5 rounded-lg border border-border bg-secondary text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 transition-colors"
              />
              <p className="text-xs text-muted-foreground">A label to identify this key — it does not affect permissions.</p>
            </div>
            <button
              onClick={createKey}
              disabled={createLoading || !newKeyName.trim()}
              className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-all disabled:opacity-50"
            >
              {createLoading ? "Creating…" : "Create Key"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
