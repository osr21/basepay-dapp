/**
 * BlockaidNotice — shown near permit-sign buttons on all pages that use EIP-2612.
 *
 * MetaMask's Blockaid scanner may flag BasePay's contracts as "untrusted" while
 * they are newly deployed (Blockaid indexes independently from Basescan).
 * All 4 V2 contracts are source-verified on Basescan. This notice prepares users
 * to see the warning and proceed confidently.
 */

interface Props {
  contractAddress: string;
  contractName: string;
}

const BASESCAN = "https://basescan.org/address/";

export default function BlockaidNotice({ contractAddress, contractName }: Props) {
  return (
    <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3.5 py-3 text-xs text-yellow-300/90 space-y-1.5">
      <div className="flex items-start gap-2">
        <svg className="shrink-0 mt-0.5" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" x2="12" y1="9" y2="13"/>
          <line x1="12" x2="12.01" y1="17" y2="17"/>
        </svg>
        <span>
          <span className="font-semibold text-yellow-200">MetaMask may show a Blockaid security warning.</span>
          {" "}This is a false positive — BasePay's contracts are new and not yet indexed by Blockaid's database.
        </span>
      </div>
      <p>
        The spender will be the{" "}
        <a
          href={`${BASESCAN}${contractAddress}#code`}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 text-yellow-200 hover:text-yellow-100 transition-colors font-mono"
        >
          {contractName}
        </a>
        {" "}contract — source-verified on Basescan. If you see the warning, click <span className="font-semibold text-yellow-200">"Proceed anyway"</span>.
      </p>
    </div>
  );
}
