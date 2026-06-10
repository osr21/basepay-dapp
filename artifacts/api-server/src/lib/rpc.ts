import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
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
