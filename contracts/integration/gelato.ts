/**
 * BasePay × Gelato Automation
 *
 * SubscriptionManagerV2.charge(id) is permissionless and time-gated.
 * Any address can call it once per subscription interval — which makes it
 * a perfect target for Gelato's automated task infrastructure.
 *
 * Two approaches are shown here:
 *   A) Gelato Web3 Functions (on-chain task, recommended)
 *   B) Manual off-chain keeper bot (no external dependency)
 *
 * Contract: 0x101918a252b3852ac4b50b7bbf2525d3084d5421 (Base Mainnet)
 * Docs: https://docs.gelato.network/web3-functions
 */

// ─────────────────────────────────────────────────────────────────────────────
// A) Gelato Automated Task (UI / SDK setup)
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. Install the Gelato Automate SDK:
//    npm install @gelatonetwork/automate-sdk
//
// 2. Go to https://app.gelato.network/new-task, connect your wallet,
//    select "Base Mainnet" and configure:
//
//    Contract address : 0x101918a252b3852ac4b50b7bbf2525d3084d5421
//    Function         : charge(uint256 id)
//    Argument (id)    : <your subscription ID returned by subscribe/subscribeWithPermit>
//
//    Trigger: "Time Interval" — set to match your subscription interval
//             (e.g. every 2592000 seconds = 30 days)
//
//    Gelato checks nextChargeAt(id) to verify the subscription is due before
//    executing. If a charge attempt fails, Gelato retries automatically.
//
// ─────────────────────────────────────────────────────────────────────────────

// Example: programmatic task creation via Gelato Automate SDK
//
// import { AutomateSDK, TriggerType } from "@gelatonetwork/automate-sdk";
// import { ethers } from "ethers";
// import { SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI } from "@basepay/contracts";
//
// const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
// const signer   = new ethers.Wallet(process.env.KEEPER_PRIVATE_KEY!, provider);
// const automate = new AutomateSDK(8453, signer);
//
// async function createChargeTask(subscriptionId: bigint) {
//   const iface = new ethers.Interface(SUBSCRIPTION_ABI as any);
//   const { taskId, tx } = await automate.createTask({
//     name:       `BasePay Subscription #${subscriptionId}`,
//     execAddress: SUBSCRIPTION_ADDRESS,
//     execSelector: iface.getFunction("charge")!.selector,
//     execAbi:    JSON.stringify(SUBSCRIPTION_ABI),
//     execData:   iface.encodeFunctionData("charge", [subscriptionId]),
//     trigger: {
//       type:     TriggerType.TIME,
//       interval: 30 * 24 * 60 * 60 * 1000, // 30 days in ms
//     },
//     useTreasury: true, // use Gelato's 1Balance treasury for gas
//   });
//   console.log("Task created:", taskId, "TX:", tx.hash);
// }

// ─────────────────────────────────────────────────────────────────────────────
// B) Off-chain keeper bot (no external dependency)
// ─────────────────────────────────────────────────────────────────────────────

import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { SUBSCRIPTION_ADDRESS, SUBSCRIPTION_ABI } from "../index";

const publicClient = createPublicClient({
  chain:     base,
  transport: http("https://mainnet.base.org"),
});

/**
 * Checks whether a subscription is due and submits charge() if so.
 * Run this on a cron schedule matching the subscription interval.
 */
export async function chargeIfDue(
  subscriptionId: bigint,
  keeperPrivateKey: Hex,
): Promise<{ charged: boolean; txHash?: Hex; reason?: string }> {
  // 1. Check next charge timestamp
  const nextCharge = await publicClient.readContract({
    address:      SUBSCRIPTION_ADDRESS,
    abi:          SUBSCRIPTION_ABI,
    functionName: "nextChargeAt",
    args:         [subscriptionId],
  });

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (now < nextCharge) {
    const eta = Number(nextCharge - now);
    return { charged: false, reason: `Not due yet — ${eta}s until next charge` };
  }

  // 2. Verify subscription is still active
  const sub = await publicClient.readContract({
    address:      SUBSCRIPTION_ADDRESS,
    abi:          SUBSCRIPTION_ABI,
    functionName: "subscriptions",
    args:         [subscriptionId],
  });
  if (!sub[7]) { // active === false
    return { charged: false, reason: "Subscription is cancelled" };
  }

  // 3. Submit charge()
  const account      = privateKeyToAccount(keeperPrivateKey);
  const walletClient = createWalletClient({ account, chain: base, transport: http("https://mainnet.base.org") });

  const txHash = await walletClient.writeContract({
    address:      SUBSCRIPTION_ADDRESS,
    abi:          SUBSCRIPTION_ABI,
    functionName: "charge",
    args:         [subscriptionId],
  });

  return { charged: true, txHash };
}

/**
 * Batch-charges multiple subscriptions in a single run.
 * Useful for protocols managing many subscriber relationships.
 */
export async function batchChargeDue(
  subscriptionIds: bigint[],
  keeperPrivateKey: Hex,
): Promise<Map<bigint, { charged: boolean; txHash?: Hex; reason?: string }>> {
  const results = new Map<bigint, { charged: boolean; txHash?: Hex; reason?: string }>();

  for (const id of subscriptionIds) {
    try {
      results.set(id, await chargeIfDue(id, keeperPrivateKey));
    } catch (err) {
      results.set(id, {
        charged: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Convenience: ABI fragment for just the charge() function.
 * Useful for Gelato Web3 Functions or custom resolvers.
 */
export const CHARGE_ABI = parseAbi([
  "function charge(uint256 id) external",
  "function nextChargeAt(uint256 id) external view returns (uint256)",
  "function subscriptions(uint256 id) external view returns (address payer, address payee, address token, uint256 amount, uint256 interval, uint256 lastCharged, uint256 startTime, bool active, string memo)",
]);
