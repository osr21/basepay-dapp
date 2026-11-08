import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ciEnvironment } from "./stockflow-ci-env.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const env = ciEnvironment(process.env);
const phase = process.argv.slice(2).filter(arg => arg !== "--");
const phases = ["safety", "generated", "types", "local", "database"];
if (phase.length > 1 || (phase.length && !phases.includes(phase[0]))) {
  throw new Error(`Usage: pnpm ci:stockflow [${phases.join("|")}]`);
}

function run(command, args) {
  console.info(`\nStockFlow CI: ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const pnpm = (...args) => run("pnpm", args);
const script = (pkg, name) => pnpm("--filter", `@workspace/${pkg}`, "run", name);

for (const step of phase.length ? phase : phases) {
  switch (step) {
    case "safety":
      run("node", ["--test", "scripts/test/stockflow-ci.test.mjs"]);
      break;
    case "generated": {
      script("api-spec", "codegen");
      const paths = ["lib/api-client-react/src/generated", "lib/api-zod/src/generated"];
      // Includes added/untracked and deleted files, not only tracked line diffs.
      const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...paths],
        { cwd: root, env, encoding: "utf8" });
      if (result.error) throw result.error;
      if (result.status !== 0) process.exit(result.status ?? 1);
      if (result.stdout.trim()) {
        console.error("OpenAPI generated-source drift. Run codegen and commit all generated source:\n" + result.stdout);
        process.exit(1);
      }
      break;
    }
    case "types":
      pnpm("run", "typecheck:libs");
      script("api-server", "typecheck");
      script("scripts", "compile:stockflow");
      script("base-pay", "typecheck");
      break;
    case "local":
      script("base-pay", "test:stockflow");
      script("scripts", "test:stockflow-sandbox");
      break;
    case "database":
      // Never starts the application, imports its relayer or runs a force push.
      script("db", "push");
      script("scripts", "test:stockflow-income");
      script("scripts", "test:stockflow-fees");
      script("scripts", "test:stockflow-pilot");
      script("api-server", "test:stockflow-replacements");
      break;
  }
}
