import { createPublicClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const ROUTER_ADDRESS = "0x2d7ba7ed34f8fa16fe4d0d11b51306dc753812c8" as const;
const USDC_ADDRESS   = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

const USDC_ABI = [
  { type: "function", name: "balanceOf", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "decimals",  inputs: [], outputs: [{ name: "", type: "uint8" }], stateMutability: "view" },
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

const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set");
const account = privateKeyToAccount(pk.startsWith("0x") ? pk as `0x${string}` : `0x${pk}`);

const client = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("  BasePay Deployer Wallet — Base Mainnet");
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

const [ethBalance, usdcBalance, routerCode] = await Promise.all([
  client.getBalance({ address: account.address }),
  client.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [account.address] }),
  client.getBytecode({ address: ROUTER_ADDRESS }),
]);

console.log("Deployer address :", account.address);
console.log("ETH balance      :", formatEther(ethBalance), "ETH");
console.log("USDC balance     :", (Number(usdcBalance) / 1e6).toFixed(2), "USDC");
console.log();

const routerDeployed = routerCode && routerCode.length > 2;
console.log("━━━  Deployed Contracts  ━━━\n");

if (routerDeployed) {
  const [owner, feeCollector, feeBps, paused, appInfo] = await Promise.all([
    client.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: "owner" }),
    client.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: "feeCollector" }),
    client.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: "feeBps" }),
    client.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: "paused" }),
    client.readContract({ address: ROUTER_ADDRESS, abi: ROUTER_ABI, functionName: "appInfo" }),
  ]);
  console.log("✅  BasePayRouter");
  console.log("    Address     :", ROUTER_ADDRESS);
  console.log("    BaseScan    : https://basescan.org/address/" + ROUTER_ADDRESS);
  console.log("    App name    :", appInfo[0], appInfo[1], "on", appInfo[2]);
  console.log("    Owner       :", owner);
  console.log("    Fee collect :", feeCollector);
  console.log("    Fee bps     :", feeBps.toString(), "("+Number(feeBps)/100+"%)");
  console.log("    Paused      :", paused);
} else {
  console.log("⚠️   BasePayRouter — NOT found at", ROUTER_ADDRESS);
}

console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
