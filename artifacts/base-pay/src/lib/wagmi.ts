import { createConfig, http } from "wagmi";
import { base } from "viem/chains";
import { injected } from "wagmi/connectors";

export const config = createConfig({
  chains: [base],
  connectors: [injected()],
  transports: {
    [base.id]: http(),
  },
});

export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const USDC_DECIMALS = 6;

export const USDC_ABI = [
  {
    type: "function",
    name: "transfer",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
] as const;

export function truncateAddress(address: string): string {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function parseUSDC(amount: string): bigint {
  const [whole, frac = ""] = amount.split(".");
  const padded = frac.padEnd(USDC_DECIMALS, "0").slice(0, USDC_DECIMALS);
  return BigInt(whole) * BigInt(10 ** USDC_DECIMALS) + BigInt(padded);
}

export function formatUSDC(raw: bigint): string {
  const divisor = BigInt(10 ** USDC_DECIMALS);
  const whole = raw / divisor;
  const frac = raw % divisor;
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}
