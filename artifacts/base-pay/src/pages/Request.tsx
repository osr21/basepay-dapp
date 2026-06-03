import { useState } from "react";
import { useAccount } from "wagmi";
import { QRCodeSVG } from "qrcode.react";
import { useCreatePaymentRequest, getListPaymentRequestsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { WalletButton } from "@/components/Layout";

export default function RequestPage() {
  const { address, isConnected } = useAccount();
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState<"USDC" | "ETH">("USDC");
  const [memo, setMemo] = useState("");
  const [created, setCreated] = useState<{ id: string; amount: string; token: string; memo?: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const queryClient = useQueryClient();

  const { mutate: createRequest, isPending } = useCreatePaymentRequest({
    mutation: {
      onSuccess: (data) => {
        setCreated(data);
        queryClient.invalidateQueries({ queryKey: getListPaymentRequestsQueryKey({ recipientAddress: address }) });
      },
    },
  });

  const isValidAmount = parseFloat(amount) > 0;

  function handleCreate() {
    if (!address || !isValidAmount) return;
    createRequest({ data: { recipientAddress: address, amount, token, memo: memo || undefined } });
  }

  const payUrl = created
    ? `${window.location.origin}${import.meta.env.BASE_URL}pay/${created.id}`
    : "";

  function handleCopy() {
    navigator.clipboard.writeText(payUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to create a payment request</p>
        <WalletButton />
      </div>
    );
  }

  if (created) {
    return (
      <div className="max-w-md mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-bold">Payment Request Created</h1>
          <p className="text-sm text-muted-foreground">Share this link to get paid</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
          {/* QR Code */}
          <div className="flex justify-center">
            <div className="p-4 rounded-xl bg-white">
              <QRCodeSVG value={payUrl} size={180} />
            </div>
          </div>

          {/* Amount badge */}
          <div className="text-center">
            <p className="text-3xl font-bold">{created.amount} <span className="text-primary">{created.token}</span></p>
            {created.memo && <p className="text-sm text-muted-foreground mt-1">{created.memo}</p>}
          </div>

          {/* Link */}
          <div className="rounded-lg border border-border bg-secondary px-3.5 py-2.5 flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground flex-1 truncate">{payUrl}</span>
            <button
              onClick={handleCopy}
              className={`text-xs font-semibold shrink-0 px-2.5 py-1 rounded-md transition-all ${copied ? "text-green-400 bg-green-500/10" : "text-primary hover:bg-primary/10"}`}
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>

          <button
            onClick={() => { setCreated(null); setAmount(""); setMemo(""); }}
            className="w-full py-2.5 rounded-lg border border-border bg-secondary text-sm font-medium hover:bg-secondary/60 transition-all"
          >
            Create Another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold">Request Payment</h1>
        <p className="text-sm text-muted-foreground">Create a shareable payment link</p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
        {/* Amount */}
        <div>
          <label className="text-sm font-medium block mb-1.5">Amount</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <input
                type="number"
                placeholder="0.00"
                value={amount}
                min="0"
                step="0.01"
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-lg border border-border bg-secondary text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-all"
              />
            </div>
            <div className="flex rounded-lg border border-border overflow-hidden text-sm">
              {(["USDC", "ETH"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setToken(t)}
                  className={`px-3.5 py-2.5 font-semibold transition-all ${token === t ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}
                >
                  {t}
                </button>
              ))}
            </div>
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

        <button
          onClick={handleCreate}
          disabled={!isValidAmount || isPending}
          className={`w-full py-3 rounded-lg font-semibold text-sm transition-all ${
            isValidAmount && !isPending
              ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_hsl(221_83%_53%/0.3)]"
              : "bg-secondary text-muted-foreground cursor-not-allowed"
          }`}
        >
          {isPending ? "Creating..." : "Generate Payment Link"}
        </button>
      </div>
    </div>
  );
}
