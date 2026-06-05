import { useGetAppConfig } from "@workspace/api-client-react";
import { truncateAddress, DATA_SUFFIX } from "@/lib/wagmi";

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

      {/* Base Builder Code card */}
      <div className={`rounded-2xl border p-5 ${
        DATA_SUFFIX
          ? "border-blue-500/20 bg-blue-500/5"
          : "border-yellow-500/20 bg-yellow-500/5"
      }`}>
        <div className="flex items-center gap-2 mb-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={DATA_SUFFIX ? "text-blue-400" : "text-yellow-400"}>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          <p className={`text-sm font-semibold ${DATA_SUFFIX ? "text-blue-400" : "text-yellow-400"}`}>
            Base Builder Code
          </p>
          <span className={`ml-auto text-xs px-2 py-0.5 rounded-full font-medium border ${
            DATA_SUFFIX
              ? "bg-blue-500/10 text-blue-400 border-blue-500/20"
              : "bg-yellow-500/10 text-yellow-400 border-yellow-500/20"
          }`}>
            {DATA_SUFFIX ? "Active" : "Not configured"}
          </span>
        </div>
        {DATA_SUFFIX ? (
          <>
            <p className="text-xs text-muted-foreground mb-2">
              ERC-8021 attribution suffix is appended to every transaction — user sends and relayed gasless transfers included.
              BasePay activity is tracked in the Base ecosystem and eligible for rewards.
            </p>
            <p className="text-xs font-mono text-muted-foreground break-all">
              Suffix: <span className="text-blue-400">{DATA_SUFFIX}</span>
            </p>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground mb-3">
              Register on base.dev to get a Builder Code, then set{" "}
              <code className="text-yellow-400 bg-yellow-500/10 px-1 rounded">VITE_BASE_BUILDER_CODE</code>{" "}
              (frontend) and{" "}
              <code className="text-yellow-400 bg-yellow-500/10 px-1 rounded">BASE_BUILDER_CODE</code>{" "}
              (server) to attribute all transactions to this dApp.
            </p>
            <a
              href="https://base.dev"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-yellow-400 hover:underline"
            >
              Get your Builder Code at base.dev
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                <polyline points="15 3 21 3 21 9"/>
                <line x1="10" x2="21" y1="14" y2="3"/>
              </svg>
            </a>
          </>
        )}
      </div>

      {/* Base Ecosystem Integrations */}
      <div className="rounded-2xl border border-border bg-card p-5 space-y-4">
        <div>
          <p className="text-sm font-semibold">Base Ecosystem</p>
          <p className="text-xs text-muted-foreground mt-0.5">Protocols that complement BasePay on Base Mainnet</p>
        </div>

        <div className="grid gap-3">
          {[
            {
              name: "Uniswap v3",
              tag: "DEX · Swaps",
              tagColor: "text-pink-400 bg-pink-500/10 border-pink-500/20",
              desc: "Swap any token to USDC before sending. BasePay reads live ETH/USDC prices from the Uniswap V3 pool on Base.",
              url: `https://app.uniswap.org/swap?inputCurrency=ETH&outputCurrency=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&chain=base`,
              contract: "0x2626664c2603336E57B271c5C0b26F421741e481",
              contractLabel: "SwapRouter02",
            },
            {
              name: "Aerodrome Finance",
              tag: "DEX · Base Native",
              tagColor: "text-blue-400 bg-blue-500/10 border-blue-500/20",
              desc: "Base's largest DEX by volume. ve(3,3) model with deep USDC liquidity — an alternative swap source for acquiring USDC.",
              url: "https://aerodrome.finance/swap?from=eth&to=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
              contract: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
              contractLabel: "Router",
            },
            {
              name: "Basenames",
              tag: "Identity · ENS",
              tagColor: "text-blue-300 bg-blue-400/10 border-blue-400/20",
              desc: "Human-readable .base.eth names. BasePay resolves them live in all address fields — type name.base.eth anywhere.",
              url: "https://www.base.org/names",
              contract: "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD",
              contractLabel: "L2Resolver",
            },
            {
              name: "0xSplits",
              tag: "Revenue Splits",
              tagColor: "text-green-400 bg-green-500/10 border-green-500/20",
              desc: "Split USDC payments between multiple addresses on-chain. Combine with BasePay's BatchPay for automated team payroll.",
              url: "https://app.splits.org",
              contract: "0x2ed6c4B5dA6378c7897AC67Ba9e43102Feb694EE",
              contractLabel: "SplitMain",
            },
            {
              name: "Superfluid",
              tag: "Streaming Payments",
              tagColor: "text-orange-400 bg-orange-500/10 border-orange-500/20",
              desc: "Real-time per-second token streams. Complementary to BasePay subscriptions — use Superfluid for continuous flows, BasePay for interval-based billing.",
              url: "https://app.superfluid.finance",
              contract: "0x19ba78B9cDB05A877718841c574325fdB53601bb",
              contractLabel: "CFAv1 Forwarder",
            },
          ].map((p) => (
            <a
              key={p.name}
              href={p.url}
              target="_blank"
              rel="noreferrer"
              className="group flex flex-col gap-2 rounded-xl border border-border bg-secondary/50 hover:border-primary/30 hover:bg-secondary transition-all p-3.5"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground group-hover:text-primary transition-colors">{p.name}</span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${p.tagColor}`}>{p.tag}</span>
                </div>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground/40 group-hover:text-primary transition-colors flex-shrink-0">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" x2="21" y1="14" y2="3"/>
                </svg>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">{p.desc}</p>
              <p className="text-[10px] font-mono text-muted-foreground/50 truncate">{p.contractLabel}: {p.contract}</p>
            </a>
          ))}
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
