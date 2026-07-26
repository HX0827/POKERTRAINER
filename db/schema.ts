import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const pokerHands = sqliteTable("poker_hands", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  handId: text("hand_id").notNull().unique(),
  heroCards: text("hero_cards").notNull(),
  summary: text("summary").notNull(),
  resultBb: real("result_bb").notNull().default(0),
  markdown: text("markdown").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
