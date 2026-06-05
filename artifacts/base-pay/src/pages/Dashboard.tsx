import { useAccount } from "wagmi";
import { useReadContract } from "wagmi";
import { Link } from "wouter";
import { useGetStats, getGetStatsQueryKey } from "@workspace/api-client-react";
import { USDC_ADDRESS, USDC_ABI, USDC_DECIMALS, formatUSDC, truncateAddress } from "@/lib/wagmi";
import { WalletButton } from "@/components/Layout";
import WalletName, { WalletAvatar } from "@/components/WalletName";

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
    paid: "bg-green-500/10 text-green-400 border-green-500/20",
    cancelled: "bg-red-500/10 text-red-400 border-red-500/20",
  };
  return (
    <span className={`px-2 py-0.5 rounded-md text-xs font-medium border ${map[status] ?? "bg-secondary text-muted-foreground"}`}>
      {status}
    </span>
  );
}

function NotConnected() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="w-20 h-20 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-6 shadow-[0_0_40px_hsl(221_83%_53%/0.15)]">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="hsl(221,83%,63%)" strokeWidth="1.5">
          <rect width="20" height="14" x="2" y="5" rx="2"/>
          <line x1="2" x2="22" y1="10" y2="10"/>
        </svg>
      </div>
      <h1 className="text-2xl font-bold mb-2">Welcome to BasePay</h1>
      <p className="text-muted-foreground max-w-sm mb-8">
        Connect your wallet to send and receive USDC globally on Base — instant, near-zero fees.
      </p>
      <WalletButton />
      <div className="mt-12 grid grid-cols-3 gap-6 max-w-lg w-full">
        {[
          { label: "Send USDC", desc: "Transfer to any address instantly", icon: "↗" },
          { label: "Request", desc: "Create a shareable payment link", icon: "⬡" },
          { label: "Track", desc: "Monitor all your payment requests", icon: "◈" },
        ].map((f) => (
          <div key={f.label} className="p-4 rounded-xl border border-border bg-card/60 text-left">
            <div className="text-xl mb-2 text-primary">{f.icon}</div>
            <div className="text-sm font-semibold mb-1">{f.label}</div>
            <div className="text-xs text-muted-foreground">{f.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { address, isConnected } = useAccount();

  const { data: balance } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { data: stats, isLoading: statsLoading } = useGetStats(
    address ?? "",
    { query: { enabled: !!address, queryKey: getGetStatsQueryKey(address ?? "") } }
  );

  if (!isConnected) return <NotConnected />;

  const usdcBalance = balance !== undefined ? formatUSDC(balance) : null;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Dashboard</h1>
          {address && (
            <WalletName address={address} showAvatar={true} avatarSize={18} className="text-sm text-muted-foreground" />
          )}
        </div>
      </div>

      {/* Balance card */}
      <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card p-6 shadow-[0_0_40px_hsl(221_83%_53%/0.08)]">
        <div className="absolute top-0 right-0 w-64 h-64 rounded-full bg-primary/5 blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="relative">
          <p className="text-sm text-muted-foreground mb-1">USDC Balance</p>
          {usdcBalance !== null ? (
            <p className="text-4xl font-bold tracking-tight">
              <span className="text-foreground">{usdcBalance}</span>
              <span className="text-lg text-muted-foreground ml-2">USDC</span>
            </p>
          ) : (
            <div className="h-10 w-40 rounded-lg shimmer" />
          )}
          <p className="text-xs text-muted-foreground mt-2">on Base Mainnet</p>
        </div>

        {/* Quick actions */}
        <div className="flex gap-3 mt-6">
          <Link href="/send">
            <a className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-[0_0_16px_hsl(221_83%_53%/0.3)]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
              Send
            </a>
          </Link>
          <Link href="/request">
            <a className="flex items-center gap-2 px-4 py-2 rounded-lg bg-secondary border border-border text-sm font-semibold hover:border-primary/40 transition-all">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="16"/><line x1="8" x2="16" y1="12" y2="12"/></svg>
              Request
            </a>
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {statsLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-border bg-card p-4 h-20 shimmer" />
          ))
        ) : (
          [
            { label: "Total Requested", value: stats ? `$${stats.totalAmountRequested}` : "—" },
            { label: "Requests Created", value: stats?.totalRequestsCreated ?? "—" },
            { label: "Paid", value: stats?.totalRequestsPaid ?? "—" },
            { label: "Pending", value: stats?.pendingRequests ?? "—" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
              <p className="text-xl font-bold">{String(s.value)}</p>
            </div>
          ))
        )}
      </div>

      {/* Recent activity */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">Recent Payment Requests</h2>
          <Link href="/requests">
            <a className="text-xs text-primary hover:underline">View all</a>
          </Link>
        </div>
        {statsLoading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-5 py-4 flex items-center justify-between">
                <div className="space-y-1.5">
                  <div className="h-3.5 w-32 rounded shimmer" />
                  <div className="h-3 w-20 rounded shimmer" />
                </div>
                <div className="h-6 w-16 rounded shimmer" />
              </div>
            ))}
          </div>
        ) : stats?.recentActivity && stats.recentActivity.length > 0 ? (
          <div className="divide-y divide-border">
            {stats.recentActivity.slice(0, 5).map((req) => (
              <div key={req.id} className="px-5 py-4 flex items-center justify-between hover:bg-secondary/30 transition-colors">
                <div>
                  <p className="text-sm font-mono text-foreground">{req.memo || `Request #${req.id}`}</p>
                  <p className="text-xs text-muted-foreground">{new Date(req.createdAt).toLocaleDateString()}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold">{req.amount} {req.token}</span>
                  <StatusBadge status={req.status} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-5 py-10 text-center text-muted-foreground text-sm">
            No payment requests yet.{" "}
            <Link href="/request"><a className="text-primary hover:underline">Create one</a></Link>
          </div>
        )}
      </div>
    </div>
  );
}
