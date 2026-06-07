import { Link, useLocation } from "wouter";
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from "wagmi";
import { injected } from "wagmi/connectors";
import { base } from "viem/chains";
import { useGetAppConfig } from "@workspace/api-client-react";
import { truncateAddress } from "@/lib/wagmi";
import { useState } from "react";

const NAV = [
  { path: "/",             label: "Dashboard",   icon: HomeIcon         },
  { path: "/send",         label: "Send",        icon: SendIcon         },
  { path: "/gasless",      label: "Gasless",     icon: GaslessIcon, badge: "0 gas" },
  { path: "/swap",         label: "Swap",        icon: SwapNavIcon      },
  { path: "/batch-pay",    label: "Batch Pay",   icon: BatchIcon        },
  { path: "/request",      label: "Request",     icon: RequestIcon      },
  { path: "/requests",     label: "My Requests", icon: ListIcon         },
  { path: "/escrow",       label: "Escrow",      icon: LockIcon         },
  { path: "/subscriptions",label: "Subscribe",   icon: RepeatIcon       },
  { path: "/contacts",     label: "Contacts",    icon: ContactsIcon     },
  { path: "/app-info",     label: "dApp Info",   icon: ShieldIcon       },
];

function HomeIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>;
}
function GaslessIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>;
}
function SendIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" x2="11" y1="2" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>;
}
function RequestIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="16"/><line x1="8" x2="16" y1="12" y2="12"/></svg>;
}
function ListIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" x2="21" y1="6" y2="6"/><line x1="8" x2="21" y1="12" y2="12"/><line x1="8" x2="21" y1="18" y2="18"/><line x1="3" x2="3.01" y1="6" y2="6"/><line x1="3" x2="3.01" y1="12" y2="12"/><line x1="3" x2="3.01" y1="18" y2="18"/></svg>;
}
function ContactsIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
}
function ShieldIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>;
}
function BatchIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
}
function LockIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
}
function RepeatIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>;
}

function SwapNavIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 16V4m0 0L3 8m4-4 4 4"/><path d="M17 8v12m0 0 4-4m-4 4-4-4"/></svg>;
}
function WrongNetworkBanner() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain, isPending } = useSwitchChain();

  if (!isConnected || chainId === base.id) return null;

  return (
    <div className="flex items-center justify-between gap-3 px-4 md:px-8 py-2.5 bg-red-500/10 border-b border-red-500/20 text-sm">
      <div className="flex items-center gap-2 text-red-400">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" x2="12" y1="9" y2="13"/><line x1="12" x2="12.01" y1="17" y2="17"/>
        </svg>
        <span>Wrong network — BasePay requires <span className="font-semibold">Base Mainnet</span></span>
      </div>
      <button
        onClick={() => switchChain({ chainId: base.id })}
        disabled={isPending}
        className="shrink-0 px-3 py-1 rounded-md bg-red-500/20 border border-red-500/30 text-red-300 text-xs font-semibold hover:bg-red-500/30 transition-all disabled:opacity-50"
      >
        {isPending ? "Switching…" : "Switch to Base"}
      </button>
    </div>
  );
}

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect }    = useConnect();
  const { disconnect } = useDisconnect();
  const [showPicker, setShowPicker] = useState(false);

  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border hover:border-primary/40 transition-all text-sm font-mono text-foreground"
        title="Click to disconnect"
      >
        <span className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]" />
        {truncateAddress(address)}
      </button>
    );
  }

  if (showPicker) {
    return (
      <>
        {/* Invisible full-screen backdrop — click anywhere outside to dismiss */}
        <div
          className="fixed inset-0 z-40"
          aria-hidden="true"
          onClick={() => setShowPicker(false)}
        />
        {/* Picker dropdown */}
        <div className="relative z-50">
          <div className="absolute right-0 top-2 flex flex-col gap-1 p-2 rounded-xl border border-border bg-card shadow-xl min-w-[210px]">
            <p className="px-3 pt-1 pb-0.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
              Choose wallet
            </p>
            <button
              onClick={() => { connect({ connector: injected() }); setShowPicker(false); }}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-secondary transition-colors text-sm text-left"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect width="20" height="14" x="2" y="5" rx="2"/>
                <line x1="2" x2="22" y1="10" y2="10"/>
              </svg>
              <div>
                <div className="font-semibold text-foreground">Browser Wallet</div>
                <div className="text-xs text-muted-foreground">MetaMask, Rabby…</div>
              </div>
            </button>
            <div className="border-t border-border mt-1 pt-1">
              <button
                onClick={() => setShowPicker(false)}
                className="w-full text-xs text-muted-foreground text-center py-1.5 hover:text-foreground transition-colors rounded-md hover:bg-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <button
      onClick={() => setShowPicker(true)}
      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all text-sm font-semibold shadow-[0_0_20px_hsl(221_83%_53%/0.3)]"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="20" height="14" x="2" y="5" rx="2"/><line x1="2" x2="22" y1="10" y2="10"/></svg>
      Connect Wallet
    </button>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location]   = useLocation();
  const { data: appConfig } = useGetAppConfig();

  const isVerified   = appConfig?.verified ?? false;
  const hasRouter    = !!appConfig?.routerAddress;
  const feePercent   = appConfig ? (appConfig.feeBps / 100).toFixed(2) : "0.30";

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="hidden md:flex flex-col w-60 border-r border-border bg-card/40 backdrop-blur-sm fixed inset-y-0 left-0 z-30">
        {/* Logo */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-[0_0_16px_hsl(221_83%_53%/0.5)]">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" className="text-white">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
            </svg>
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-bold">BasePay</span>
              {isVerified && (
                <span title="Verified dApp">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="hsl(221,83%,63%)" className="shrink-0">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
                  </svg>
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">Base Network</div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {NAV.map(({ path, label, icon: Icon, badge }) => {
            const active = location === path || (path !== "/" && location.startsWith(path));
            return (
              <Link
                key={path}
                href={path}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  active
                    ? "bg-primary/15 text-primary border border-primary/20"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary border border-transparent"
                }`}
              >
                <Icon />
                <span className="flex-1">{label}</span>
                {badge && (
                  <span className="px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 text-[10px] font-semibold leading-none">{badge}</span>
                )}
                {path === "/app-info" && isVerified && (
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                )}
              </Link>
            );
          })}
        </nav>

        {/* Footer info */}
        <div className="px-4 py-4 border-t border-border space-y-2">
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-secondary text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
              Base Mainnet
            </div>
            <span className="text-primary font-semibold">{feePercent}% fee</span>
          </div>
          {!hasRouter && (
            <Link href="/app-info">
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-yellow-500/5 border border-yellow-500/15 text-xs text-yellow-500/80 cursor-pointer hover:bg-yellow-500/10 transition-colors">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="16"/><line x1="12" x2="12.01" y1="8" y2="8"/></svg>
                Router not deployed
              </div>
            </Link>
          )}
          {hasRouter && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/5 border border-green-500/15 text-xs text-green-500/80">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
              Router deployed
            </div>
          )}
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 md:ml-60 flex flex-col min-h-screen">
        {/* Top bar */}
        <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-md">
          <div className="flex items-center justify-between px-4 md:px-8 h-14">
            <div className="md:hidden flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" className="text-white">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                </svg>
              </div>
              <span className="text-sm font-bold">BasePay</span>
              {isVerified && <svg width="12" height="12" viewBox="0 0 24 24" fill="hsl(221,83%,63%)"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>}
            </div>
            <div className="flex-1" />
            <WalletButton />
          </div>
        </header>

        {/* Wrong-network banner */}
        <WrongNetworkBanner />

        {/* Page */}
        <main className="flex-1 px-4 md:px-8 py-6">
          {children}
        </main>
      </div>
    </div>
  );
}
