import { Router } from "express";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseAbi,
  formatUnits,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { isAddress } from "viem";

const router = Router();

const transport    = http("https://mainnet.base.org");
const publicClient = createPublicClient({ chain: base, transport });

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const EURC = "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42" as const;

const ERC20_ABI = parseAbi([
  "function balanceOf(address) external view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
]);

function getRelayerAccount() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY not set");
  const key = pk.startsWith("0x") ? (pk as Hex) : (`0x${pk}` as Hex);
  return privateKeyToAccount(key);
}

function checkAuth(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return false;
  const auth = req.headers["authorization"] as string | undefined;
  return auth === `Bearer ${secret}`;
}

// ── GET /api/admin/relay-status ───────────────────────────────────────────────
// Returns relay wallet address and token balances. Public read-only.
router.get("/admin/relay-status", async (req, res) => {
  let relayAddress: `0x${string}`;
  try {
    relayAddress = getRelayerAccount().address;
  } catch {
    return res.status(503).json({ error: "Relayer not configured (DEPLOYER_PRIVATE_KEY not set)" });
  }

  const [usdcRaw, eurcRaw, ethRaw] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [relayAddress] }),
    publicClient.readContract({ address: EURC, abi: ERC20_ABI, functionName: "balanceOf", args: [relayAddress] }),
    publicClient.getBalance({ address: relayAddress }),
  ]);

  return res.json({
    relayAddress,
    balances: {
      usdc: { raw: usdcRaw.toString(), formatted: formatUnits(usdcRaw, 6) },
      eurc: { raw: eurcRaw.toString(), formatted: formatUnits(eurcRaw, 6) },
      eth:  { raw: ethRaw.toString(),  formatted: formatUnits(ethRaw, 18) },
    },
  });
});

// ── POST /api/admin/relay-drain ───────────────────────────────────────────────
// Transfers all USDC and EURC from relay wallet to the specified recipient.
// Requires: Authorization: Bearer <SESSION_SECRET>
router.post("/admin/relay-drain", async (req, res) => {
  if (!checkAuth(req as Parameters<typeof checkAuth>[0])) {
    return res.status(401).json({ error: "Unauthorized — provide correct admin key" });
  }

  const { recipient } = req.body as { recipient?: string };
  if (!recipient || !isAddress(recipient)) {
    return res.status(400).json({ error: "recipient must be a valid address" });
  }

  let relayAccount: ReturnType<typeof getRelayerAccount>;
  try {
    relayAccount = getRelayerAccount();
  } catch {
    return res.status(503).json({ error: "Relayer not configured" });
  }

  const walletClient = createWalletClient({ account: relayAccount, chain: base, transport });
  const relayAddress = relayAccount.address;

  const [usdcRaw, eurcRaw] = await Promise.all([
    publicClient.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [relayAddress] }),
    publicClient.readContract({ address: EURC, abi: ERC20_ABI, functionName: "balanceOf", args: [relayAddress] }),
  ]);

  const txHashes: { token: string; hash: string; amount: string }[] = [];
  const errors:   { token: string; error: string }[] = [];

  for (const [symbol, tokenAddress, rawAmount] of [
    ["USDC", USDC, usdcRaw] as const,
    ["EURC", EURC, eurcRaw] as const,
  ]) {
    if (rawAmount === 0n) {
      req.log.info({ symbol }, "relay wallet has zero balance — skipping");
      continue;
    }
    try {
      const hash = await walletClient.writeContract({
        chain:        base,
        account:      relayAccount,
        address:      tokenAddress,
        abi:          ERC20_ABI,
        functionName: "transfer",
        args:         [recipient as `0x${string}`, rawAmount],
      });
      await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
      txHashes.push({ token: symbol, hash, amount: formatUnits(rawAmount, 6) });
      req.log.info({ symbol, hash, amount: rawAmount.toString(), recipient }, "relay drain transfer complete");
    } catch (err) {
      const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
      errors.push({ token: symbol, error: msg });
      req.log.error({ err, symbol }, "relay drain transfer failed");
    }
  }

  return res.json({ recipient, transfers: txHashes, errors });
});

export default router;
