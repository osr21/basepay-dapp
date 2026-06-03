import { Router } from "express";
import { db, contactsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  ListContactsQueryParams,
  CreateContactBody,
  DeleteContactParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/contacts", async (req, res) => {
  const parsed = ListContactsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query params" });
  }
  const { ownerAddress } = parsed.data;
  const rows = ownerAddress
    ? await db.select().from(contactsTable).where(eq(contactsTable.ownerAddress, ownerAddress))
    : await db.select().from(contactsTable);
  return res.json(rows.map(r => ({ ...r, createdAt: r.createdAt.toISOString() })));
});

router.post("/contacts", async (req, res) => {
  const parsed = CreateContactBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid body" });
  }
  const [row] = await db.insert(contactsTable).values(parsed.data).returning();
  return res.status(201).json({ ...row, createdAt: row.createdAt.toISOString() });
});

router.delete("/contacts/:id", async (req, res) => {
  const parsed = DeleteContactParams.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid params" });
  }
  await db.delete(contactsTable).where(eq(contactsTable.id, parsed.data.id));
  return res.json({ success: true });
});

export default router;
