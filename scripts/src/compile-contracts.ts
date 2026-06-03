/**
 * Compiles V2 Solidity contracts using the solc npm package and writes
 * JSON artifacts (abi + bytecode) to contracts/*.json
 */
import solc from "solc";
import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const contractsDir = resolve(__dirname, "../../contracts");

const contracts = [
  "BasePayRouterV2",
  "BatchPayV2",
  "EscrowV2",
  "SubscriptionManagerV2",
];

for (const name of contracts) {
  const source = readFileSync(resolve(contractsDir, `${name}.sol`), "utf8");

  const input = {
    language: "Solidity",
    sources: { [`${name}.sol`]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object"] },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors?.some((e: { severity: string }) => e.severity === "error")) {
    console.error(`\n❌ Compilation errors for ${name}:`);
    for (const e of output.errors) {
      console.error(" ", e.formattedMessage);
    }
    process.exit(1);
  }

  const contract = output.contracts[`${name}.sol`][name];
  const artifact = {
    abi: contract.abi,
    bytecode: `0x${contract.evm.bytecode.object}` as `0x${string}`,
  };

  const outPath = resolve(contractsDir, `${name}.json`);
  writeFileSync(outPath, JSON.stringify(artifact, null, 2));
  console.log(`✅ Compiled ${name} → ${name}.json  (${(artifact.bytecode.length / 2).toLocaleString()} bytes)`);
}

console.log("\nAll V2 contracts compiled.");
