import { useState } from "react";
import { useAccount } from "wagmi";
import { useListPaymentRequests, getListPaymentRequestsQueryKey } from "@workspace/api-client-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { WalletButton } from "@/components/Layout";
import { Link } from "wouter";

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

export default function RequestsPage() {
  const { address, isConnected } = useAccount();
  const [filter, setFilter] = useState<"all" | "pending" | "paid" | "cancelled">("all");
  const queryClient = useQueryClient();

  const { data: requests, isLoading } = useListPaymentRequests(
    { recipientAddress: address },
    { query: { enabled: !!address, queryKey: getListPaymentRequestsQueryKey({ recipientAddress: address }) } }
  );

  // Custom mutation that passes ?recipientAddress= for server-side ownership check.
  // The generated hook does not support query params on PATCH, so we call fetch directly.
  const { mutate: updateRequest } = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { status: string } }) => {
      if (!address) throw new Error("Wallet not connected");
      const url = `${import.meta.env.BASE_URL}api/payment-requests/${id}?recipientAddress=${address}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? "Update failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getListPaymentRequestsQueryKey({ recipientAddress: address }) });
    },
  });

  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to view payment requests</p>
        <WalletButton />
      </div>
    );
  }

  const filtered = requests?.filter((r) => filter === "all" || r.status === filter) ?? [];

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold">Payment Requests</h1>
          <p className="text-sm text-muted-foreground">{requests?.length ?? 0} total</p>
        </div>
        <Link href="/request">
          <a className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all shadow-[0_0_16px_hsl(221_83%_53%/0.25)]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="16"/><line x1="8" x2="16" y1="12" y2="12"/></svg>
            New Request
          </a>
        </Link>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 p-1 rounded-lg bg-secondary border border-border w-fit">
        {(["all", "pending", "paid", "cancelled"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-all ${
              filter === f ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* List */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {isLoading ? (
          <div className="divide-y divide-border">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-5 py-4 flex items-center justify-between">
                <div className="space-y-2">
                  <div className="h-3.5 w-36 rounded shimmer" />
                  <div className="h-3 w-20 rounded shimmer" />
                </div>
                <div className="h-6 w-16 rounded shimmer" />
              </div>
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-12 text-center text-muted-foreground text-sm">
            {filter === "all" ? (
              <>No payment requests yet. <Link href="/request"><a className="text-primary hover:underline">Create one</a></Link></>
            ) : `No ${filter} requests.`}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((req) => {
              const payUrl = `${window.location.origin}${import.meta.env.BASE_URL}pay/${req.id}`;
              return (
                <div key={req.id} className="px-5 py-4 flex items-start justify-between gap-4 hover:bg-secondary/20 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <p className="text-sm font-semibold">{req.amount} {req.token}</p>
                      <StatusBadge status={req.status} />
                    </div>
                    {req.memo && <p className="text-xs text-muted-foreground mb-1">{req.memo}</p>}
                    <p className="text-xs text-muted-foreground">{new Date(req.createdAt).toLocaleString()}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => navigator.clipboard.writeText(payUrl)}
                      className="text-xs px-2.5 py-1.5 rounded-md border border-border bg-secondary hover:border-primary/30 transition-all text-muted-foreground hover:text-foreground"
                    >
                      Copy Link
                    </button>
                    {req.status === "pending" && (
                      <>
                        <button
                          onClick={() => updateRequest({ id: req.id, data: { status: "paid" } })}
                          className="text-xs px-2.5 py-1.5 rounded-md border border-green-500/20 bg-green-500/5 text-green-400 hover:bg-green-500/10 transition-all"
                        >
                          Mark Paid
                        </button>
                        <button
                          onClick={() => updateRequest({ id: req.id, data: { status: "cancelled" } })}
                          className="text-xs px-2.5 py-1.5 rounded-md border border-destructive/20 bg-destructive/5 text-destructive hover:bg-destructive/10 transition-all"
                        >
                          Cancel
                        </button>
                      </>
                    )}
                    {req.paidTxHash && (
                      <a
                        href={`https://basescan.org/tx/${req.paidTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-primary hover:underline"
                      >
                        Tx
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
