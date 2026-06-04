import { Router } from "express";
import { db, contactsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  ListContactsQueryParams,
  CreateContactBody,
  DeleteContactParams,
  DeleteContactQueryParams,
} from "@workspace/api-zod";

const router = Router();

router.get("/contacts", async (req, res) => {
  const parsed = ListContactsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid query params" });
  }
  const { ownerAddress } = parsed.data;
  if (!ownerAddress) {
    return res.status(400).json({ error: "ownerAddress is required" });
  }
  const rows = await db
    .select()
    .from(contactsTable)
    .where(eq(contactsTable.ownerAddress, ownerAddress));
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

/**
 * DELETE /api/contacts/:id?ownerAddress=0x...
 * Requires ownerAddress so only the owner's contact is deleted.
 */
router.delete("/contacts/:id", async (req, res) => {
  const paramsParsed = DeleteContactParams.safeParse(req.params);
  const queryParsed  = DeleteContactQueryParams.safeParse(req.query);
  if (!paramsParsed.success || !queryParsed.success) {
    return res.status(400).json({ error: "Invalid params" });
  }
  await db
    .delete(contactsTable)
    .where(
      and(
        eq(contactsTable.id, paramsParsed.data.id),
        eq(contactsTable.ownerAddress, queryParsed.data.ownerAddress),
      ),
    );
  return res.json({ success: true });
});

export default router;
