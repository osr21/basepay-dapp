import { useState } from "react";

interface Props {
  contractName: string;
  contractAddress: string;
  onProceed: () => void;
  onCancel?: () => void;
  proceedLabel?: string;
}

export function BlockaidWarning({ contractName, contractAddress, onProceed, onCancel, proceedLabel = "Proceed with Approval" }: Props) {
  const [expanded, setExpanded] = useState(false);
  const basescanUrl = `https://basescan.org/address/${contractAddress}#code`;

  return (
    <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center flex-shrink-0 mt-0.5">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="rgb(245 158 11)" strokeWidth="2">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" x2="12" y1="9" y2="13"/>
            <line x1="12" x2="12.01" y1="17" y2="17"/>
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-400">Your wallet may show a security warning</p>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            <strong className="text-foreground">{contractName}</strong> is a newly deployed contract — wallet security scanners (Blockaid) flag all new contracts as "untrusted" until they are reviewed. This is a <span className="text-amber-400 font-medium">false positive</span>.
          </p>
        </div>
      </div>

      <button
        className="text-xs text-primary hover:underline flex items-center gap-1"
        onClick={() => setExpanded(e => !e)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={`transition-transform ${expanded ? "rotate-180" : ""}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
        {expanded ? "Hide details" : "Why is this safe?"}
      </button>

      {expanded && (
        <div className="text-xs text-muted-foreground space-y-2 bg-background/40 rounded-lg p-3 border border-amber-500/10">
          <p>✅ <span className="text-foreground font-medium">Source-verified on BaseScan</span> — the contract code is public and auditable.</p>
          <p>✅ <span className="text-foreground font-medium">Approval is exact</span> — you are approving only the amount needed for this transaction, not unlimited access.</p>
          <p>✅ <span className="text-foreground font-medium">CEI pattern</span> — the contract updates state before any external call, preventing reentrancy.</p>
          <a
            href={basescanUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-primary hover:underline mt-1"
          >
            View verified contract on BaseScan
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" x2="21" y1="14" y2="3"/>
            </svg>
          </a>
        </div>
      )}

      <div className="flex gap-2 pt-1">
        {onCancel && (
          <button
            onClick={onCancel}
            className="flex-1 py-2 rounded-lg border border-border bg-secondary text-sm hover:bg-secondary/80 transition-all"
          >
            Cancel
          </button>
        )}
        <button
          onClick={onProceed}
          className="flex-1 py-2 rounded-lg bg-amber-500/20 border border-amber-500/40 text-amber-300 font-semibold text-sm hover:bg-amber-500/30 transition-all"
        >
          {proceedLabel}
        </button>
      </div>

      <p className="text-[10px] text-muted-foreground/60 text-center">
        You can click <span className="font-medium">"Report an issue"</span> in the wallet warning to help Blockaid whitelist this contract faster.
      </p>
    </div>
  );
}
