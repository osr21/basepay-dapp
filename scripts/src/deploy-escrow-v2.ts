import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contractPath = resolve(__dirname, "../../contracts/EscrowV2.json");

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

const publicClient = createPublicClient({ chain: base, transport: http("https://mainnet.base.org") });
const walletClient = createWalletClient({ account, chain: base, transport: http("https://mainnet.base.org") });

const balance = await publicClient.getBalance({ address: account.address });
console.log("ETH balance:", (Number(balance) / 1e18).toFixed(6), "ETH");
if (balance === 0n) { console.error("ERROR: 0 ETH"); process.exit(1); }

console.log("Deploying EscrowV2...");
const hash = await walletClient.deployContract({
  abi, bytecode,
  args: ["0xdb5019b8dfbccef8906c39b16a4870082eabbc4c" as `0x${string}`, 30n],
});
console.log("Tx hash:", hash);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });

console.log("\n✅ Deployed EscrowV2!");
console.log("Contract address:", receipt.contractAddress);
console.log("BaseScan:", `https://basescan.org/address/${receipt.contractAddress}`);
console.log(`  VITE_ESCROW_ADDRESS=${receipt.contractAddress}`);
