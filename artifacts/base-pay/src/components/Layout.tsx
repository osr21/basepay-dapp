import { Link, useLocation } from "wouter";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { injected } from "wagmi/connectors";
import { truncateAddress } from "@/lib/wagmi";

const NAV = [
  { path: "/", label: "Dashboard", icon: HomeIcon },
  { path: "/send", label: "Send", icon: SendIcon },
  { path: "/request", label: "Request", icon: RequestIcon },
  { path: "/requests", label: "My Requests", icon: ListIcon },
  { path: "/contacts", label: "Contacts", icon: ContactsIcon },
];

function HomeIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" x2="11" y1="2" y2="13"/>
      <polygon points="22 2 15 22 11 13 2 9 22 2"/>
    </svg>
  );
}
function RequestIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <line x1="12" x2="12" y1="8" y2="16"/>
      <line x1="8" x2="16" y1="12" y2="12"/>
    </svg>
  );
}
function ListIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" x2="21" y1="6" y2="6"/>
      <line x1="8" x2="21" y1="12" y2="12"/>
      <line x1="8" x2="21" y1="18" y2="18"/>
      <line x1="3" x2="3.01" y1="6" y2="6"/>
      <line x1="3" x2="3.01" y1="12" y2="12"/>
      <line x1="3" x2="3.01" y1="18" y2="18"/>
    </svg>
  );
}
function ContactsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M22 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  );
}

export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary border border-border hover:border-primary/40 transition-all text-sm font-mono text-foreground"
      >
        <span className="w-2 h-2 rounded-full bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.6)]" />
        {truncateAddress(address)}
      </button>
    );
  }

  return (
    <button
      onClick={() => connect({ connector: injected() })}
      className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all text-sm font-semibold shadow-[0_0_20px_hsl(221_83%_53%/0.3)]"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect width="20" height="14" x="2" y="5" rx="2"/>
        <line x1="2" x2="22" y1="10" y2="10"/>
      </svg>
      Connect Wallet
    </button>
  );
}

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen flex">
      {/* Sidebar */}
      <aside className="hidden md:flex flex-col w-60 border-r border-border bg-card/40 backdrop-blur-sm fixed inset-y-0 left-0 z-30">
        {/* Logo */}
        <div className="flex items-center gap-3 px-6 py-5 border-b border-border">
          <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center shadow-[0_0_16px_hsl(221_83%_53%/0.5)]">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-white">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
            </svg>
          </div>
          <div>
            <div className="text-sm font-bold text-foreground">BasePay</div>
            <div className="text-xs text-muted-foreground">Base Network</div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {NAV.map(({ path, label, icon: Icon }) => {
            const active = location === path || (path !== "/" && location.startsWith(path));
            return (
              <Link
                key={path}
                href={path}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                  active
                    ? "bg-primary/15 text-primary border border-primary/20"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                }`}
              >
                <Icon />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Base network badge */}
        <div className="px-4 py-4 border-t border-border">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-secondary text-xs text-muted-foreground">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
            Base Mainnet
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 md:ml-60 flex flex-col min-h-screen">
        {/* Top bar */}
        <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur-md">
          <div className="flex items-center justify-between px-4 md:px-8 h-14">
            {/* Mobile logo */}
            <div className="md:hidden flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary flex items-center justify-center">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-white">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
                </svg>
              </div>
              <span className="text-sm font-bold">BasePay</span>
            </div>
            <div className="flex-1" />
            <WalletButton />
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 px-4 md:px-8 py-6">
          {children}
        </main>
      </div>
    </div>
  );
}
