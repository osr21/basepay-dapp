import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";

export const developerKeysTable = pgTable("developer_keys", {
  id:            serial("id").primaryKey(),
  walletAddress: text("wallet_address").notNull(),
  keyPrefix:     text("key_prefix").notNull(),
  keyHash:       text("key_hash").notNull().unique(),
  name:          text("name").notNull(),
  createdAt:     timestamp("created_at").defaultNow().notNull(),
  revokedAt:     timestamp("revoked_at"),
  lastUsedAt:    timestamp("last_used_at"),
  requestCount:  integer("request_count").notNull().default(0),
});

export type DeveloperKey = typeof developerKeysTable.$inferSelect;
