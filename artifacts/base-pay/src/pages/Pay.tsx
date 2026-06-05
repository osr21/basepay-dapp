import { useState } from "react";
import { useParams } from "wouter";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { useGetPaymentRequest, useUpdatePaymentRequest } from "@workspace/api-client-react";
import { USDC_ADDRESS, USDC_ABI, parseUSDC, truncateAddress } from "@/lib/wagmi";
import { WalletButton } from "@/components/Layout";

export default function PayPage() {
  const { id } = useParams<{ id: string }>();
  const { address, isConnected } = useAccount();
  const [statusUpdateError, setStatusUpdateError] = useState<string | undefined>();

  const { data: req, isLoading, error } = useGetPaymentRequest(id, {
    query: { enabled: !!id, queryKey: ["getPaymentRequest", id] },
  });

  const { mutate: updateRequest } = useUpdatePaymentRequest();

  const { writeContract, data: txHash, isPending: isSending, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  function handlePay() {
    if (!req || req.token !== "USDC") return;
    writeContract(
      {
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: "transfer",
        args: [req.recipientAddress as `0x${string}`, parseUSDC(req.amount)],
      },
      {
        onSuccess: (hash) => {
          updateRequest(
            { id: req.id, data: { status: "paid", paidTxHash: hash } },
            {
              onError: () => {
                setStatusUpdateError(
                  `Payment confirmed on-chain (${hash.slice(0, 10)}…) but the request status could not be updated. The payment went through — check BaseScan to verify.`
                );
              },
            }
          );
        },
      }
    );
  }

  if (isLoading) {
    return (
      <div className="max-w-md mx-auto space-y-4 mt-8">
        <div className="h-10 w-48 rounded-lg shimmer" />
        <div className="h-48 w-full rounded-2xl shimmer" />
      </div>
    );
  }

  if (error || !req) {
    return (
      <div className="max-w-md mx-auto text-center mt-12">
        <div className="w-16 h-16 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center mx-auto mb-4">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="rgb(239 68 68)" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" x2="9" y1="9" y2="15"/><line x1="9" x2="15" y1="9" y2="15"/></svg>
        </div>
        <h1 className="text-xl font-bold mb-2">Request Not Found</h1>
        <p className="text-muted-foreground text-sm">This payment request doesn't exist or has been removed.</p>
      </div>
    );
  }

  if (isSuccess && txHash) {
    return (
      <div className="max-w-md mx-auto space-y-3">
        <div className="rounded-2xl border border-green-500/20 bg-green-500/5 p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(74 222 128)" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <h2 className="text-xl font-bold mb-2">Payment Sent</h2>
          <p className="text-muted-foreground text-sm mb-4">{req.amount} {req.token} sent to {truncateAddress(req.recipientAddress)}</p>
          <a
            href={`https://basescan.org/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-primary text-sm hover:underline"
          >
            View on BaseScan
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
          </a>
        </div>
        {statusUpdateError && (
          <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-xs text-yellow-400">
            {statusUpdateError}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold">Pay Request</h1>
        <p className="text-sm text-muted-foreground">Review and confirm payment on Base</p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
        {/* Amount */}
        <div className="text-center py-4 border-b border-border">
          <p className="text-sm text-muted-foreground mb-1">You are paying</p>
          <p className="text-4xl font-bold">{req.amount} <span className="text-primary">{req.token}</span></p>
          {req.memo && <p className="text-sm text-muted-foreground mt-2 italic">"{req.memo}"</p>}
        </div>

        {/* To */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">To</span>
          <span className="font-mono">{truncateAddress(req.recipientAddress)}</span>
        </div>

        {/* Network */}
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Network</span>
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            Base Mainnet
          </div>
        </div>

        {/* Status */}
        {req.status !== "pending" && (
          <div className={`text-center py-2 rounded-lg text-sm font-semibold ${
            req.status === "paid" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
          }`}>
            This request is {req.status}
          </div>
        )}

        {writeError && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            {writeError.message.slice(0, 120)}
          </div>
        )}

        {req.status === "pending" && (
          <>
            {!isConnected ? (
              <div className="flex flex-col items-center gap-3">
                <p className="text-sm text-muted-foreground">Connect your wallet to pay</p>
                <WalletButton />
              </div>
            ) : req.token !== "USDC" ? (
              <p className="text-sm text-muted-foreground text-center">ETH payments must be made manually to {truncateAddress(req.recipientAddress)}</p>
            ) : (
              <button
                onClick={handlePay}
                disabled={isSending || isConfirming}
                className={`w-full py-3 rounded-lg font-semibold text-sm transition-all ${
                  !isSending && !isConfirming
                    ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_hsl(221_83%_53%/0.3)] glow-pulse"
                    : "bg-secondary text-muted-foreground cursor-not-allowed"
                }`}
              >
                {isSending ? "Confirm in wallet..." : isConfirming ? "Confirming..." : `Pay ${req.amount} USDC`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
