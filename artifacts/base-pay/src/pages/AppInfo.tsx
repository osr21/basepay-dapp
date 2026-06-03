import { useGetAppConfig } from "@workspace/api-client-react";
import { truncateAddress } from "@/lib/wagmi";

function Row({ label, value, mono = false, children }: { label: string; value?: string | number | boolean | null; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-border last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      {children ?? (
        <span className={`text-sm font-medium ${mono ? "font-mono" : ""}`}>
          {value === null || value === undefined ? "—" : String(value)}
        </span>
      )}
    </div>
  );
}

export default function AppInfoPage() {
  const { data: config, isLoading } = useGetAppConfig();

  if (isLoading) {
    return (
      <div className="max-w-xl mx-auto space-y-4 mt-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-10 rounded-lg shimmer" />
        ))}
      </div>
    );
  }

  if (!config) return null;

  const feePercent = ((config.feeBps) / 100).toFixed(2);

  return (
    <div className="max-w-xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold">dApp Registration</h1>
          <p className="text-sm text-muted-foreground">Deployer identity and fee configuration</p>
        </div>
        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border ${
          config.verified
            ? "bg-green-500/10 text-green-400 border-green-500/20"
            : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
        }`}>
          {config.verified ? (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              Verified
            </>
          ) : "Unverified"}
        </div>
      </div>

      {/* Identity card */}
      <div className="rounded-2xl border border-border bg-card p-1">
        <div className="px-5">
          <Row label="App Name"     value={config.appName} />
          <Row label="Version"      value={`v${config.appVersion}`} />
          <Row label="Network"      value={config.network} />
          <Row label="Chain ID"     value={config.chainId} />
          <Row label="Registered"   value={new Date(config.registeredAt).toLocaleDateString()} />
        </div>
      </div>

      {/* Deployer card */}
      <div className="rounded-2xl border border-primary/20 bg-card p-1">
        <div className="px-5 py-2 border-b border-border">
          <p className="text-xs font-semibold text-primary uppercase tracking-wider">Deployer Wallet</p>
        </div>
        <div className="px-5">
          <Row label="Deployer Address" mono>
            <a
              href={`https://basescan.org/address/${config.deployerAddress}`}
              target="_blank" rel="noreferrer"
              className="text-sm font-mono text-primary hover:underline flex items-center gap-1"
            >
              {truncateAddress(config.deployerAddress)}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
            </a>
          </Row>
          <Row label="Fee Collector" mono>
            <a
              href={`https://basescan.org/address/${config.feeCollectorAddress}`}
              target="_blank" rel="noreferrer"
              className="text-sm font-mono text-primary hover:underline flex items-center gap-1"
            >
              {truncateAddress(config.feeCollectorAddress)}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
            </a>
          </Row>
          <Row label="Protocol Fee" value={`${feePercent}% (${config.feeBps} bps)`} />
          <Row label="Router Contract" mono>
            {config.routerAddress ? (
              <a
                href={`https://basescan.org/address/${config.routerAddress}`}
                target="_blank" rel="noreferrer"
                className="text-sm font-mono text-green-400 hover:underline flex items-center gap-1"
              >
                {truncateAddress(config.routerAddress)} — deployed
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/></svg>
              </a>
            ) : (
              <span className="text-xs text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 px-2 py-0.5 rounded">
                Not deployed yet
              </span>
            )}
          </Row>
        </div>
      </div>

      {/* Fee model table */}
      <div className="rounded-2xl border border-border bg-card p-5">
        <p className="text-sm font-semibold mb-3">Fee Schedule</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="pb-2 font-medium">Amount Sent</th>
                <th className="pb-2 font-medium">Fee ({feePercent}%)</th>
                <th className="pb-2 font-medium">Recipient Gets</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {[10, 100, 500, 1000, 5000].map((amt) => {
                const fee = ((amt * config.feeBps) / 10000).toFixed(4).replace(/\.?0+$/, "");
                const net = (amt - parseFloat(fee)).toFixed(2);
                return (
                  <tr key={amt} className="text-xs">
                    <td className="py-2.5 font-mono">{amt} USDC</td>
                    <td className="py-2.5 font-mono text-primary">−{fee} USDC</td>
                    <td className="py-2.5 font-mono text-foreground">{net} USDC</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Contract deploy note */}
      {!config.routerAddress && (
        <div className="rounded-2xl border border-yellow-500/20 bg-yellow-500/5 p-5">
          <p className="text-sm font-semibold text-yellow-400 mb-1">Router Contract Not Deployed</p>
          <p className="text-xs text-muted-foreground mb-3">
            Deploy <code className="text-primary bg-primary/10 px-1 rounded">BasePayRouter.sol</code> to enable single-transaction fee routing.
            Until then, sends use two wallet confirmations (fee + payment).
          </p>
          <a
            href="https://book.getfoundry.sh"
            target="_blank" rel="noreferrer"
            className="text-xs text-yellow-400 hover:underline"
          >
            See contracts/README.md for deployment instructions
          </a>
        </div>
      )}
    </div>
  );
}
