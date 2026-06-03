import { useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { isAddress } from "viem";
import { useListContacts } from "@workspace/api-client-react";
import { USDC_ADDRESS, USDC_ABI, parseUSDC, truncateAddress } from "@/lib/wagmi";
import { WalletButton } from "@/components/Layout";

export default function SendPage() {
  const { address, isConnected } = useAccount();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [showContacts, setShowContacts] = useState(false);

  const { data: contacts } = useListContacts(
    { ownerAddress: address },
    { query: { enabled: !!address } }
  );

  const { writeContract, data: txHash, isPending: isSending, error: writeError, reset } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash: txHash });

  const isValidAddress = isAddress(to);
  const isValidAmount = parseFloat(amount) > 0;
  const canSend = isValidAddress && isValidAmount && !isSending && !isConfirming;

  function handleSend() {
    if (!canSend) return;
    writeContract({
      address: USDC_ADDRESS,
      abi: USDC_ABI,
      functionName: "transfer",
      args: [to as `0x${string}`, parseUSDC(amount)],
    });
  }

  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to send USDC</p>
        <WalletButton />
      </div>
    );
  }

  if (isSuccess && txHash) {
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-green-500/20 bg-green-500/5 p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(74 222 128)" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <h2 className="text-xl font-bold mb-2">Transfer Sent</h2>
          <p className="text-muted-foreground text-sm mb-1">{amount} USDC to</p>
          <p className="font-mono text-sm text-foreground mb-4">{truncateAddress(to)}</p>
          <a
            href={`https://basescan.org/tx/${txHash}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-primary text-sm hover:underline"
          >
            View on BaseScan
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
          </a>
          <div className="mt-6">
            <button
              onClick={() => { reset(); setTo(""); setAmount(""); setMemo(""); }}
              className="px-5 py-2 rounded-lg bg-secondary text-sm hover:bg-secondary/80 transition-all"
            >
              Send Another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold">Send USDC</h1>
        <p className="text-sm text-muted-foreground">Transfer instantly on Base</p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
        {/* Recipient */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium">Recipient</label>
            {contacts && contacts.length > 0 && (
              <button
                onClick={() => setShowContacts(!showContacts)}
                className="text-xs text-primary hover:underline"
              >
                {showContacts ? "Hide contacts" : "Choose from contacts"}
              </button>
            )}
          </div>
          {showContacts && contacts && (
            <div className="mb-2 rounded-lg border border-border bg-secondary overflow-hidden max-h-40 overflow-y-auto">
              {contacts.map((c) => (
                <button
                  key={c.id}
                  className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-card transition-colors text-left"
                  onClick={() => { setTo(c.walletAddress); setShowContacts(false); }}
                >
                  <span className="text-sm font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground font-mono">{truncateAddress(c.walletAddress)}</span>
                </button>
              ))}
            </div>
          )}
          <input
            type="text"
            placeholder="0x... wallet address"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={`w-full px-3.5 py-2.5 rounded-lg border bg-secondary text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 transition-all ${
              to && !isValidAddress ? "border-destructive/60 focus:ring-destructive/40" : "border-border focus:ring-primary/40 focus:border-primary/40"
            }`}
          />
          {to && !isValidAddress && (
            <p className="text-xs text-destructive mt-1">Invalid wallet address</p>
          )}
        </div>

        {/* Amount */}
        <div>
          <label className="text-sm font-medium block mb-1.5">Amount</label>
          <div className="relative">
            <input
              type="number"
              placeholder="0.00"
              value={amount}
              min="0"
              step="0.01"
              onChange={(e) => setAmount(e.target.value)}
              className="w-full px-3.5 py-2.5 pr-16 rounded-lg border border-border bg-secondary text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-all"
            />
            <span className="absolute right-3.5 top-1/2 -translate-y-1/2 text-xs font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded">USDC</span>
          </div>
        </div>

        {/* Memo */}
        <div>
          <label className="text-sm font-medium block mb-1.5">Memo <span className="text-muted-foreground font-normal">(optional)</span></label>
          <input
            type="text"
            placeholder="What's this for?"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-secondary text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-all"
          />
        </div>

        {/* Error */}
        {writeError && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            {writeError.message.slice(0, 120)}
          </div>
        )}

        {/* CTA */}
        <button
          onClick={handleSend}
          disabled={!canSend}
          className={`w-full py-3 rounded-lg font-semibold text-sm transition-all ${
            canSend
              ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_hsl(221_83%_53%/0.3)] glow-pulse"
              : "bg-secondary text-muted-foreground cursor-not-allowed"
          }`}
        >
          {isSending ? "Confirm in wallet..." : isConfirming ? "Confirming on chain..." : "Send USDC"}
        </button>
      </div>
    </div>
  );
}
