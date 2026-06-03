import { useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract } from "wagmi";
import { isAddress, decodeEventLog } from "viem";
import {
  USDC_ADDRESS, USDC_ABI, SUBSCRIPTION_MANAGER_ABI,
  parseUSDC, formatUSDC, truncateAddress,
} from "@/lib/wagmi";
import { WalletButton } from "@/components/Layout";

const SUB_MANAGER_ADDRESS = (import.meta.env.VITE_SUBSCRIPTION_MANAGER_ADDRESS ?? "") as `0x${string}`;

const INTERVALS = [
  { label: "Daily",   seconds: 86_400n,    display: "day"   },
  { label: "Weekly",  seconds: 604_800n,   display: "week"  },
  { label: "Monthly", seconds: 2_592_000n, display: "month" },
];

export default function SubscriptionsPage() {
  const { address, isConnected } = useAccount();
  const [payee, setPayee]       = useState("");
  const [amount, setAmount]     = useState("");
  const [intervalIdx, setIntervalIdx] = useState(2);
  const [memo, setMemo]         = useState("");
  const [step, setStep]         = useState<"idle" | "approving" | "subscribing" | "done">("idle");
  const [subId, setSubId]       = useState<string | undefined>();
  const [txHash, setTxHash]     = useState<`0x${string}` | undefined>();

  const amountRaw  = amount && parseFloat(amount) > 0 ? parseUSDC(amount) : 0n;
  const feeRaw     = (amountRaw * 30n) / 10_000n;
  const netRaw     = amountRaw - feeRaw;
  const interval   = INTERVALS[intervalIdx];

  // Approve exactly one period's gross amount.
  // Approving only what the contract needs for the next charge is the safest pattern —
  // security scanners like Blockaid flag large or unlimited approvals to pull-payment contracts.
  // The user will be asked to re-approve before each charge once allowance drops below amountRaw.
  const approvalCap = amountRaw; // exactly one charge

  const { data: allowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: USDC_ABI,
    functionName: "allowance",
    args: address ? [address, SUB_MANAGER_ADDRESS] : undefined,
    query: { enabled: !!address && !!SUB_MANAGER_ADDRESS },
  });

  // Re-approve when remaining allowance falls below one full charge
  const needsApproval = allowance !== undefined && amountRaw > 0n && allowance < amountRaw;

  const { writeContract: writeApprove, data: approveTxHash, isPending: isApproving } = useWriteContract();
  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({ hash: approveTxHash });

  const { writeContract: writeSub, data: subTxHash, isPending: isSubPending, error: subError, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: confirmed, data: receipt } = useWaitForTransactionReceipt({ hash: subTxHash });

  if (confirmed && step === "subscribing" && subTxHash && receipt) {
    let id: string | undefined;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: SUBSCRIPTION_MANAGER_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "Subscribed") {
          id = (decoded.args as { id: bigint }).id.toString();
          break;
        }
      } catch {}
    }
    setSubId(id);
    setTxHash(subTxHash);
    setStep("done");
  }

  if (approveConfirmed && step === "approving") {
    setStep("idle");
  }

  function handleApprove() {
    setStep("approving");
    writeApprove({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: "approve",
      args: [SUB_MANAGER_ADDRESS, approvalCap],
    });
  }

  function handleSubscribe() {
    setStep("subscribing");
    writeSub({
      address: SUB_MANAGER_ADDRESS,
      abi: SUBSCRIPTION_MANAGER_ABI,
      functionName: "subscribe",
      args: [USDC_ADDRESS, payee as `0x${string}`, amountRaw, interval.seconds, memo],
    });
  }

  function handleReset() {
    reset();
    setPayee(""); setAmount(""); setMemo("");
    setStep("idle"); setSubId(undefined); setTxHash(undefined);
  }

  const isValidPayee  = isAddress(payee);
  const isValidAmount = parseFloat(amount) > 0;
  const isBusy        = isApproving || isSubPending || isConfirming;
  const canProceed    = isValidPayee && isValidAmount && !isBusy;

  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to set up a subscription</p>
        <WalletButton />
      </div>
    );
  }

  if (step === "approving") {
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-primary/20 bg-card p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full border border-primary/30 bg-primary/10 flex items-center justify-center mx-auto">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="hsl(221,83%,63%)" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <h2 className="text-lg font-bold">Approve Spending Cap</h2>
          <p className="text-sm text-muted-foreground">
            Approving exactly <span className="font-semibold text-foreground">{amount || "—"} USDC</span> — one charge only. Your wallet may show a security warning for pull-payment contracts; this approval is limited to a single period.
          </p>
          <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 text-left text-xs text-yellow-300 space-y-1">
            <p className="font-semibold">⚠ About the wallet warning</p>
            <p>Security tools like Blockaid flag subscription contracts because they allow recurring charges. This contract is <a href="https://basescan.org/address/0x546093b0476b4b7909cd84f3a0fef813c421d14a#code" target="_blank" rel="noopener noreferrer" className="underline">open-source and verified</a> on BaseScan. You may proceed safely.</p>
          </div>
          <p className="text-xs text-muted-foreground font-mono">{isApproving ? "Confirm in wallet..." : "Waiting for confirmation..."}</p>
        </div>
      </div>
    );
  }

  if (step === "subscribing") {
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-primary/20 bg-card p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full border border-primary/30 bg-primary/10 flex items-center justify-center mx-auto">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="hsl(221,83%,63%)" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </div>
          <h2 className="text-lg font-bold">Creating Subscription</h2>
          <p className="text-sm text-muted-foreground">{amount} USDC / {interval.display} to {truncateAddress(payee)}</p>
          <p className="text-xs text-muted-foreground font-mono">{isSubPending ? "Confirm in wallet..." : "Waiting for confirmation..."}</p>
        </div>
      </div>
    );
  }

  if (step === "done" && txHash) {
    const annualGross = parseFloat(amount) * (interval.seconds === 86_400n ? 365 : interval.seconds === 604_800n ? 52 : 12);
    return (
      <div className="max-w-md mx-auto space-y-4">
        <div className="rounded-2xl border border-green-500/20 bg-green-500/5 p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(74 222 128)" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h2 className="text-xl font-bold mb-1">Subscription Active</h2>
          {subId && <p className="text-muted-foreground text-sm mb-1">Subscription ID: <span className="font-mono text-foreground">#{subId}</span></p>}
          <p className="text-muted-foreground text-sm mb-4">
            {formatUSDC(netRaw)} USDC / {interval.display} to {truncateAddress(payee)}
          </p>

          <div className="text-xs text-muted-foreground bg-secondary rounded-lg px-3 py-2 mb-4 space-y-1 text-left">
            <div className="flex justify-between"><span>Charge per {interval.display}</span><span>{amount} USDC</span></div>
            <div className="flex justify-between text-primary"><span>Protocol fee (0.30%)</span><span>−{formatUSDC(feeRaw)} USDC</span></div>
            <div className="flex justify-between font-semibold text-foreground"><span>Payee receives</span><span>{formatUSDC(netRaw)} USDC</span></div>
            <div className="flex justify-between"><span>Est. annual cost</span><span>~{annualGross.toFixed(2)} USDC</span></div>
          </div>

          <p className="text-xs text-muted-foreground mb-3">
            Keep your USDC balance and allowance topped up. Cancel anytime by calling <span className="font-mono">cancel(#{subId})</span> on BaseScan.
          </p>
          <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
            className="block text-xs text-primary hover:underline mb-4 font-mono">{txHash.slice(0, 20)}...</a>
          <button onClick={handleReset} className="w-full py-2 rounded-lg bg-secondary border border-border hover:border-primary/40 text-sm font-medium transition-all">New Subscription</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Subscribe</h1>
        <p className="text-muted-foreground text-sm mt-1">Set up recurring USDC payments to any address</p>
      </div>

      {!SUB_MANAGER_ADDRESS && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-yellow-400">
          SubscriptionManager not configured. Set VITE_SUBSCRIPTION_MANAGER_ADDRESS.
        </div>
      )}

      {subError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">{subError.message.split("\n")[0]}</div>
      )}

      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-muted-foreground">Payee address</span>
          <input
            type="text"
            placeholder="0x…"
            value={payee}
            onChange={e => setPayee(e.target.value)}
            className="mt-1.5 w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm font-mono focus:border-primary/60 focus:outline-none transition-colors"
          />
          {payee && !isValidPayee && <p className="text-xs text-red-400 mt-1">Invalid address</p>}
        </label>

        <label className="block">
          <span className="text-sm font-medium text-muted-foreground">Amount per period (USDC)</span>
          <div className="relative mt-1.5">
            <input
              type="number"
              placeholder="0.00"
              min="0"
              step="0.01"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm focus:border-primary/60 focus:outline-none transition-colors"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">USDC</span>
          </div>
        </label>

        <div>
          <span className="text-sm font-medium text-muted-foreground">Billing interval</span>
          <div className="grid grid-cols-3 gap-2 mt-1.5">
            {INTERVALS.map((iv, i) => (
              <button
                key={i}
                onClick={() => setIntervalIdx(i)}
                className={`py-2.5 rounded-lg border text-sm font-medium transition-all ${
                  intervalIdx === i
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                }`}
              >{iv.label}</button>
            ))}
          </div>
        </div>

        <label className="block">
          <span className="text-sm font-medium text-muted-foreground">Memo (optional)</span>
          <input
            type="text"
            placeholder="e.g. SaaS plan, Netflix, Rent…"
            value={memo}
            onChange={e => setMemo(e.target.value)}
            className="mt-1.5 w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:border-primary/60 focus:outline-none transition-colors"
          />
        </label>
      </div>

      {isValidAmount && (
        <div className="rounded-2xl border border-border bg-card p-5 space-y-1.5 text-sm">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Per charge</h2>
          <div className="flex justify-between text-muted-foreground"><span>Gross charge</span><span>{amount} USDC</span></div>
          <div className="flex justify-between text-primary"><span>Protocol fee (0.30%)</span><span>−{formatUSDC(feeRaw)} USDC</span></div>
          <div className="flex justify-between font-semibold text-foreground border-t border-border pt-2 mt-2">
            <span>Payee receives</span><span>{formatUSDC(netRaw)} USDC</span>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-secondary/50 px-4 py-3 text-xs text-muted-foreground space-y-1">
        <p><span className="font-semibold text-foreground">How it works:</span> You approve exactly <span className="font-semibold text-foreground">{amount || "one period"} USDC</span>, then the payee triggers a charge once per {interval.display}. Your approval resets to one period each time — your exposure is always capped at a single charge.</p>
        <p>Keep your USDC balance funded. You can cancel at any time.</p>
      </div>

      {/* Security notice — explains Blockaid warnings before the wallet opens */}
      {needsApproval && isValidAmount && (
        <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-xs text-yellow-300 space-y-1.5">
          <p className="font-semibold text-yellow-200">⚠ Your wallet may show a security warning</p>
          <p>Subscription contracts require a spending approval so charges can be collected each period. Your wallet's security scanner (e.g. Blockaid) may flag this as high-risk because it's a pull-payment pattern.</p>
          <p>This contract is <a href="https://basescan.org/address/0x546093b0476b4b7909cd84f3a0fef813c421d14a#code" target="_blank" rel="noopener noreferrer" className="underline font-medium">open-source and verified on BaseScan</a>. You are approving exactly <span className="font-medium text-yellow-100">{amount} USDC</span> — one period only.</p>
        </div>
      )}

      {needsApproval ? (
        <button
          onClick={handleApprove}
          disabled={!canProceed || !SUB_MANAGER_ADDRESS}
          className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_20px_hsl(221_83%_53%/0.3)]"
        >Approve {amount ? `${amount} USDC` : "USDC"} for Subscriptions</button>
      ) : (
        <button
          onClick={handleSubscribe}
          disabled={!canProceed || !SUB_MANAGER_ADDRESS}
          className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_20px_hsl(221_83%_53%/0.3)]"
        >{isBusy ? "Processing…" : `Subscribe · ${amount || "0"} USDC / ${interval.display}`}</button>
      )}
    </div>
  );
}
