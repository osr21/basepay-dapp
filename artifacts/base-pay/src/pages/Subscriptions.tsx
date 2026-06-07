import { useState, useEffect } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useChainId } from "wagmi";
import { isAddress, decodeEventLog } from "viem";
import { base } from "viem/chains";
import {
  USDC_ADDRESS, SUBSCRIPTION_MANAGER_ABI, FEE_BPS,
  parseUSDC, formatUSDC, truncateAddress,
} from "@/lib/wagmi";
import { useUsdcPermit } from "@/lib/useUsdcPermit";
import { WalletButton } from "@/components/Layout";
import BlockaidNotice from "@/components/BlockaidNotice";

const SUB_MANAGER_ADDRESS = (import.meta.env.VITE_SUBSCRIPTION_MANAGER_ADDRESS ?? "") as `0x${string}`;

const INTERVALS = [
  { label: "Daily",   seconds: 86_400n,    display: "day"   },
  { label: "Weekly",  seconds: 604_800n,   display: "week"  },
  { label: "Monthly", seconds: 2_592_000n, display: "month" },
];

// Subscription permit deadline: 3 years from contract creation.
// Deliberately NOT maxUint256 / year-2100 — that gives the contract
// unlimited allowance forever, which is a serious attack surface.
// After ~3 years the user must re-subscribe, which also forces a
// review of the subscription terms.
function subPermitDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 3 * 365 * 24 * 3600);
}

export default function SubscriptionsPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [payee, setPayee]       = useState("");
  const [amount, setAmount]     = useState("");
  const [intervalIdx, setIntervalIdx] = useState(2);
  const [memo, setMemo]         = useState("");
  const [step, setStep]         = useState<"idle" | "signing" | "subscribing" | "done">("idle");
  const [isSigning, setIsSigning] = useState(false);
  const [subId, setSubId]       = useState<string | undefined>();
  const [txHash, setTxHash]     = useState<`0x${string}` | undefined>();
  const [signError, setSignError] = useState<string | undefined>();

  const amountRaw  = amount && parseFloat(amount) > 0 ? parseUSDC(amount) : 0n;
  const feeRaw     = (amountRaw * BigInt(FEE_BPS)) / 10_000n;
  const netRaw     = amountRaw - feeRaw;
  const interval   = INTERVALS[intervalIdx];

  const { signPermit } = useUsdcPermit(address);

  const { writeContract: writeSub, data: subTxHash, isPending: isSubPending, error: subError, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: confirmed, data: receipt } = useWaitForTransactionReceipt({ hash: subTxHash });

  useEffect(() => {
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
  }, [confirmed, subTxHash, receipt]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubscribe() {
    if (!isAddress(payee) || !parseFloat(amount) || !SUB_MANAGER_ADDRESS) return;
    setIsSigning(true);
    setSignError(undefined);
    try {
      // Permit amount: 1,000× the per-charge amount (covers thousands of billing cycles
      // without granting unlimited access). Deadline: 3 years from now.
      // Using maxUint256 + year-2100 would give the contract permanent unlimited
      // allowance — a critical exploit surface if the contract is ever compromised.
      const deadline = subPermitDeadline();
      const permitAmount = amountRaw * 1_000n;
      const deadlineSecs = Number(deadline - BigInt(Math.floor(Date.now() / 1000)));
      const { v, r, s } = await signPermit(
        SUB_MANAGER_ADDRESS,
        permitAmount,
        deadlineSecs,
      );
      setIsSigning(false);
      setStep("subscribing");
      writeSub({
        address: SUB_MANAGER_ADDRESS,
        abi: SUBSCRIPTION_MANAGER_ABI,
        functionName: "subscribeWithPermit",
        args: [
          USDC_ADDRESS,
          payee as `0x${string}`,
          amountRaw,
          interval.seconds,
          memo,
          permitAmount,
          deadline,
          v, r, s,
        ],
      });
    } catch (err: unknown) {
      setIsSigning(false);
      setStep("idle");
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes("rejected") && !msg.toLowerCase().includes("denied")) {
        setSignError(msg.slice(0, 120));
      }
    }
  }

  function handleReset() {
    reset();
    setPayee(""); setAmount(""); setMemo("");
    setStep("idle"); setSubId(undefined); setTxHash(undefined); setSignError(undefined);
  }

  const isValidPayee  = isAddress(payee);
  const isValidAmount = parseFloat(amount) > 0;
  const isBusy        = isSigning || isSubPending || isConfirming;
  const canProceed    = isValidPayee && isValidAmount && !isBusy && chainId === base.id;

  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to set up a subscription</p>
        <WalletButton />
      </div>
    );
  }

  if (isSigning) {
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-primary/20 bg-card p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full border border-primary/30 bg-primary/10 flex items-center justify-center mx-auto glow-pulse">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="hsl(221,83%,63%)" strokeWidth="2">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
          </div>
          <h2 className="text-lg font-bold">Sign message in wallet</h2>
          <p className="text-sm text-muted-foreground">
            One-time signature sets up your subscription — all future charges work automatically, no re-approval needed.
          </p>
          <p className="text-xs text-muted-foreground font-mono">Waiting for signature...</p>
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
            <div className="flex justify-between text-primary"><span>Protocol fee ({(FEE_BPS / 100).toFixed(2)}%)</span><span>−{formatUSDC(feeRaw)} USDC</span></div>
            <div className="flex justify-between font-semibold text-foreground"><span>Payee receives</span><span>{formatUSDC(netRaw)} USDC</span></div>
            <div className="flex justify-between"><span>Est. annual cost</span><span>~{annualGross.toFixed(2)} USDC</span></div>
          </div>

          <p className="text-xs text-muted-foreground mb-3">
            Keep your USDC balance funded. Cancel anytime by calling <span className="font-mono">cancel(#{subId})</span> on BaseScan.
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
        <p className="text-muted-foreground text-sm mt-1">Set up recurring USDC payments · Sign once, charges run automatically</p>
      </div>

      {!SUB_MANAGER_ADDRESS && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-yellow-400">
          SubscriptionManager not configured. Set VITE_SUBSCRIPTION_MANAGER_ADDRESS.
        </div>
      )}

      {(subError || signError) && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {signError ?? subError?.message.split("\n")[0]}
        </div>
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
          <div className="flex justify-between text-primary"><span>Protocol fee ({(FEE_BPS / 100).toFixed(2)}%)</span><span>−{formatUSDC(feeRaw)} USDC</span></div>
          <div className="flex justify-between font-semibold text-foreground border-t border-border pt-2 mt-2">
            <span>Payee receives</span><span>{formatUSDC(netRaw)} USDC</span>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-border bg-secondary/50 px-4 py-3 text-xs text-muted-foreground space-y-1">
        <p><span className="font-semibold text-foreground">How it works:</span> Sign one message in your wallet (no gas, no transaction) to authorise recurring charges. The payee triggers each charge once per {interval.display}.</p>
        <p>Keep your USDC balance funded. Cancel anytime.</p>
      </div>

      {SUB_MANAGER_ADDRESS && (
        <BlockaidNotice
          contractAddress={SUB_MANAGER_ADDRESS}
          contractName="SubscriptionManagerV2"
        />
      )}

      <button
        onClick={handleSubscribe}
        disabled={!canProceed || !SUB_MANAGER_ADDRESS}
        className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_20px_hsl(221_83%_53%/0.3)]"
      >{chainId !== base.id ? "Wrong Network" : isBusy ? "Processing…" : `Subscribe · ${amount || "0"} USDC / ${interval.display}`}</button>
    </div>
  );
}
