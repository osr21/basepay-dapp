/**
 * verify-contracts.ts
 * Submit all BasePay contracts for source-code verification on BaseScan.
 * Verified contracts appear as green checkmarks on BaseScan and are trusted
 * by security scanners like Blockaid.
 *
 * Run: pnpm --filter @workspace/scripts run verify-contracts
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = resolve(__dirname, "../../contracts");

const API_KEY = process.env.BASESCAN_API_KEY ?? "";
const BASE_URL = "https://api.basescan.org/api";

// Compiler must exactly match what was used to deploy (solc 0.8.20 via npm, optimizer on 200 runs)
const COMPILER_VERSION = "v0.8.20+commit.a1b79de6";
const OPTIMIZATION_USED = "1";
const RUNS = "200";

// ABI-encoded constructor args: (address feeCollector, uint256 feeBps=30)
// address 0xdb5019b8dfbccef8906c39b16a4870082eabbc4c, uint256 30
const CONSTRUCTOR_ARGS =
  "000000000000000000000000db5019b8dfbccef8906c39b16a4870082eabbc4c" +
  "000000000000000000000000000000000000000000000000000000000000001e";

interface ContractEntry {
  name: string;
  address: string;
  file: string;
}

const CONTRACTS: ContractEntry[] = [
  { name: "BasePayRouter",       address: "0x2d7ba7ed34f8fa16fe4d0d11b51306dc753812c8", file: "BasePayRouter.sol"       },
  { name: "BatchPay",            address: "0x82569caf7847040a03ad2c6545ade5af2bdcf47c", file: "BatchPay.sol"            },
  { name: "Escrow",              address: "0x5b3241a47acfda41f15dfd7260339e2a88d52318", file: "Escrow.sol"              },
  { name: "SubscriptionManager", address: "0x546093b0476b4b7909cd84f3a0fef813c421d14a", file: "SubscriptionManager.sol" },
];

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function checkStatus(guid: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await sleep(5000);
    const params = new URLSearchParams({
      apikey: API_KEY,
      module: "contract",
      action: "checkverifystatus",
      guid,
    });
    const res = await fetch(`${BASE_URL}?${params}`);
    const json = await res.json() as { status: string; result: string };
    console.log(`  Status [${i + 1}/30]: ${json.result}`);
    if (json.result !== "Pending in queue") return json.result;
  }
  return "Timeout";
}

async function verifyContract(entry: ContractEntry): Promise<void> {
  const source = readFileSync(resolve(root, entry.file), "utf8");

  console.log(`\nVerifying ${entry.name} at ${entry.address}...`);

  const body = new URLSearchParams({
    apikey:                API_KEY,
    module:                "contract",
    action:                "verifysourcecode",
    contractaddress:       entry.address,
    sourceCode:            source,
    codeformat:            "solidity-single-file",
    contractname:          entry.name,
    compilerversion:       COMPILER_VERSION,
    optimizationUsed:      OPTIMIZATION_USED,
    runs:                  RUNS,
    constructorArguements: CONSTRUCTOR_ARGS,
    licenseType:           "3", // MIT
    evmversion:            "",
  });

  const res  = await fetch(BASE_URL, { method: "POST", body });
  const json = await res.json() as { status: string; message: string; result: string };
  console.log(`  Submit response:`, json);

  if (json.status === "1") {
    const guid = json.result;
    console.log(`  GUID: ${guid} — polling for result...`);
    const result = await checkStatus(guid);
    if (result === "Pass - Verified") {
      console.log(`  ✅  ${entry.name} VERIFIED`);
      console.log(`      https://basescan.org/address/${entry.address}#code`);
    } else {
      console.log(`  ❌  ${entry.name} failed: ${result}`);
    }
  } else if (json.result?.includes("already verified") || json.result?.includes("Already Verified")) {
    console.log(`  ✅  ${entry.name} already verified!`);
    console.log(`      https://basescan.org/address/${entry.address}#code`);
  } else {
    console.log(`  ❌  Submission rejected: ${json.result}`);
  }

  // Rate-limit: BaseScan allows 5 req/sec on free tier
  await sleep(2000);
}

if (!API_KEY) {
  console.warn("\n⚠️  BASESCAN_API_KEY is not set. Get a free key at https://basescan.org/myapikey");
  console.warn("   Set it: pnpm --filter @workspace/scripts run verify-contracts (after adding BASESCAN_API_KEY secret)\n");
}

console.log("=== BasePay Contract Verification ===");
console.log("Compiler :", COMPILER_VERSION);
console.log("Optimizer: enabled, 200 runs");
console.log("Network  : Base Mainnet (chain 8453)");

for (const entry of CONTRACTS) {
  await verifyContract(entry);
}

console.log("\n=== Done ===");
