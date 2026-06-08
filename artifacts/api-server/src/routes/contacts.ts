import { Router } from "express";
import { isAddress } from "viem";
import { db, contactsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import {
  ListContactsQueryParams,
  CreateContactBody,
  DeleteContactParams,
  DeleteContactQueryParams,
} from "@workspace/api-zod";

const router = Router();

// ── Field constraints (enforced here because the generated schema has no maxes) ──
const MAX_NAME_LEN    = 100;
const MAX_ENS_LEN     = 100;

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
  const { name, walletAddress, ensName, ownerAddress } = parsed.data;

  // Extra validation beyond the generated schema
  if (name.length > MAX_NAME_LEN) {
    return res.status(400).json({ error: `name must be at most ${MAX_NAME_LEN} characters` });
  }
  if (ensName && ensName.length > MAX_ENS_LEN) {
    return res.status(400).json({ error: `ensName must be at most ${MAX_ENS_LEN} characters` });
  }
  if (!isAddress(walletAddress)) {
    return res.status(400).json({ error: "walletAddress must be a valid Ethereum address" });
  }
  if (ownerAddress && !isAddress(ownerAddress)) {
    return res.status(400).json({ error: "ownerAddress must be a valid Ethereum address" });
  }

  const [row] = await db.insert(contactsTable).values(parsed.data).returning();
  return res.status(201).json({ ...row, createdAt: row.createdAt.toISOString() });
});

/**
 * DELETE /api/contacts/:id?ownerAddress=0x...
 * Requires ownerAddress — only the owner's contact is deleted.
 * Returns 404 if the contact doesn't exist or doesn't belong to the caller.
 */
router.delete("/contacts/:id", async (req, res) => {
  const paramsParsed = DeleteContactParams.safeParse(req.params);
  const queryParsed  = DeleteContactQueryParams.safeParse(req.query);
  if (!paramsParsed.success || !queryParsed.success) {
    return res.status(400).json({ error: "Invalid params" });
  }

  const deleted = await db
    .delete(contactsTable)
    .where(
      and(
        eq(contactsTable.id, paramsParsed.data.id),
        eq(contactsTable.ownerAddress, queryParsed.data.ownerAddress),
      ),
    )
    .returning({ id: contactsTable.id });

  if (deleted.length === 0) {
    return res.status(404).json({ error: "Contact not found or not owned by this address" });
  }

  return res.json({ success: true });
});

export default router;
