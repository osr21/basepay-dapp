import { useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useChainId } from "wagmi";
import { isAddress } from "viem";
import { base } from "viem/chains";
import {
  USDC_ADDRESS, BATCH_PAY_ABI, FEE_BPS,
  parseUSDC, truncateAddress,
} from "@/lib/wagmi";
import { useUsdcPermit } from "@/lib/useUsdcPermit";
import { WalletButton } from "@/components/Layout";
import WalletName from "@/components/WalletName";
import BlockaidNotice from "@/components/BlockaidNotice";

const BATCH_PAY_ADDRESS = (import.meta.env.VITE_BATCH_PAY_ADDRESS ?? "") as `0x${string}`;

interface Row { address: string; amount: string; }

function newRow(): Row { return { address: "", amount: "" }; }

export default function BatchPayPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const [rows, setRows]     = useState<Row[]>([newRow(), newRow()]);
  const [memo, setMemo]     = useState("");
  const [step, setStep]     = useState<"idle" | "signing" | "sending" | "done">("idle");
  const [isSigning, setIsSigning] = useState(false);
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>();
  const [signError, setSignError] = useState<string | undefined>();

  const validRows      = rows.filter(r => isAddress(r.address) && parseFloat(r.amount) > 0);
  const totalGross     = validRows.reduce((s, r) => s + parseFloat(r.amount), 0);
  const totalGrossRaw  = validRows.reduce((s, r) => s + parseUSDC(r.amount), 0n);

  const { signPermit } = useUsdcPermit(address);

  const { writeContract: writeSend, data: sendTxHash, isPending: isSending, error: sendError, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: confirmed } = useWaitForTransactionReceipt({ hash: sendTxHash });

  if (confirmed && step === "sending" && sendTxHash) {
    setTxHash(sendTxHash);
    setStep("done");
  }

  function updateRow(i: number, field: keyof Row, val: string) {
    setRows(rows.map((r, idx) => idx === i ? { ...r, [field]: val } : r));
  }

  async function handleSend() {
    if (validRows.length === 0 || !BATCH_PAY_ADDRESS) return;
    setIsSigning(true);
    setSignError(undefined);
    try {
      const { v, r, s, deadline } = await signPermit(BATCH_PAY_ADDRESS, totalGrossRaw);
      setIsSigning(false);
      setStep("sending");
      writeSend({
        address: BATCH_PAY_ADDRESS,
        abi: BATCH_PAY_ABI,
        functionName: "batchSendWithPermit",
        args: [
          USDC_ADDRESS,
          validRows.map(r => r.address as `0x${string}`),
          validRows.map(r => parseUSDC(r.amount)),
          memo,
          totalGrossRaw,
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
    setRows([newRow(), newRow()]);
    setMemo("");
    setStep("idle");
    setTxHash(undefined);
    setSignError(undefined);
  }

  const isBusy = isSigning || isSending || isConfirming;
  const canProceed = validRows.length >= 1 && !isBusy && chainId === base.id;

  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to use batch payments</p>
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
            Off-chain permit covering <span className="text-foreground font-semibold">{totalGross.toFixed(4)} USDC</span> — no gas, no approval transaction.
          </p>
          <p className="text-xs text-muted-foreground font-mono">Waiting for signature...</p>
        </div>
      </div>
    );
  }

  if (step === "sending") {
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-primary/20 bg-card p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full border border-primary/30 bg-primary/10 flex items-center justify-center mx-auto">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="hsl(221,83%,63%)" strokeWidth="2"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          </div>
          <h2 className="text-lg font-bold">Sending Batch</h2>
          <p className="text-sm text-muted-foreground">{validRows.length} recipients · {totalGross.toFixed(2)} USDC</p>
          <p className="text-xs text-muted-foreground font-mono">{isSending ? "Confirm in wallet..." : "Waiting for confirmation..."}</p>
        </div>
      </div>
    );
  }

  if (step === "done" && txHash) {
    const feeMultiplier = FEE_BPS / 10_000;
    const fee = totalGross * feeMultiplier;
    const net = totalGross - fee;
    return (
      <div className="max-w-md mx-auto space-y-4">
        <div className="rounded-2xl border border-green-500/20 bg-green-500/5 p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(74 222 128)" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h2 className="text-xl font-bold mb-1">Batch Sent</h2>
          <p className="text-muted-foreground text-sm mb-4">{validRows.length} recipients received a total of {net.toFixed(2)} USDC</p>
          <div className="text-xs text-muted-foreground bg-secondary rounded-lg px-3 py-2 mb-4 space-y-1 text-left">
            <div className="flex justify-between"><span>Gross amount</span><span>{totalGross.toFixed(2)} USDC</span></div>
            <div className="flex justify-between text-primary"><span>Protocol fee ({(FEE_BPS / 100).toFixed(2)}%)</span><span>−{fee.toFixed(4)} USDC</span></div>
            <div className="flex justify-between font-semibold text-foreground"><span>Total sent</span><span>{net.toFixed(2)} USDC</span></div>
            <div className="flex justify-between"><span>Recipients</span><span>{validRows.length}</span></div>
          </div>
          <a href={`https://basescan.org/tx/${txHash}`} target="_blank" rel="noopener noreferrer"
            className="block text-xs text-primary hover:underline mb-4 font-mono">{txHash.slice(0, 20)}...</a>
          <button onClick={handleReset} className="w-full py-2 rounded-lg bg-secondary border border-border hover:border-primary/40 text-sm font-medium transition-all">New Batch</button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Batch Pay</h1>
        <p className="text-muted-foreground text-sm mt-1">Send USDC to multiple addresses in one transaction · Sign a message, no approval needed</p>
      </div>

      {!BATCH_PAY_ADDRESS && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 text-sm text-yellow-400">
          BatchPay contract not configured. Set VITE_BATCH_PAY_ADDRESS.
        </div>
      )}

      {(sendError || signError) && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {signError ?? sendError?.message.split("\n")[0]}
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Recipients</h2>
          <span className="text-xs text-muted-foreground">{validRows.length} valid / {rows.length} rows</span>
        </div>

        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input
                type="text"
                placeholder="0x address"
                value={row.address}
                onChange={e => updateRow(i, "address", e.target.value)}
                className="flex-1 bg-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono focus:border-primary/60 focus:outline-none transition-colors placeholder:text-muted-foreground/50"
              />
              <div className="relative w-32">
                <input
                  type="number"
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  value={row.amount}
                  onChange={e => updateRow(i, "amount", e.target.value)}
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:border-primary/60 focus:outline-none transition-colors placeholder:text-muted-foreground/50"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">USDC</span>
              </div>
              <button
                onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
                className="w-8 h-8 flex items-center justify-center rounded-lg border border-border hover:border-red-500/40 hover:text-red-400 text-muted-foreground transition-all text-lg"
              >×</button>
            </div>
          ))}
        </div>

        <button
          onClick={() => setRows([...rows, newRow()])}
          disabled={rows.length >= 200}
          className="w-full py-2 rounded-lg border border-dashed border-border hover:border-primary/40 text-sm text-muted-foreground hover:text-foreground transition-all"
        >+ Add recipient</button>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-muted-foreground">Memo (optional)</span>
          <input
            type="text"
            placeholder="e.g. April payroll, Contributor rewards…"
            value={memo}
            onChange={e => setMemo(e.target.value)}
            className="mt-1.5 w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:border-primary/60 focus:outline-none transition-colors"
          />
        </label>
      </div>

      {validRows.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-6 space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Preview</h2>
          <div className="space-y-1 text-sm">
            {validRows.map((r, i) => (
              <div key={i} className="flex justify-between text-muted-foreground">
                <WalletName address={r.address} />
                <span>{(parseFloat(r.amount) * (1 - FEE_BPS / 10_000)).toFixed(4)} USDC</span>
              </div>
            ))}
          </div>
          <div className="border-t border-border mt-3 pt-3 space-y-1 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Gross total</span><span>{totalGross.toFixed(4)} USDC</span>
            </div>
            <div className="flex justify-between text-primary">
              <span>Protocol fee ({(FEE_BPS / 100).toFixed(2)}%)</span><span>−{(totalGross * FEE_BPS / 10_000).toFixed(4)} USDC</span>
            </div>
            <div className="flex justify-between font-semibold text-foreground">
              <span>You send</span><span>{totalGross.toFixed(4)} USDC</span>
            </div>
          </div>
        </div>
      )}

      {BATCH_PAY_ADDRESS && (
        <BlockaidNotice
          contractAddress={BATCH_PAY_ADDRESS}
          contractName="BatchPayV2"
        />
      )}

      <button
        onClick={handleSend}
        disabled={!canProceed || !BATCH_PAY_ADDRESS}
        className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:bg-primary/90 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-[0_0_20px_hsl(221_83%_53%/0.3)]"
      >
        {chainId !== base.id ? "Wrong Network" : isBusy ? "Processing…" : `Send to ${validRows.length} recipient${validRows.length !== 1 ? "s" : ""}`}
      </button>
    </div>
  );
}
