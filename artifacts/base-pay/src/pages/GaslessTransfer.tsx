import { useState } from "react";
import { useAccount, useReadContract, useChainId } from "wagmi";
import { isAddress, parseUnits, formatUnits } from "viem";
import { base } from "viem/chains";
import { useGetGaslessFee, useSubmitGaslessTransfer } from "@workspace/api-client-react";
import { useListContacts } from "@workspace/api-client-react";
import { GASLESS_TOKENS, truncateAddress, type GaslessToken } from "@/lib/wagmi";
import { useUsdcAuthorization } from "@/lib/useUsdcAuthorization";
import { useBasenameResolve } from "@/lib/useBasename";
import { WalletButton } from "@/components/Layout";
import WalletName from "@/components/WalletName";

type Step = "idle" | "signing" | "relaying" | "done";

export default function GaslessTransferPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();

  // Token selection — default to USDC
  const [selectedToken, setSelectedToken] = useState<GaslessToken>(GASLESS_TOKENS[0]);

  const [to,           setTo]           = useState("");
  const [amount,       setAmount]       = useState("");
  const [showContacts, setShowContacts] = useState(false);
  const [step,         setStep]         = useState<Step>("idle");
  const [txHash,       setTxHash]       = useState<string | undefined>();
  const [error,        setError]        = useState<string | undefined>();

  const { data: feeInfo }  = useGetGaslessFee();
  const { data: contacts } = useListContacts(
    { ownerAddress: address },
    { query: { enabled: !!address, queryKey: ["listContacts", address] } },
  );

  const { data: rawBalance, isLoading: isLoadingBalance } = useReadContract({
    address:      selectedToken.address,
    abi:          [{ type: "function", name: "balanceOf", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" }] as const,
    functionName: "balanceOf",
    args:         address ? [address] : undefined,
    query:        { enabled: !!address, refetchInterval: 15_000 },
  });
  const tokenBalance = rawBalance !== undefined
    ? { value: rawBalance as bigint, decimals: selectedToken.decimals }
    : undefined;

  const { signAuthorization }          = useUsdcAuthorization(address as `0x${string}` | undefined, selectedToken);
  const { mutateAsync: relayTransfer } = useSubmitGaslessTransfer();

  // ── Basenames forward resolution ────────────────────────────────────────────
  const {
    isName: toIsBasename,
    data:   toResolved,
    isFetching: isResolvingName,
  } = useBasenameResolve(to);

  const effectiveTo: string = (toIsBasename && toResolved) ? toResolved : to;

  const isValidAddress = isAddress(effectiveTo);
  const isValidAmount  = parseFloat(amount) > 0;
  const isBusy         = step === "signing" || step === "relaying";
  const canSend        = isValidAddress && isValidAmount && !isBusy && step === "idle" && chainId === base.id;

  async function handleSend() {
    if (!canSend || !address) return;
    setError(undefined);

    if (effectiveTo.toLowerCase() === address.toLowerCase()) {
      setError("Recipient cannot be your own address.");
      return;
    }

    try {
      // 1. Sign off-chain — no gas, no wallet popup with "transaction"
      setStep("signing");
      const value = parseUnits(amount, selectedToken.decimals);
      const { v, r, s, nonce, validAfter, validBefore } = await signAuthorization(
        effectiveTo as `0x${string}`,
        value,
      );

      // 2. POST to relayer — API server pays gas and submits on-chain
      setStep("relaying");
      const result = await relayTransfer({
        data: {
          token:       selectedToken.address,
          from:        address,
          to:          effectiveTo,
          value:       value.toString(),
          validAfter:  validAfter.toString(),
          validBefore: validBefore.toString(),
          nonce,
          v,
          r,
          s,
        },
      });

      setTxHash(result.txHash);
      setStep("done");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.toLowerCase().includes("rejected") && !msg.toLowerCase().includes("denied")) {
        setError(msg.slice(0, 400));
      }
      setStep("idle");
    }
  }

  function handleReset() {
    setTo(""); setAmount("");
    setStep("idle"); setTxHash(undefined); setError(undefined);
  }

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to send gasless stablecoins</p>
        <WalletButton />
      </div>
    );
  }

  // ── Signing ────────────────────────────────────────────────────────────────
  if (step === "signing") {
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
            This is an off-chain signature — <span className="text-green-400 font-medium">not a transaction</span>.
            Zero gas. No ETH spent. No approval dialogs.
          </p>
          <p className="text-xs text-muted-foreground font-mono">Waiting for signature...</p>
        </div>
      </div>
    );
  }

  // ── Relaying ───────────────────────────────────────────────────────────────
  if (step === "relaying") {
    return (
      <div className="max-w-md mx-auto">
        <div className="rounded-2xl border border-blue-500/20 bg-card p-8 text-center space-y-4">
          <div className="w-14 h-14 rounded-full border border-blue-500/30 bg-blue-500/10 flex items-center justify-center mx-auto glow-pulse">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="hsl(217,91%,60%)" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>
            </svg>
          </div>
          <h2 className="text-lg font-bold">Relaying transaction...</h2>
          <p className="text-sm text-muted-foreground">
            The BasePay relayer is submitting your transfer on-chain. This takes a moment.
          </p>
        </div>
      </div>
    );
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (step === "done") {
    const humanVal = parseFloat(amount).toFixed(2);
    return (
      <div className="max-w-md mx-auto space-y-4">
        <div className="rounded-2xl border border-green-500/20 bg-green-500/5 p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-green-500/10 border border-green-500/30 flex items-center justify-center mx-auto mb-4">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(74 222 128)" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <h2 className="text-xl font-bold mb-1">Transfer Sent</h2>
          <p className="text-muted-foreground text-sm mb-1">
            {humanVal} {selectedToken.symbol} to
          </p>
          <WalletName address={to} showAvatar={true} avatarSize={20} className="text-sm mb-2 justify-center" />

          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-green-500/10 border border-green-500/20 text-xs text-green-400 font-medium mb-4">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            Zero gas paid — relayed by BasePay
          </div>

          {txHash && (
            <a
              href={`https://basescan.org/tx/${txHash}`}
              target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-primary text-sm hover:underline mb-5 block"
            >
              View on BaseScan
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
            </a>
          )}

          <div>
            <button onClick={handleReset} className="px-5 py-2 rounded-lg bg-secondary text-sm hover:bg-secondary/80 transition-all">
              Send Another
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  const relayerReady = feeInfo?.relayerReady ?? true;

  return (
    <div className="max-w-md mx-auto space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-0.5">
          <h1 className="text-xl font-bold">Gasless Transfer</h1>
          <span className="px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/20 text-xs text-green-400 font-semibold">Zero ETH</span>
        </div>
        <p className="text-sm text-muted-foreground">Send stablecoins with only a wallet signature — no gas, ever</p>
      </div>

      {/* How it works */}
      <div className="rounded-xl border border-primary/15 bg-primary/5 px-4 py-3 text-xs space-y-1.5 text-muted-foreground">
        <p className="text-foreground font-semibold text-sm mb-1">How it works</p>
        <div className="flex items-start gap-2">
          <span className="text-primary font-bold mt-px">1.</span>
          <span>You sign an off-chain message in your wallet (no ETH, no network fee)</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-primary font-bold mt-px">2.</span>
          <span>BasePay's relayer submits the transaction on-chain and pays the gas</span>
        </div>
        <div className="flex items-start gap-2">
          <span className="text-green-400 font-bold mt-px">✓</span>
          <span className="text-green-400">Recipient receives the full amount. Relay fee: <strong>free</strong></span>
        </div>
      </div>

      {/* Relayer status */}
      {feeInfo && (
        <div className={`rounded-lg border px-3.5 py-2.5 flex items-center gap-3 text-xs ${
          relayerReady
            ? "border-green-500/20 bg-green-500/5"
            : "border-yellow-500/30 bg-yellow-500/5"
        }`}>
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${relayerReady ? "bg-green-400" : "bg-yellow-400"}`} />
          <div>
            <span className={`font-semibold ${relayerReady ? "text-green-400" : "text-yellow-400"}`}>
              {relayerReady ? "Relayer online" : "Relayer low on funds"}
            </span>
            <span className="text-muted-foreground ml-2">
              {feeInfo.networkName} · ETH balance: {parseFloat(feeInfo.relayerEthBalance ?? "0").toFixed(4)}
            </span>
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
        {/* Token selector */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium">Token</label>
            {/* Balance indicator */}
            <span className="text-xs text-muted-foreground">
              {isLoadingBalance && !!address ? (
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-full border border-primary border-t-transparent animate-spin" />
                  Loading…
                </span>
              ) : tokenBalance ? (
                <span className="font-mono tabular-nums">
                  Balance:{" "}
                  <span className="text-foreground font-semibold">
                    {parseFloat(formatUnits(tokenBalance.value, tokenBalance.decimals)).toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>{" "}
                  {selectedToken.symbol}
                </span>
              ) : null}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {GASLESS_TOKENS.map((token) => (
              <button
                key={token.address}
                onClick={() => setSelectedToken(token)}
                className={`flex items-center gap-2.5 px-3.5 py-2.5 rounded-lg border text-sm font-medium transition-all ${
                  selectedToken.address === token.address
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-secondary text-muted-foreground hover:border-primary/40 hover:text-foreground"
                }`}
              >
                <span className="text-base leading-none">{token.flag}</span>
                <span className="font-semibold">{token.symbol}</span>
                {selectedToken.address === token.address && (
                  <svg className="ml-auto" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="hsl(221,83%,63%)" strokeWidth="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Recipient */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm font-medium">Recipient</label>
            {contacts && contacts.length > 0 && (
              <button onClick={() => setShowContacts(!showContacts)} className="text-xs text-primary hover:underline">
                {showContacts ? "Hide contacts" : "From contacts"}
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
                  <WalletName address={c.walletAddress} className="text-xs text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
          <input
            type="text"
            placeholder="0x... address or name.base.eth"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={`w-full px-3.5 py-2.5 rounded-lg border bg-secondary text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 transition-all ${
              to && !isValidAddress && !isResolvingName
                ? "border-destructive/60 focus:ring-destructive/40"
                : "border-border focus:ring-primary/40 focus:border-primary/40"
            }`}
          />
          {toIsBasename && isResolvingName && (
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
              Resolving Basename…
            </p>
          )}
          {toIsBasename && !isResolvingName && toResolved && (
            <p className="text-xs text-green-400 mt-1 font-mono flex items-center gap-1">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              {truncateAddress(toResolved)}
              <span className="text-muted-foreground font-sans">via Basenames</span>
            </p>
          )}
          {toIsBasename && !isResolvingName && !toResolved && (
            <p className="text-xs text-destructive mt-1">Basename not found on Base</p>
          )}
          {to && !toIsBasename && !isValidAddress && (
            <p className="text-xs text-destructive mt-1">Invalid address or Basename</p>
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
              className="w-full px-3.5 py-2.5 pr-28 rounded-lg border border-border bg-secondary text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/40 focus:border-primary/40 transition-all"
            />
            <div className="absolute right-2.5 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
              {tokenBalance && tokenBalance.value > 0n && (
                <button
                  type="button"
                  onClick={() => setAmount(formatUnits(tokenBalance.value, tokenBalance.decimals))}
                  className="text-[10px] font-bold text-primary bg-primary/10 hover:bg-primary/20 px-1.5 py-0.5 rounded transition-colors"
                >
                  MAX
                </button>
              )}
              <span className="text-xs font-semibold text-primary bg-primary/10 px-2 py-0.5 rounded whitespace-nowrap">
                {selectedToken.flag} {selectedToken.symbol}
              </span>
            </div>
          </div>
        </div>

        {/* Fee summary */}
        {isValidAmount && (
          <div className="rounded-lg bg-secondary border border-border px-3.5 py-3 text-xs space-y-1.5">
            <div className="flex justify-between text-muted-foreground">
              <span>Amount</span>
              <span>{amount} {selectedToken.symbol}</span>
            </div>
            <div className="flex justify-between text-green-400">
              <span>Relay fee</span>
              <span>Free</span>
            </div>
            <div className="flex justify-between font-semibold text-foreground border-t border-border pt-1.5">
              <span>Recipient gets</span>
              <span>{amount} {selectedToken.symbol}</span>
            </div>
            <div className="flex justify-between text-muted-foreground/60">
              <span>Gas cost to you</span>
              <span className="text-green-400">$0.00</span>
            </div>
          </div>
        )}

        {/* MetaMask Blockaid notice — shown only when ready to sign */}
        {canSend && relayerReady && (
          <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3.5 py-3 text-xs space-y-1.5">
            <div className="flex items-center gap-1.5 font-semibold text-yellow-400">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              MetaMask may warn "deceptive request"
            </div>
            <p className="text-muted-foreground leading-relaxed">
              This is expected for gasless transfers. Your wallet signs an off-chain message (EIP-3009) — MetaMask's Blockaid flags the recipient address as an "untrusted spender" because it's unfamiliar. No approval or on-chain transaction is requested from you.
            </p>
            <p className="text-muted-foreground">
              Before confirming: verify the <span className="text-yellow-400 font-medium">spender address</span> in MetaMask matches the recipient you entered above.
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* CTA */}
        <button
          onClick={handleSend}
          disabled={!canSend || !relayerReady}
          className={`w-full py-3 rounded-lg font-semibold text-sm transition-all ${
            canSend && relayerReady
              ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-[0_0_20px_hsl(221_83%_53%/0.3)] glow-pulse"
              : "bg-secondary text-muted-foreground cursor-not-allowed"
          }`}
        >
          {chainId !== base.id ? "Wrong Network" : `Sign & Send ${selectedToken.symbol} Gasless`}
        </button>
        <p className="text-center text-xs text-muted-foreground">
          1 signature · 0 ETH · 0 approvals
        </p>
      </div>
    </div>
  );
}
