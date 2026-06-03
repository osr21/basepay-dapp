import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contractPath = resolve(__dirname, "../../contracts/BasePayRouter.json");

const pk = process.env.DEPLOYER_PRIVATE_KEY;
if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY env var is not set");

const { abi, bytecode } = JSON.parse(readFileSync(contractPath, "utf8")) as {
  abi: unknown[];
  bytecode: `0x${string}`;
};

const account = privateKeyToAccount(
  pk.startsWith("0x") ? (pk as `0x${string}`) : (`0x${pk}` as `0x${string}`)
);

console.log("Deployer:", account.address);

const publicClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
});

const walletClient = createWalletClient({
  account,
  chain: base,
  transport: http("https://mainnet.base.org"),
});

const balance = await publicClient.getBalance({ address: account.address });
console.log("ETH balance:", (Number(balance) / 1e18).toFixed(6), "ETH");

if (balance === 0n) {
  console.error("ERROR: wallet has 0 ETH — need ETH on Base for gas");
  process.exit(1);
}

console.log("Deploying BasePayRouter to Base Mainnet...");
const hash = await walletClient.deployContract({
  abi,
  bytecode,
  args: ["0xdb5019b8dfbccef8906c39b16a4870082eabbc4c" as `0x${string}`, 30n],
});
console.log("Tx hash:", hash);
console.log("Waiting for 2 confirmations...");

const receipt = await publicClient.waitForTransactionReceipt({
  hash,
  confirmations: 2,
});

console.log("\n✅ Deployed!");
console.log("Contract address:", receipt.contractAddress);
console.log("Block:", receipt.blockNumber.toString());
console.log("Gas used:", receipt.gasUsed.toString());
console.log(
  "\nBaseScan:",
  `https://basescan.org/address/${receipt.contractAddress}`
);
console.log(
  "\nNext step: add this to Replit Secrets:"
);
console.log(`  VITE_ROUTER_ADDRESS=${receipt.contractAddress}`);
