import { useQuery } from "@tanstack/react-query";
import { createPublicClient, http, type Address } from "viem";
import { namehash, normalize } from "viem/ens";
import { base } from "viem/chains";

// Basenames L2 Reverse Registrar on Base Mainnet
// Source: github.com/base/basenames
const REVERSE_REGISTRAR = "0x79ea96012eea67a83431f1701b3dff7e37f9e282" as const;
const L2_RESOLVER      = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD" as const;

const REVERSE_REGISTRAR_ABI = [
  {
    name: "node",
    type: "function",
    stateMutability: "pure",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const RESOLVER_ABI = [
  {
    name: "name",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    name: "addr",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const AVATAR_RESOLVER_ABI = [
  {
    name: "text",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const publicClient = createPublicClient({ chain: base, transport: http() });

async function resolveBasename(address: Address): Promise<{ name: string | null; avatar: string | null }> {
  try {
    const node = await publicClient.readContract({
      address: REVERSE_REGISTRAR,
      abi: REVERSE_REGISTRAR_ABI,
      functionName: "node",
      args: [address],
    });

    const name = await publicClient.readContract({
      address: L2_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: "name",
      args: [node],
    });

    if (!name) return { name: null, avatar: null };

    let avatar: string | null = null;
    try {
      const avatarRaw = await publicClient.readContract({
        address: L2_RESOLVER,
        abi: AVATAR_RESOLVER_ABI,
        functionName: "text",
        args: [node, "avatar"],
      });
      avatar = avatarRaw || null;
    } catch {
      // avatar is optional — swallow
    }

    return { name, avatar };
  } catch {
    return { name: null, avatar: null };
  }
}

export function useBasename(address: string | undefined) {
  const addr = address?.toLowerCase().startsWith("0x") && address.length === 42
    ? address as Address
    : undefined;

  return useQuery({
    queryKey: ["basename", addr],
    queryFn: () => resolveBasename(addr!),
    enabled: !!addr,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
}

// ── Forward resolution: .base.eth name → address ─────────────────────────────

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function resolveBasenameToAddress(name: string): Promise<`0x${string}` | null> {
  try {
    const normalized = normalize(name.trim().toLowerCase());
    const node = namehash(normalized);
    const addr = await publicClient.readContract({
      address: L2_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: "addr",
      args: [node],
    });
    if (!addr || addr.toLowerCase() === ZERO_ADDRESS) return null;
    return addr;
  } catch {
    return null;
  }
}

/**
 * Resolves a Basename (e.g. "alice.base.eth") to its wallet address.
 * Returns null if not a basename input or not found.
 */
export function useBasenameResolve(input: string) {
  const trimmed = input.trim().toLowerCase();
  const isName  = trimmed.endsWith(".base.eth") && trimmed.length > ".base.eth".length;

  const query = useQuery({
    queryKey: ["basenameResolve", trimmed],
    queryFn: () => resolveBasenameToAddress(trimmed),
    enabled: isName,
    staleTime: 2 * 60 * 1000,
    gcTime:   5 * 60 * 1000,
    retry: 1,
  });

  return { ...query, isName };
}
