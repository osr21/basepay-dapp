import { Router } from "express";
import { db, appRegistrationTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

const DEPLOYER    = process.env.DEPLOYER_ADDRESS        ?? "";
const FEE_ADDR    = process.env.FEE_COLLECTOR_ADDRESS   ?? DEPLOYER;
const FEE_BPS     = parseInt(process.env.FEE_BPS ?? "30", 10);
const ROUTER_ADDR = process.env.VITE_ROUTER_ADDRESS    ?? null;

// In-memory cache — populated on first successful DB read.
// Invalidated only when ROUTER_ADDR differs from the stored value (env sync).
let cachedConfig: typeof appRegistrationTable.$inferSelect | null = null;

function serialize(r: typeof appRegistrationTable.$inferSelect) {
  return {
    ...r,
    registeredAt: r.registeredAt.toISOString(),
    updatedAt:    r.updatedAt.toISOString(),
  };
}

async function ensureRegistration() {
  // Return cache if populated and no env-driven router address to sync
  if (cachedConfig) {
    if (!ROUTER_ADDR || cachedConfig.routerAddress === ROUTER_ADDR) {
      return cachedConfig;
    }
  }

  const [existing] = await db.select().from(appRegistrationTable).where(eq(appRegistrationTable.id, 1));
  if (existing) {
    if (ROUTER_ADDR && existing.routerAddress !== ROUTER_ADDR) {
      const [updated] = await db
        .update(appRegistrationTable)
        .set({ routerAddress: ROUTER_ADDR, updatedAt: new Date() })
        .where(eq(appRegistrationTable.id, 1))
        .returning();
      cachedConfig = updated;
      return updated;
    }
    cachedConfig = existing;
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
  cachedConfig = created;
  return created;
}

/**
 * GET /api/app/config
 * Returns the app registration (fee settings, router address, etc.).
 * Config is seeded from server env vars — no unauthenticated write endpoint is exposed.
 * Result is cached in memory after the first DB read; only re-queries if ROUTER_ADDR
 * differs from the cached value (env-driven sync on new deploy).
 */
router.get("/app/config", async (_req, res) => {
  const reg = await ensureRegistration();
  return res.json(serialize(reg));
});

export default router;
