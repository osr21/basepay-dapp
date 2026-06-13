import { useState, useEffect, useCallback } from "react";
import { useAccount, useWriteContract, useSwitchChain, useReadContract, useChainId } from "wagmi";
import { waitForTransactionReceipt, getTransactionReceipt } from "wagmi/actions";
import { parseUnits, isAddress, decodeAbiParameters, keccak256 } from "viem";
import { mainnet, optimism, arbitrum, polygon, base } from "viem/chains";
import type { Chain } from "viem";
import { WalletButton } from "@/components/Layout";
import { config, formatUSDC } from "@/lib/wagmi";

// ── Chain registry ─────────────────────────────────────────────────────────────
// Each entry has everything needed for both the burn (src) and receive (dest) side.
// CCTP v1 mainnet addresses — https://developers.circle.com/stablecoins/docs/evm-smart-contracts

interface ChainConfig {
  chain:              Chain;
  label:              string;
  domain:             number;
  tokenMessenger:     `0x${string}`;
  messageTransmitter: `0x${string}`;
  usdc:               `0x${string}`;
  explorer:           string;
  icon:               string;
}

const CHAINS: ChainConfig[] = [
  {
    chain:              base,
    label:              "Base",
    domain:             6,
    tokenMessenger:     "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962",
    messageTransmitter: "0xAD09780d193884d503182aD4588450C416D6F9D4",
    usdc:               "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorer:           "https://basescan.org",
    icon:               "🔵",
  },
  {
    chain:              mainnet,
    label:              "Ethereum",
    domain:             0,
    tokenMessenger:     "0xBd3fa81B58Ba92a82136038B25aDec7066af3155",
    messageTransmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81",
    usdc:               "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    explorer:           "https://etherscan.io",
    icon:               "Ξ",
  },
  {
    chain:              optimism,
    label:              "Optimism",
    domain:             2,
    tokenMessenger:     "0x2B4069517957735bE00ceE0fadAE88a26365528f",
    messageTransmitter: "0x4d41f22c5a0e5c74090899e5a8fb597a8842b3e8",
    usdc:               "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    explorer:           "https://optimistic.etherscan.io",
    icon:               "⬡",
  },
  {
    chain:              arbitrum,
    label:              "Arbitrum",
    domain:             3,
    tokenMessenger:     "0x19330d10D9Cc8751218eaf51E8885D058642E08A",
    messageTransmitter: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca",
    usdc:               "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    explorer:           "https://arbiscan.io",
    icon:               "△",
  },
  {
    chain:              polygon,
    label:              "Polygon",
    domain:             7,
    tokenMessenger:     "0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE",
    messageTransmitter: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9",
    usdc:               "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    explorer:           "https://polygonscan.com",
    icon:               "⬟",
  },
];

// keccak256("MessageSent(bytes)") — emitted by MessageTransmitter on every chain
const MESSAGE_SENT_TOPIC = "0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036" as const;

// ── Minimal ABIs ──────────────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    name: "approve",
    type: "function" as const,
    inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable" as const,
  },
  {
    name: "allowance",
    type: "function" as const,
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
  {
    name: "balanceOf",
    type: "function" as const,
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view" as const,
  },
] as const;

const TOKEN_MESSENGER_ABI = [
  {
    name: "depositForBurn",
    type: "function" as const,
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
    ],
    outputs: [{ name: "nonce", type: "uint64" }],
    stateMutability: "nonpayable" as const,
  },
] as const;

const MESSAGE_TRANSMITTER_ABI = [
  {
    name: "receiveMessage",
    type: "function" as const,
    inputs: [{ name: "message", type: "bytes" }, { name: "attestation", type: "bytes" }],
    outputs: [{ name: "success", type: "bool" }],
    stateMutability: "nonpayable" as const,
  },
] as const;

// ── Types ─────────────────────────────────────────────────────────────────────

type Phase =
  | "idle"
  | "approving"
  | "burning"
  | "attesting"
  | "ready"
  | "switching"
  | "receiving"
  | "done"
  | "error";

const STEP_LABELS: Record<Phase, string> = {
  idle:      "Enter details",
  approving: "Approve USDC spend",
  burning:   "Burning USDC",
  attesting: "Waiting for Circle attestation",
  ready:     "Ready to receive",
  switching: "Switching chain",
  receiving: "Receiving on destination",
  done:      "Transfer complete",
  error:     "Error",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

type CfgChainId = (typeof config)["chains"][number]["id"];

function TxLink({ hash, explorer }: { hash: string; explorer: string }) {
  return (
    <a
      href={`${explorer}/tx/${hash}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary hover:text-primary/80 font-mono text-xs transition-colors"
    >
      {hash.slice(0, 10)}…{hash.slice(-6)}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
        <polyline points="15 3 21 3 21 9"/>
        <line x1="10" x2="21" y1="14" y2="3"/>
      </svg>
    </a>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function CrossChainPage() {
  const { address, isConnected } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync }   = useSwitchChain();
  const chainId                = useChainId();

  const [srcIndex,  setSrcIndex]  = useState(0); // Base
  const [destIndex, setDestIndex] = useState(1); // Ethereum

  const src  = CHAINS[srcIndex];
  const dest = CHAINS[destIndex];

  // ── USDC balance on source chain ───────────────────────────────────────────
  const { data: usdcBalanceRaw } = useReadContract({
    address:      src.usdc,
    abi:          ERC20_ABI,
    functionName: "balanceOf",
    args:         address ? [address] : undefined,
    chainId:      src.chain.id as CfgChainId,
    query:        { enabled: !!address, refetchInterval: 15_000 },
  });

  const [amount,          setAmount]          = useState("");
  const [recipient,       setRecipient]       = useState("");
  const [phase,           setPhase]           = useState<Phase>("idle");
  const [burnTxHash,      setBurnTxHash]      = useState<`0x${string}` | null>(null);
  const [messageBytes,    setMessageBytes]    = useState<`0x${string}` | null>(null);
  const [messageHash,     setMessageHash]     = useState<string | null>(null);
  const [attestation,     setAttestation]     = useState<string | null>(null);
  const [receiveTxHash,   setReceiveTxHash]   = useState<`0x${string}` | null>(null);
  const [error,           setError]           = useState<string | null>(null);
  const [pollCount,       setPollCount]       = useState(0);
  const [attestWarning,   setAttestWarning]   = useState<"slow" | "very-slow" | null>(null);
  const [burnExplorer,    setBurnExplorer]    = useState("");
  const [receiveExplorer, setReceiveExplorer] = useState("");

  // ── Resume flow state ──────────────────────────────────────────────────────
  const [showResume,       setShowResume]       = useState(false);
  const [resumeTxHash,     setResumeTxHash]     = useState("");
  const [resumeSrcIndex,   setResumeSrcIndex]   = useState(0);
  const [isResuming,       setIsResuming]       = useState(false);
  const [isRelaying,       setIsRelaying]       = useState(false);
  // Set to true when the gasless relayer is underfunded — nudges user to self-relay
  const [selfRelayNeeded,  setSelfRelayNeeded]  = useState(false);

  const isActive = phase !== "idle" && phase !== "done" && phase !== "error";

  // ── Chain selector helpers ─────────────────────────────────────────────────

  function handleSrcChange(newSrc: number) {
    if (newSrc === destIndex) setDestIndex(srcIndex);
    setSrcIndex(newSrc);
  }

  function handleDestChange(newDest: number) {
    if (newDest === srcIndex) setSrcIndex(destIndex);
    setDestIndex(newDest);
  }

  function flipDirection() {
    setSrcIndex(destIndex);
    setDestIndex(srcIndex);
  }

  // ── Attestation polling ────────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "attesting" || !messageHash) return;
    let cancelled = false;
    let count = 0;
    let tid: ReturnType<typeof setTimeout>;

    async function poll() {
      if (cancelled) return;
      try {
        const res  = await fetch(`${import.meta.env.BASE_URL}api/cctp/attestation/${messageHash}`);
        const data = await res.json() as { status?: string; attestation?: string };
        if (data.status === "complete" && data.attestation) {
          if (!cancelled) {
            setAttestation(data.attestation);
            setPhase("ready");
          }
          return;
        }
      } catch { /* keep polling */ }
      if (!cancelled) {
        count++;
        setPollCount(count);
        // Hard stop at 720 polls (~1 hour) — burn is safe on-chain, Circle is likely down
        if (count >= 720) {
          if (!cancelled) {
            setError(
              "Attestation timed out after 1 hour. Your USDC is safely burned and will not be lost. " +
              "Check https://status.circle.com — when Circle recovers, refresh and use the burn tx link to resubmit the receive step."
            );
            setPhase("error");
          }
          return;
        }
        if (count >= 120) setAttestWarning("very-slow");
        else if (count >= 60) setAttestWarning("slow");
        tid = setTimeout(poll, 5_000);
      }
    }

    poll();
    return () => { cancelled = true; clearTimeout(tid); };
  }, [phase, messageHash]);

  // ── Initiate transfer (approve + depositForBurn on src chain) ──────────────
  const handleInitiate = useCallback(async () => {
    if (!address || !amount || !recipient) return;
    setError(null);

    try {
      let amountAtomics: bigint;
      try {
        amountAtomics = parseUnits(amount, 6);
      } catch {
        throw new Error("Invalid amount — USDC supports up to 6 decimal places");
      }

      if (amountAtomics <= 0n) throw new Error("Amount must be greater than 0");
      if (!isAddress(recipient))  throw new Error("Invalid recipient address");

      if (usdcBalanceRaw !== undefined && amountAtomics > usdcBalanceRaw) {
        throw new Error(
          `Insufficient USDC balance — you have ${formatUSDC(usdcBalanceRaw)} USDC on ${src.label}`
        );
      }

      // Ensure wallet is on the source chain before touching source contracts
      if (chainId !== src.chain.id) {
        setPhase("switching");
        await switchChainAsync({ chainId: src.chain.id });
      }

      const srcChainId = src.chain.id as CfgChainId;

      // ── 1. Approve source TokenMessenger to spend USDC ──
      setPhase("approving");
      const approveTx = await writeContractAsync({
        address:      src.usdc,
        abi:          ERC20_ABI,
        functionName: "approve",
        args:         [src.tokenMessenger, amountAtomics],
        gas:          65_000n,
      });
      await waitForTransactionReceipt(config, { hash: approveTx, chainId: srcChainId });

      // ── 2. depositForBurn → mints to dest chain ──
      setPhase("burning");
      const mintRecipient = `0x${recipient.slice(2).padStart(64, "0")}` as `0x${string}`;
      const burnTx = await writeContractAsync({
        address:      src.tokenMessenger,
        abi:          TOKEN_MESSENGER_ABI,
        functionName: "depositForBurn",
        args:         [amountAtomics, dest.domain, mintRecipient, src.usdc],
        gas:          300_000n,
      });
      setBurnTxHash(burnTx);
      setBurnExplorer(src.explorer);

      const burnReceipt = await waitForTransactionReceipt(config, { hash: burnTx, chainId: srcChainId });

      // ── 3. Parse MessageSent from src MessageTransmitter ──
      const log = burnReceipt.logs.find(
        l => l.address.toLowerCase() === src.messageTransmitter.toLowerCase()
          && l.topics[0] === MESSAGE_SENT_TOPIC,
      );
      if (!log) throw new Error("MessageSent event not found — confirm tx on the block explorer and retry");

      const [msgBytes] = decodeAbiParameters([{ type: "bytes" }], log.data);
      const msgHash    = keccak256(msgBytes);

      setMessageBytes(msgBytes);
      setMessageHash(msgHash);
      setPhase("attesting");

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg.includes("rejected") ? "Transaction rejected" : msg.slice(0, 200));
      setPhase("error");
    }
  }, [address, amount, recipient, src, dest, writeContractAsync, switchChainAsync, chainId, usdcBalanceRaw]);

  // ── Receive on destination chain ───────────────────────────────────────────
  const handleReceive = useCallback(async () => {
    if (!attestation || !messageBytes) return;
    setError(null);

    try {
      setPhase("switching");
      await switchChainAsync({ chainId: dest.chain.id });

      setPhase("receiving");
      const destChainId = dest.chain.id as CfgChainId;
      const receiveTx = await writeContractAsync({
        address:      dest.messageTransmitter,
        abi:          MESSAGE_TRANSMITTER_ABI,
        functionName: "receiveMessage",
        args:         [messageBytes, attestation as `0x${string}`],
        chain:        dest.chain,
        gas:          400_000n,
      });
      setReceiveTxHash(receiveTx);
      setReceiveExplorer(dest.explorer);

      await waitForTransactionReceipt(config, { hash: receiveTx, chainId: destChainId });
      setPhase("done");

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg.includes("rejected") ? "Transaction rejected" : msg.slice(0, 200));
      setPhase("ready");
    }
  }, [attestation, messageBytes, dest, switchChainAsync, writeContractAsync]);

  // ── Resume a failed transfer from a burn tx hash ──────────────────────────
  // Fetches the receipt on-chain, parses the MessageSent log, auto-detects the
  // destination domain from the CCTP message header, and jumps to attestation.
  const handleResume = useCallback(async () => {
    if (!resumeTxHash) return;
    setIsResuming(true);
    setError(null);
    try {
      const trimmed = resumeTxHash.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
        throw new Error("Invalid transaction hash — paste the full 0x-prefixed hash from the source chain explorer");
      }
      const resumeSrcCfg = CHAINS[resumeSrcIndex];
      const receipt = await getTransactionReceipt(config, {
        hash:    trimmed as `0x${string}`,
        chainId: resumeSrcCfg.chain.id as CfgChainId,
      });
      const log = receipt.logs.find(
        l => l.address.toLowerCase() === resumeSrcCfg.messageTransmitter.toLowerCase()
          && l.topics[0] === MESSAGE_SENT_TOPIC,
      );
      if (!log) throw new Error("No MessageSent event found — check you selected the correct source chain");
      const [msgBytes] = decodeAbiParameters([{ type: "bytes" }], log.data);
      const msgHash    = keccak256(msgBytes);
      // CCTP message header: 4 bytes version | 4 bytes sourceDomain | 4 bytes destinationDomain
      // As 0x-prefixed hex: chars 18–26 = destination domain uint32 big-endian
      const destDomain   = parseInt(msgBytes.slice(18, 26), 16);
      const detectedDest = CHAINS.findIndex(c => c.domain === destDomain);
      if (detectedDest === -1) throw new Error(`Unsupported destination domain ${destDomain}`);
      setBurnTxHash(trimmed as `0x${string}`);
      setBurnExplorer(resumeSrcCfg.explorer);
      setMessageBytes(msgBytes);
      setMessageHash(msgHash);
      setSrcIndex(resumeSrcIndex);
      setDestIndex(detectedDest);
      setShowResume(false);
      setResumeTxHash("");
      setPhase("attesting");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg.slice(0, 250));
    } finally {
      setIsResuming(false);
    }
  }, [resumeTxHash, resumeSrcIndex]);

  // ── Gasless receive — relayer submits receiveMessage on the destination chain ─
  // The user pays no gas and doesn't need to switch chains.
  const handleGaslessReceive = useCallback(async () => {
    if (!attestation || !messageBytes) return;
    setError(null);
    setSelfRelayNeeded(false);
    setIsRelaying(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/cctp/relay-receive`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        // Send messageBytes only — server derives destDomain and fetches attestation itself
        body:    JSON.stringify({ messageBytes }),
      });
      const data = await res.json() as { txHash?: string; error?: string; selfRelay?: boolean };

      if (res.status === 409) {
        // Already received on-chain or relayed by this server — treat as success
        setPhase("done");
        return;
      }
      // 503 selfRelay: relayer is underfunded — nudge user to the self-relay fallback
      if (res.status === 503 && data.selfRelay) {
        setSelfRelayNeeded(true);
        return; // phase stays "ready", gasless button replaced by amber hint
      }
      if (!res.ok || !data.txHash) {
        throw new Error(data.error ?? "Relay failed");
      }

      setReceiveTxHash(data.txHash as `0x${string}`);
      setReceiveExplorer(dest.explorer);
      setPhase("receiving");

      await waitForTransactionReceipt(config, {
        hash:    data.txHash as `0x${string}`,
        chainId: dest.chain.id as CfgChainId,
      });
      setPhase("done");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg.slice(0, 200));
      setPhase("ready"); // stay on ready so user can fall back to self-relay
    } finally {
      setIsRelaying(false);
    }
  }, [attestation, messageBytes, dest]);

  function reset() {
    setPhase("idle");
    setBurnTxHash(null);
    setMessageBytes(null);
    setMessageHash(null);
    setAttestation(null);
    setReceiveTxHash(null);
    setError(null);
    setPollCount(0);
    setAttestWarning(null);
    setBurnExplorer("");
    setReceiveExplorer("");
    setSelfRelayNeeded(false);
  }

  if (!isConnected) {
    return (
      <div className="max-w-md mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center">
        <p className="text-muted-foreground mb-4">Connect your wallet to transfer USDC cross-chain</p>
        <WalletButton />
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold">Cross-Chain Transfer</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Transfer USDC between any supported chains via Circle CCTP — no bridges, no wrapped assets.
        </p>
      </div>

      {/* Progress steps */}
      {phase !== "idle" && (
        <div className="flex items-center gap-2 text-xs">
          {(["burning", "attesting", "receiving", "done"] as Phase[]).map((p, i) => {
            const steps: Phase[] = ["burning", "attesting", "receiving", "done"];
            const idx    = steps.indexOf(phase);
            const done   = i < idx || phase === "done";
            const active = phase === p || (p === "attesting" && phase === "ready");
            return (
              <span key={p} className="flex items-center gap-2">
                {i > 0 && <span className="text-border">—</span>}
                <span className={`px-2 py-0.5 rounded-full font-medium ${
                  done   ? "bg-green-500/15 text-green-400" :
                  active ? "bg-primary/15 text-primary"     :
                           "bg-secondary text-muted-foreground"
                }`}>
                  {i + 1}. {p === "attesting" ? "Attest" : p === "burning" ? "Burn" : p === "receiving" ? "Receive" : "Done"}
                </span>
              </span>
            );
          })}
        </div>
      )}

      {/* Status card */}
      {phase !== "idle" && (
        <div className="p-4 rounded-xl border border-border bg-card/50 space-y-3">
          <div className="flex items-center gap-3">
            {phase === "done"
              ? <span className="w-7 h-7 rounded-full bg-green-500/15 flex items-center justify-center text-green-400">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
              : phase === "error"
              ? <span className="w-7 h-7 rounded-full bg-red-500/15 flex items-center justify-center text-red-400">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/></svg>
                </span>
              : <span className="w-7 h-7 rounded-full border-2 border-primary/40 border-t-primary animate-spin" />
            }
            <div>
              <p className="font-medium text-sm">{STEP_LABELS[phase]}</p>
              {phase === "attesting" && (
                <p className="text-xs text-muted-foreground">
                  Checking Circle attestation service… ({pollCount} check{pollCount !== 1 ? "s" : ""})
                </p>
              )}
              {phase === "attesting" && attestWarning === "slow" && (
                <p className="text-xs text-yellow-400 mt-1">
                  Taking longer than usual — Circle attestation typically completes in 10–20 min on mainnet. Your USDC is already burned and safe.
                </p>
              )}
              {phase === "attesting" && attestWarning === "very-slow" && (
                <p className="text-xs text-orange-400 mt-1">
                  Attestation is taking an unusually long time. You can safely close this tab — the burn is final. Return later and use the same message hash to claim.{" "}
                  <a href="https://status.circle.com" target="_blank" rel="noopener noreferrer" className="underline">Check Circle status</a>.
                </p>
              )}
              {phase === "ready" && (
                <p className="text-xs text-green-400">Attestation confirmed — ready to receive</p>
              )}
            </div>
          </div>

          {burnTxHash && burnExplorer && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Burn tx:</span>
              <TxLink hash={burnTxHash} explorer={burnExplorer} />
            </div>
          )}
          {messageHash && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Message hash:</span>
              <code className="font-mono text-[10px]">{messageHash.slice(0, 18)}…</code>
              <button
                type="button"
                onClick={() => navigator.clipboard.writeText(messageHash)}
                title="Copy full message hash"
                className="hover:text-foreground transition-colors"
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect width="13" height="13" x="9" y="9" rx="2" ry="2"/>
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                </svg>
              </button>
            </div>
          )}
          {receiveTxHash && receiveExplorer && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Receive tx:</span>
              <TxLink hash={receiveTxHash} explorer={receiveExplorer} />
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400 flex gap-2">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
          {error}
        </div>
      )}

      {/* Form */}
      {(phase === "idle" || phase === "error") && (
        <div className="rounded-xl border border-border bg-card/30 divide-y divide-border">

          {/* Chain route */}
          <div className="p-4 space-y-3">
            <label className="text-sm font-medium">Transfer route</label>

            <div className="flex items-center gap-2">
              {/* Source chain */}
              <div className="flex-1 space-y-1">
                <p className="text-[10px] text-muted-foreground">From</p>
                <div className="relative">
                  <select
                    value={srcIndex}
                    onChange={e => handleSrcChange(Number(e.target.value))}
                    disabled={isActive}
                    className="w-full appearance-none px-3 py-2.5 rounded-lg border border-border bg-secondary text-sm font-medium text-foreground focus:outline-none focus:border-primary/60 transition-colors cursor-pointer pr-7 disabled:opacity-50"
                  >
                    {CHAINS.map((c, i) => (
                      <option key={c.label} value={i}>{c.icon} {c.label}</option>
                    ))}
                  </select>
                  <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground"><path d="M6 9l6 6 6-6"/></svg>
                  </div>
                </div>
              </div>

              {/* Flip button */}
              <button
                type="button"
                onClick={flipDirection}
                disabled={isActive}
                title="Swap direction"
                className="mt-5 p-2 rounded-lg border border-border bg-secondary hover:bg-secondary/80 hover:border-primary/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M7 16V4m0 0L3 8m4-4l4 4"/>
                  <path d="M17 8v12m0 0l4-4m-4 4l-4-4"/>
                </svg>
              </button>

              {/* Destination chain */}
              <div className="flex-1 space-y-1">
                <p className="text-[10px] text-muted-foreground">To</p>
                <div className="relative">
                  <select
                    value={destIndex}
                    onChange={e => handleDestChange(Number(e.target.value))}
                    disabled={isActive}
                    className="w-full appearance-none px-3 py-2.5 rounded-lg border border-border bg-secondary text-sm font-medium text-foreground focus:outline-none focus:border-primary/60 transition-colors cursor-pointer pr-7 disabled:opacity-50"
                  >
                    {CHAINS.map((c, i) => (
                      <option key={c.label} value={i}>{c.icon} {c.label}</option>
                    ))}
                  </select>
                  <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground"><path d="M6 9l6 6 6-6"/></svg>
                  </div>
                </div>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              USDC will appear as native USDC on {dest.label} — no bridge or wrapped token.
            </p>
          </div>

          {/* Amount */}
          <div className="p-4 space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">Amount (USDC)</label>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  Balance:{" "}
                  {usdcBalanceRaw === undefined
                    ? <span className="inline-block w-14 h-3 rounded bg-secondary animate-pulse align-middle" />
                    : <span className="text-foreground font-medium">{formatUSDC(usdcBalanceRaw)} USDC</span>
                  }
                </span>
                {usdcBalanceRaw !== undefined && usdcBalanceRaw > 0n && (
                  <button
                    type="button"
                    onClick={() => setAmount(formatUSDC(usdcBalanceRaw!))}
                    disabled={isActive}
                    className="text-[11px] font-semibold text-primary hover:text-primary/80 px-1.5 py-0.5 rounded border border-primary/30 hover:border-primary/60 transition-colors disabled:opacity-40"
                  >
                    Max
                  </button>
                )}
              </div>
            </div>
            <div className="relative">
              <input
                type="number"
                min="0"
                step="0.000001"
                placeholder="0.00"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                disabled={isActive}
                className="w-full px-3 py-2.5 rounded-lg border border-border bg-secondary text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 transition-colors pr-14 disabled:opacity-50"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground font-semibold">USDC</span>
            </div>
          </div>

          {/* Recipient */}
          <div className="p-4 space-y-2">
            <label className="text-sm font-medium">Recipient on {dest.label}</label>
            <input
              type="text"
              placeholder="0x…"
              value={recipient}
              onChange={e => setRecipient(e.target.value)}
              disabled={isActive}
              className="w-full px-3 py-2.5 rounded-lg border border-border bg-secondary text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 transition-colors disabled:opacity-50"
            />
            <p className="text-xs text-muted-foreground">
              Use your own address to bridge to yourself, or any other {dest.label} address.
            </p>
          </div>

          {/* Info */}
          <div className="px-4 py-3 bg-secondary/30 rounded-b-xl flex items-start gap-2.5 text-xs text-muted-foreground">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="16"/><line x1="8" x2="16" y1="12" y2="12"/></svg>
            <span>
              Requires 2 transactions on {src.label} (approve + burn).
              Circle attestation typically takes 10–20 minutes for mainnet finality.
              The gasless relayer then submits the final receive on {dest.label} — no ETH needed on the destination.
              No bridge fees.
            </span>
          </div>
        </div>
      )}

      {/* CTA Buttons */}
      <div className="flex gap-3">
        {phase === "idle" && (
          <button
            onClick={handleInitiate}
            disabled={!amount || !recipient || !address}
            className="flex-1 py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-all disabled:opacity-40 shadow-[0_0_20px_hsl(221_83%_53%/0.3)]"
          >
            Initiate Transfer →
          </button>
        )}

        {phase === "error" && (
          <>
            <button
              onClick={reset}
              className="flex-1 py-3 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition-all"
            >
              Start Over
            </button>
            {/* Hide Retry if the burn already went on-chain — re-running would burn USDC again */}
            {!burnTxHash && (
              <button
                onClick={handleInitiate}
                className="flex-1 py-3 rounded-xl bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-all"
              >
                Retry
              </button>
            )}
          </>
        )}

        {phase === "ready" && (
          <div className="flex-1 flex flex-col gap-2">
            {/* Primary: gasless — relayer pays gas, no chain switch needed */}
            {selfRelayNeeded ? (
              /* Relayer is underfunded — replace gasless button with an amber hint */
              <div className="w-full px-3 py-2.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-400 flex items-center gap-2">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/></svg>
                Gasless relayer is temporarily out of ETH on {dest.label} — use self-relay below.
              </div>
            ) : (
              <button
                onClick={handleGaslessReceive}
                disabled={isRelaying}
                className="w-full py-3 rounded-xl bg-green-600 text-white font-semibold hover:bg-green-500 transition-all shadow-[0_0_20px_rgba(34,197,94,0.25)] disabled:opacity-60 flex items-center justify-center gap-2"
              >
                {isRelaying
                  ? <><span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" /> Relaying…</>
                  : <>⚡ Gasless Receive — relayer pays gas</>
                }
              </button>
            )}
            {/* Fallback: self-relay (user switches chain and pays gas) */}
            <button
              onClick={handleReceive}
              disabled={isRelaying}
              className={`w-full py-2 rounded-xl border text-sm font-medium transition-all disabled:opacity-40 ${
                selfRelayNeeded
                  ? "border-primary/50 text-primary hover:bg-primary/10"
                  : "border-border text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }`}
            >
              Self-relay — switch to {dest.label} &amp; pay gas
            </button>
          </div>
        )}

        {phase === "done" && (
          <button
            onClick={reset}
            className="flex-1 py-3 rounded-xl border border-border text-sm font-medium hover:bg-secondary transition-all"
          >
            New Transfer
          </button>
        )}

        {(phase === "approving" || phase === "burning" || phase === "attesting" || phase === "switching" || phase === "receiving") && (
          <button
            disabled
            className="flex-1 py-3 rounded-xl bg-primary/50 text-primary-foreground font-semibold opacity-60 cursor-not-allowed"
          >
            {STEP_LABELS[phase]}…
          </button>
        )}
      </div>

      {/* CCTP explanation */}
      {phase === "idle" && (
        <div className="grid grid-cols-3 gap-3 text-xs text-muted-foreground">
          {[
            { step: "1", title: `Burn on ${src.label}`,  desc: `USDC is burned on ${src.label} via Circle's TokenMessenger` },
            { step: "2", title: "Attestation",            desc: "Circle's off-chain service attests to the burn (~10 min)" },
            { step: "3", title: `Mint on ${dest.label}`, desc: `Native USDC is minted directly to the recipient on ${dest.label}` },
          ].map(({ step, title, desc }) => (
            <div key={step} className="p-3 rounded-lg border border-border bg-card/20 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-foreground">
                <span className="w-4 h-4 rounded-full bg-primary/15 text-primary text-[10px] font-bold flex items-center justify-center">{step}</span>
                {title}
              </div>
              <p>{desc}</p>
            </div>
          ))}
        </div>
      )}

      {/* Resume a failed transfer */}
      {phase === "idle" && (
        <div className="rounded-xl border border-border bg-card/20 overflow-hidden">
          <button
            type="button"
            onClick={() => setShowResume(s => !s)}
            className="w-full px-4 py-3 flex items-center justify-between text-sm text-muted-foreground hover:text-foreground hover:bg-secondary/30 transition-colors"
          >
            <span className="flex items-center gap-2 font-medium">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
              Resume a failed transfer
            </span>
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className={`transition-transform ${showResume ? "rotate-180" : ""}`}
            >
              <path d="M6 9l6 6 6-6"/>
            </svg>
          </button>

          {showResume && (
            <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                If your burn tx succeeded but attestation timed out or the page was closed, paste the burn transaction hash below.
                The app will re-fetch the message from the chain and resume from attestation — <strong className="text-foreground">no re-burning needed</strong>.
              </p>

              <div className="space-y-1">
                <label className="text-xs font-medium">Source chain (where you burned)</label>
                <div className="relative">
                  <select
                    value={resumeSrcIndex}
                    onChange={e => setResumeSrcIndex(Number(e.target.value))}
                    className="w-full appearance-none px-3 py-2 rounded-lg border border-border bg-secondary text-sm font-medium text-foreground focus:outline-none focus:border-primary/60 transition-colors cursor-pointer pr-7"
                  >
                    {CHAINS.map((c, i) => (
                      <option key={c.label} value={i}>{c.icon} {c.label}</option>
                    ))}
                  </select>
                  <div className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground"><path d="M6 9l6 6 6-6"/></svg>
                  </div>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium">Burn transaction hash</label>
                <input
                  type="text"
                  placeholder="0x…"
                  value={resumeTxHash}
                  onChange={e => setResumeTxHash(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-secondary text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary/60 transition-colors"
                />
              </div>

              <button
                type="button"
                onClick={handleResume}
                disabled={!resumeTxHash.trim() || isResuming}
                className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-all disabled:opacity-40"
              >
                {isResuming ? "Looking up transaction…" : "Resume Transfer →"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
