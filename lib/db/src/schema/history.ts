import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const historyTable = pgTable("history", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  stdout: text("stdout").notNull(),
  stderr: text("stderr").notNull(),
  exitCode: integer("exit_code").notNull(),
  executionTimeMs: integer("execution_time_ms").notNull(),
  executedAt: timestamp("executed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertHistorySchema = createInsertSchema(historyTable).omit({ id: true, executedAt: true });
export type InsertHistory = z.infer<typeof insertHistorySchema>;
export type History = typeof historyTable.$inferSelect;
