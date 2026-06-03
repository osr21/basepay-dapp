import { Router } from "express";
import { db, appRegistrationTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

const DEPLOYER    = process.env.DEPLOYER_ADDRESS        ?? "";
const FEE_ADDR    = process.env.FEE_COLLECTOR_ADDRESS   ?? DEPLOYER;
const FEE_BPS     = parseInt(process.env.FEE_BPS ?? "30", 10);
const ROUTER_ADDR = process.env.VITE_ROUTER_ADDRESS    ?? null;

function serialize(r: typeof appRegistrationTable.$inferSelect) {
  return {
    ...r,
    registeredAt: r.registeredAt.toISOString(),
    updatedAt:    r.updatedAt.toISOString(),
  };
}

async function ensureRegistration() {
  const [existing] = await db.select().from(appRegistrationTable).where(eq(appRegistrationTable.id, 1));
  if (existing) {
    // If env vars supply a router address that differs from what's stored, sync it
    if (ROUTER_ADDR && existing.routerAddress !== ROUTER_ADDR) {
      const [updated] = await db
        .update(appRegistrationTable)
        .set({ routerAddress: ROUTER_ADDR })
        .where(eq(appRegistrationTable.id, 1))
        .returning();
      return updated;
    }
    return existing;
  }
  const [created] = await db
    .insert(appRegistrationTable)
    .values({
      id:                  1,
      appName:             "BasePay",
      appVersion:          "1.0.0",
      deployerAddress:     DEPLOYER,
      feeCollectorAddress: FEE_ADDR,
      feeBps:              FEE_BPS,
      routerAddress:       ROUTER_ADDR || null,
      network:             "Base Mainnet",
      chainId:             8453,
      verified:            DEPLOYER.startsWith("0x"),
    })
    .returning();
  return created;
}

/**
 * GET /api/app/config
 * Returns the app registration (fee settings, router address, etc.).
 * Config is seeded from server env vars — no unauthenticated write endpoint is exposed.
 */
router.get("/app/config", async (_req, res) => {
  const reg = await ensureRegistration();
  return res.json(serialize(reg));
});

export default router;
