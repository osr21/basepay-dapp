import { Router } from "express";
import { db, appRegistrationTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { RegisterAppBody } from "@workspace/api-zod";

const router = Router();

const DEPLOYER   = process.env.DEPLOYER_ADDRESS        ?? "";
const FEE_ADDR   = process.env.FEE_COLLECTOR_ADDRESS   ?? DEPLOYER;
const FEE_BPS    = parseInt(process.env.FEE_BPS ?? "30", 10);
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
  if (existing) return existing;
  const [created] = await db
    .insert(appRegistrationTable)
    .values({
      id:                 1,
      appName:            "BasePay",
      appVersion:         "1.0.0",
      deployerAddress:    DEPLOYER,
      feeCollectorAddress: FEE_ADDR,
      feeBps:             FEE_BPS,
      routerAddress:      ROUTER_ADDR || null,
      network:            "Base Mainnet",
      chainId:            8453,
      verified:           DEPLOYER.startsWith("0x"),
    })
    .returning();
  return created;
}

router.get("/app/config", async (_req, res) => {
  const reg = await ensureRegistration();
  return res.json(serialize(reg));
});

router.post("/app/config", async (req, res) => {
  const parsed = RegisterAppBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body" });
  }

  await ensureRegistration();

  const updates: Partial<typeof appRegistrationTable.$inferInsert> = {
    deployerAddress:    parsed.data.deployerAddress,
    feeCollectorAddress: parsed.data.feeCollectorAddress,
    feeBps:             parsed.data.feeBps ?? FEE_BPS,
    routerAddress:      parsed.data.routerAddress ?? null,
    verified:           parsed.data.deployerAddress.startsWith("0x"),
    updatedAt:          new Date(),
  };

  const [updated] = await db
    .update(appRegistrationTable)
    .set(updates)
    .where(eq(appRegistrationTable.id, 1))
    .returning();

  return res.json(serialize(updated));
});

export default router;
