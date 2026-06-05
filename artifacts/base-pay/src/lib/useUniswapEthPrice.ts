/**
 * Reads live ETH/USDC spot price from Uniswap V3 on Base Mainnet.
 * Uses the 0.05% (500 bps) WETH/USDC pool slot0 — no swaps, no gas.
 *
 * Uniswap V3 on Base:
 *   Factory:    0x33128a8fC17869897dcE68Ed026d694621f6FDfD
 *   SwapRouter: 0x2626664c2603336E57B271c5C0b26F421741e481
 *   QuoterV2:   0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a
 */

import { useReadContract } from "wagmi";
import { isAddress } from "viem";
import { USDC_ADDRESS } from "./wagmi";

const UNISWAP_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD" as const;
export const UNISWAP_SWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481" as const;
export const WETH_ADDRESS = "0x4200000000000000000000000000000000000006" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const FACTORY_ABI = [
  {
    type: "function", name: "getPool",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee",    type: "uint24"  },
    ],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

const POOL_ABI = [
  {
    type: "function", name: "slot0",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96",               type: "uint160" },
      { name: "tick",                        type: "int24"   },
      { name: "observationIndex",            type: "uint16"  },
      { name: "observationCardinality",      type: "uint16"  },
      { name: "observationCardinalityNext",  type: "uint16"  },
      { name: "feeProtocol",                 type: "uint8"   },
      { name: "unlocked",                    type: "bool"    },
    ],
    stateMutability: "view",
  },
] as const;

/**
 * Returns the current ETH/USDC spot price from Uniswap V3.
 *
 * @returns {usdcPerEth} — e.g. 3241.50 for $3,241.50/ETH
 * @returns {ethForUsdc(amount)} — how much ETH is needed to get `amount` USDC
 */
export function useUniswapEthPrice() {
  // Step 1: look up the WETH/USDC 0.05% pool address
  const { data: poolAddress } = useReadContract({
    address: UNISWAP_FACTORY,
    abi: FACTORY_ABI,
    functionName: "getPool",
    args: [WETH_ADDRESS, USDC_ADDRESS, 500],
    query: { staleTime: 60_000, gcTime: 5 * 60_000 },
  });

  const validPool = poolAddress && isAddress(poolAddress) && poolAddress !== ZERO_ADDRESS
    ? poolAddress
    : undefined;

  // Step 2: read slot0 (current price)
  const { data: slot0, isLoading } = useReadContract({
    address: validPool,
    abi: POOL_ABI,
    functionName: "slot0",
    query: {
      enabled: !!validPool,
      staleTime: 15_000,
      gcTime: 60_000,
      refetchInterval: 30_000,
    },
  });

  let usdcPerEth: number | null = null;

  if (slot0) {
    const sqrtPriceX96 = slot0[0]; // bigint

    // WETH is token0 (18 dec), USDC is token1 (6 dec)
    // price_usdc_per_eth = (sqrtPriceX96 / 2^96)^2 * 10^(18-6)
    //                    = sqrtPriceX96^2 * 10^12 / 2^192
    //
    // All BigInt to avoid float precision loss with 10^24 values.
    const Q192 = 2n ** 192n;
    const priceInt = (sqrtPriceX96 * sqrtPriceX96 * 1_000_000_000_000n) / Q192;
    usdcPerEth = Number(priceInt); // e.g. 3241 (whole USDC per ETH)
  }

  /** How much ETH is needed to buy `usdcAmount` USDC (approximate, no slippage) */
  function ethForUsdc(usdcAmount: number): number | null {
    if (!usdcPerEth || usdcPerEth === 0) return null;
    return usdcAmount / usdcPerEth;
  }

  /** Deep-link to Uniswap pre-filled to swap ETH → exact USDC amount */
  function uniswapSwapUrl(usdcAmount?: string): string {
    const base = "https://app.uniswap.org/swap";
    const params = new URLSearchParams({
      inputCurrency:  "ETH",
      outputCurrency: USDC_ADDRESS,
      chain:          "base",
    });
    if (usdcAmount && parseFloat(usdcAmount) > 0) {
      params.set("exactAmount", usdcAmount);
      params.set("exactField",  "output");
    }
    return `${base}?${params}`;
  }

  return { usdcPerEth, ethForUsdc, uniswapSwapUrl, isLoading };
}
