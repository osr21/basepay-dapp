import { useBasename } from "@/lib/useBasename";
import { useCoinbaseAttestation } from "@/lib/useCoinbaseAttestation";
import { truncateAddress } from "@/lib/wagmi";

interface WalletNameProps {
  address: string | undefined;
  className?: string;
  showAvatar?: boolean;
  avatarSize?: number;
  showBadge?: boolean;
}

function Identicon({ address, size = 28 }: { address: string; size?: number }) {
  const colors = [
    "#0052FF", "#3B82F6", "#6366F1", "#8B5CF6", "#EC4899",
    "#10B981", "#F59E0B", "#EF4444", "#14B8A6", "#F97316",
  ];
  const seed = address.toLowerCase().split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const bg = colors[seed % colors.length];
  const letter = address.slice(2, 3).toUpperCase();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      style={{ borderRadius: "50%", flexShrink: 0 }}
    >
      <circle cx="16" cy="16" r="16" fill={bg} fillOpacity="0.15" />
      <circle cx="16" cy="16" r="16" fill="none" stroke={bg} strokeWidth="1" strokeOpacity="0.3" />
      <text
        x="16"
        y="21"
        textAnchor="middle"
        fontSize="14"
        fontWeight="700"
        fontFamily="monospace"
        fill={bg}
      >
        {letter}
      </text>
    </svg>
  );
}

function CoinbaseBadge({ isCoinbaseOne = false }: { isCoinbaseOne?: boolean }) {
  return (
    <span
      title={isCoinbaseOne ? "Coinbase One member · Verified via EAS" : "Coinbase Verified Account · Verified via EAS"}
      className="inline-flex items-center"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0 }}
      >
        <circle cx="12" cy="12" r="12" fill={isCoinbaseOne ? "#F59E0B" : "#0052FF"} />
        <path
          d="M9 12.5L11 14.5L15 10"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function WalletAvatar({ address, size = 28 }: { address: string | undefined; size?: number }) {
  const { data } = useBasename(address);
  if (!address) return null;

  if (data?.avatar) {
    return (
      <img
        src={data.avatar}
        alt=""
        width={size}
        height={size}
        style={{ borderRadius: "50%", objectFit: "cover", flexShrink: 0 }}
        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
      />
    );
  }
  return <Identicon address={address} size={size} />;
}

export default function WalletName({
  address,
  className,
  showAvatar = false,
  avatarSize = 28,
  showBadge = true,
}: WalletNameProps) {
  const { data: basename, isLoading } = useBasename(address);
  const { data: attestation } = useCoinbaseAttestation(
    showBadge ? (address as `0x${string}` | undefined) : undefined,
  );

  if (!address) return null;

  const displayName = basename?.name ?? truncateAddress(address);
  const isName = !!basename?.name;
  const badge = showBadge && attestation?.isVerified ? (
    <CoinbaseBadge isCoinbaseOne={attestation.isCoinbaseOne} />
  ) : null;

  if (showAvatar) {
    return (
      <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
        <WalletAvatar address={address} size={avatarSize} />
        <span className={isName ? "text-foreground font-medium" : "font-mono text-muted-foreground"}>
          {isLoading ? truncateAddress(address) : displayName}
        </span>
        {badge}
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 ${isName ? "" : "font-mono"} ${className ?? ""}`}
      title={address}
    >
      <span>{isLoading ? truncateAddress(address) : displayName}</span>
      {badge}
    </span>
  );
}
