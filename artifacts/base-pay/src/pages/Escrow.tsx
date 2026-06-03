import { useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { isAddress, decodeEventLog } from "viem";
import {
  USDC_ADDRESS, ESCROW_ABI,
  parseUSDC, formatUSDC, truncateAddress,
} from "@/lib/wagmi";
import { useUsdcPermit } from "@/lib/useUsdcPermit";
import { WalletButton } from "@/components/Layout";

const ESCROW_ADDRESS = (import.meta.env.VITE_ESCROW_ADDRESS ?? "") as `0x${string}`;

const DURATIONS = [
  { label: "1 day",    seconds: 86_400n    },
  { label: "7 days",   seconds: 604_800n   },
  { label: "30 days",  seconds: 2_592_000n },
  { label: "90 days",  seconds: 7_776_000n },
];

export default function EscrowPage() {
  const { address, isConnected } = useAccount();
  const [payee, setPayee]     = useState("");
  const [amount, setAmount]   = useState("");
  const [ttlIdx, setTtlIdx]   = useState(1);
  const [memo, setMemo]       = useState("");
  const [step, setStep]       = useState<"idle" | "signing" | "creating" | "done">("idle");
  const [isSigning, setIsSigning] = useState(false);
  const [escrowId, setEscrowId] = useState<string | undefined>();
  const [txHash, setTxHash]   = useState<`0x${string}` | undefined>();
  const [signError, setSignError] = useState<string | undefined>();

  const amountRaw = amount && parseFloat(amount) > 0 ? parseUSDC(amount) : 0n;
  const feeRaw    = (amountRaw * 30n) / 10_000n;
  const netRaw    = amountRaw - feeRaw;

  const { signPermit } = useUsdcPermit(address);

  const { writeContract: writeCreate, data: createTxHash, isPending: isCreating, error: createError, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: confirmed, data: receipt } = useWaitForTransactionReceipt({ hash: createTxHash });

  if (confirmed && step === "creating" && createTxHash && receipt) {
    let id: string | undefined;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "EscrowCreated") {
          id = (decoded.args as { id: bigint }).id.toString();
          break;
        }
      } catch {}
    }
    setEscrowId(id);
    setTxHash(createTxHash);
    setStep("done");
  }

  async function handleCreate() {
    if (!isAddress(payee) || !parseFloat(amount) || !ESCROW_ADDRESS) return;
    setIsSigning(true);
    setSignError(undefined);
    try {
      const { v, r, s, deadline } = await signPermit(ESCROW_ADDRESS, amountRaw);
      setIsSigning(false);
      setStep("creating");
      writeCreate({
        address: ESCROW_ADDRESS,
        abi: ESCROW_ABI,
        functionName: "createWithPermit",
        args: [USDC_ADDRESS, payee as `0x${string}`, amountRaw, DURATIONS[ttlIdx].seconds, memo, deadline, v, r, s],
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
    setStep("idle"); setEscrowId(undefined); setTxHash(undefined); setSignError(undefined);
  }

  const isValidPayee  = isAddress(payee);
  const isValidAmount = parseFloat(amount) > 0;
  const isBusy        = isSigning || isCreating || isConfirming;
  const canProceed    = isValidPayee && isValidAmount && !isBusy;

  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to create an escrow</p>
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
            Off-chain permit for <span className="text-foreground font-semibold">{amount} USDC</span> — no gas, no approval transaction.
          </p>
          <p className="text-xs text-muted-foreground font-mono">Waiting for signature...</p>
        </div>
      </div>
    );
  }

  if (step === "creating") {
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-primary/20 bg-card p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full border border-primary/30 bg-primary/10 flex items-center justify-center mx-auto">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="hsl(221,83%,63%)" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <h2 className="text-lg font-bold">Creating Escrow</h2>
          <p className="text-sm text-muted-foreground">{amount} USDC locked for {DURATIONS[ttlIdx].label}</p>
          <p className="text-xs text-muted-foreground font-mono">{isCreating ? "Confirm in wallet..." : "Waiting for confirmation..."}</p>
        </div>
      </div>
    );
  }

  if (step === "done" && txHash) {
    return (
      <div className="max-w-md mx-auto space-y-4">
        <div className="rounded-2xl border border-green-500/20 bg-green-500/5 p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(74 222 128)" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h2 className="text-xl font-bold mb-1">Escrow Created</h2>
          {escrowId && <p className="text-muted-foreground text-sm mb-1">Escrow ID: <span className="font-mono text-foreground">#{escrowId}</span></p>}
          <p className="text-muted-foreground text-sm mb-1">{amount} USDC locked for {DURATIONS[ttlIdx].label}</p>
          <p className="text-muted-foreground text-sm mb-4">Payee: <span className="font-mono text-foreground">{truncateAddress(payee)}</span></p>

          <div className="text-xs text-muted-foreground bg-secondary rounded-lg px-3 py-2 mb-4 space-y-1 text-left">
            <div className="flex justify-between"><span>Locked amount</span><span>{amount} USDC</span></div>
            <div className="flex justify-between text-primary"><span>Fee on release (0.30%)</span><span>−{formatUSDC(feeRaw)} USDC</span></div>
            <div className="flex justify-between font-semibold text-foreground"><span>Payee receives</span><span>{formatUSDC(netRaw)} USDC</span></div>
            <div className="flex justify-between"><span>Expires</span><span>{DURATIONS[ttlIdx].label} from now</span></div>
          </div>

          <p className="text-xs text-muted-foreground mb-3">
            The payee can release funds anytime. After expiry, you can reclaim them if unclaimed.
          </p>
          <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
            className="block text-xs text-primary hover:underline mb-4 font-mono">{txHash.slice(0, 20)}...</a>
          <button onClick={handleReset} className="w-full py-2 rounded-lg bg-secondary border border-border hover:border-primary/40 text-sm font-medium transition-all">New Escrow</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Escrow</h1>
        <p className="text-muted-foreground text-sm mt-1">Lock USDC until the payee claims it · Sign a message, no approval needed</p>
      </div>

      {!ESCROW_ADDRESS && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-yellow-400">
          Escrow contract not configured. Set VITE_ESCROW_ADDRESS.
        </div>
      )}

      {(createError || signError) && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {signError ?? createError?.message.split("\n")[0]}
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
          <span className="text-sm font-medium text-muted-foreground">Amount (USDC)</span>
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

        <label className="block">
          <span className="text-sm font-medium text-muted-foreground">Lock duration</span>
          <div className="grid grid-cols-4 gap-2 mt-1.5">
            {DURATIONS.map((d, i) => (
              <button
                key={i}
                onClick={() => setTtlIdx(i)}
                className={`py-2 rounded-lg border text-sm font-medium transition-all ${
                  ttlIdx === i
                    ? "bg-primary/15 text-primary border-primary/30"
                    : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                }`}
              >{d.label}</button>
            ))}
          </div>
        </label>

        <label className="block">
          <span className="text-sm font-medium text-muted-foreground">Memo (optional)</span>
          <input
            type="text"
            placeholder="e.g. Freelance project milestone…"
            value={memo}
            onChange={e => setMemo(e.target.value)}
            className="mt-1.5 w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:border-primary/60 focus:outline-none transition-colors"
          />
        </label>
      </div>

      {isValidAmount && (
        <div className="rounded-2xl border border-border bg-card p-5 space-y-1.5 text-sm">
          <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Breakdown</h2>
          <div className="flex justify-between text-muted-foreground"><span>You lock</span><span>{amount} USDC</span></div>
          <div className="flex justify-between text-primary"><span>Fee on release (0.30%)</span><span>−{formatUSDC(feeRaw)} USDC</span></div>
          <div className="flex justify-between font-semibold text-foreground border-t border-border pt-2 mt-2">
            <span>Payee receives</span><span>{formatUSDC(netRaw)} USDC</span>
          </div>
          <div className="flex justify-between text-muted-foreground"><span>Refund if unclaimed after</span><span>{DURATIONS[ttlIdx].label}</span></div>
        </div>
      )}

      <button
        onClick={handleCreate}
        disabled={!canProceed || !ESCROW_ADDRESS}
        className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_20px_hsl(221_83%_53%/0.3)]"
      >{isBusy ? "Processing…" : "Create Escrow"}</button>
    </div>
  );
}
