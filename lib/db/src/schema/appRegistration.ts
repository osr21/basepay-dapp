import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const appRegistrationTable = pgTable("app_registration", {
  id: integer("id").primaryKey().default(1),
  appName: text("app_name").notNull().default("BasePay"),
  appVersion: text("app_version").notNull().default("1.0.0"),
  deployerAddress: text("deployer_address").notNull(),
  feeCollectorAddress: text("fee_collector_address").notNull(),
  feeBps: integer("fee_bps").notNull().default(30),
  routerAddress: text("router_address"),
  network: text("network").notNull().default("Base Mainnet"),
  chainId: integer("chain_id").notNull().default(8453),
  verified: boolean("verified").notNull().default(false),
  registeredAt: timestamp("registered_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type AppRegistration = typeof appRegistrationTable.$inferSelect;
