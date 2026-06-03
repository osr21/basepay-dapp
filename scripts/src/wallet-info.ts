import { createPublicClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const ROUTER_ADDRESS = "0x2d7ba7ed34f8fa16fe4d0d11b51306dc753812c8" as const;
const USDC_ADDRESS   = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const USDC_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
] as const;

const ROUTER_ABI = [
  { type: "function", name: "owner",        inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "feeCollector", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "feeBps",       inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "paused",       inputs: [], outputs: [{ name: "", type: "bool" }],    stateMutability: "view" },
  { type: "function", name: "appInfo",      inputs: [], outputs: [
    { name: "name",    type: "string" },
    { name: "version", type: "string" },
    { name: "network", type: "string" },
  ], stateMutability: "pure" },
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
await sleep(1200);
const usdcBalance = await client.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [account.address] });
await sleep(1200);
const routerCode = await client.getBytecode({ address: ROUTER_ADDRESS });

console.log("Deployer address :", account.address);
console.log("ETH balance      :", formatEther(ethBalance), "ETH");
console.log("USDC balance     :", (Number(usdcBalance) / 1e6).toFixed(2), "USDC");
console.log();
console.log("---  Deployed Contracts  ---\n");

const routerDeployed = routerCode && routerCode.length > 2;
if (routerDeployed) {
  await sleep(1200);
  const owner = await client.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: "owner" });
  await sleep(1200);
  const feeCollector = await client.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: "feeCollector" });
  await sleep(1200);
  const feeBps = await client.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: "feeBps" });
  await sleep(1200);
  const paused = await client.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: "paused" });
  await sleep(1200);
  const appInfo = await client.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: "appInfo" });

  console.log("[OK] BasePayRouter");
  console.log("     Address     :", ROUTER_ADDRESS);
  console.log("     BaseScan    : https://basescan.org/address/" + ROUTER_ADDRESS);
  console.log("     App         :", appInfo[0], appInfo[1], "on", appInfo[2]);
  console.log("     Owner       :", owner);
  console.log("     Fee collect :", feeCollector);
  console.log("     Fee         :", feeBps.toString(), "bps (" + Number(feeBps) / 100 + "%)");
  console.log("     Paused      :", paused);
} else {
  console.log("[!!] BasePayRouter not found at", ROUTER_ADDRESS);
}

console.log("\n=========================================\n");
