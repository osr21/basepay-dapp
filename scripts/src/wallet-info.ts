import { createPublicClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const CONTRACTS: Array<{ name: string; address: `0x${string}`; envVar: string }> = [
  { name: "BasePayRouter",       address: "0x2d7ba7ed34f8fa16fe4d0d11b51306dc753812c8", envVar: "VITE_ROUTER_ADDRESS" },
  { name: "BatchPay",            address: "0x82569caf7847040a03ad2c6545ade5af2bdcf47c", envVar: "VITE_BATCH_PAY_ADDRESS" },
  { name: "Escrow",              address: "0x5b3241a47acfda41f15dfd7260339e2a88d52318", envVar: "VITE_ESCROW_ADDRESS" },
  { name: "SubscriptionManager", address: "0x546093b0476b4b7909cd84f3a0fef813c421d14a", envVar: "VITE_SUBSCRIPTION_MANAGER_ADDRESS" },
];

const USDC_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set");
const account = privateKeyToAccount(pk.startsWith("0x") ? pk as `0x${string}` : `0x${pk}`);

const client = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });

console.log("\n=========================================");
console.log("  BasePay Deployer Wallet - Base Mainnet");
console.log("=========================================\n");

const ethBalance = await client.getBalance({ address: account.address });
await sleep(1000);
const usdcBalance = await client.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [account.address] });

console.log("Deployer address :", account.address);
console.log("ETH balance      :", formatEther(ethBalance), "ETH");
console.log("USDC balance     :", (Number(usdcBalance) / 1e6).toFixed(2), "USDC");
console.log("\n---  Deployed Contracts  ---\n");

for (const c of CONTRACTS) {
  await sleep(1000);
  const code = await client.getBytecode({ address: c.address });
  const deployed = code && code.length > 2;
  const status = deployed ? "[OK]" : "[!!]";
  console.log(`${status}  ${c.name}`);
  console.log(`     Address : ${c.address}`);
  console.log(`     Env var : ${c.envVar}`);
  console.log(`     BaseScan: https://basescan.org/address/${c.address}`);
  console.log();
}

console.log("=========================================\n");
