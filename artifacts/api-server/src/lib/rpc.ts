import { createPublicClient, createWalletClient, http, type Chain } from "viem";
import { base, mainnet, optimism, arbitrum, polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { logger } from "./logger";

/**
 * Authenticated Coinbase Base node — higher rate limits and reliability than
 * the free public mainnet.base.org endpoint.
 *
 * Falls back to the public endpoint if the CDP API key is not set.
 */
function buildBaseRpcUrl(): string {
  const key = process.env.VITE_ONCHAINKIT_API_KEY;
  if (key) {
    return `https://api.developer.coinbase.com/rpc/v1/base/${key}`;
  }
  logger.warn("VITE_ONCHAINKIT_API_KEY not set — falling back to public mainnet.base.org RPC");
  return "https://mainnet.base.org";
}

export const BASE_RPC_URL = buildBaseRpcUrl();
export const baseTransport = http(BASE_RPC_URL);

export const basePublicClient = createPublicClient({
  chain: base,
  transport: baseTransport,
});

// ── Multi-chain RPC URLs (used by CCTP relay) ─────────────────────────────────
// Public endpoints — low rate limits but sufficient for a relay service.
const CHAIN_RPC_URLS: Partial<Record<number, string>> = {
  [base.id]:     BASE_RPC_URL,
  [mainnet.id]:  "https://cloudflare-eth.com",
  [optimism.id]: "https://mainnet.optimism.io",
  [arbitrum.id]: "https://arb1.arbitrum.io/rpc",
  [polygon.id]:  "https://polygon-rpc.com",
};

const _publicClients = new Map<number, ReturnType<typeof createPublicClient>>();

/** Returns a cached viem publicClient for any supported chain. */
export function getChainPublicClient(chain: Chain): ReturnType<typeof createPublicClient> {
  const cached = _publicClients.get(chain.id);
  if (cached) return cached;
  const url = CHAIN_RPC_URLS[chain.id];
  const client = createPublicClient({ chain, transport: url ? http(url) : http() });
  _publicClients.set(chain.id, client);
  return client;
}

// ── Shared relayer account (derived from DEPLOYER_PRIVATE_KEY) ────────────────
let _relayerAccount: ReturnType<typeof privateKeyToAccount> | null = null;

export function getRelayerAccount(): ReturnType<typeof privateKeyToAccount> {
  if (_relayerAccount) return _relayerAccount;
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const key: Hex = pk.startsWith("0x") ? (pk as Hex) : `0x${pk}`;
  _relayerAccount = privateKeyToAccount(key);
  return _relayerAccount;
}

/** Creates a walletClient for the relayer account on any supported chain. */
export function getChainWalletClient(chain: Chain) {
  const account = getRelayerAccount();
  const url = CHAIN_RPC_URLS[chain.id];
  return createWalletClient({ account, chain, transport: url ? http(url) : http() });
}
