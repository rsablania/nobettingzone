import { Router, type IRouter } from "express";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { db, sessionsTable, historyTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  ExecuteCodeBody,
  ExecuteCodeResponse,
  ListSessionsResponse,
  CreateSessionBody,
  GetSessionParams,
  GetSessionResponse,
  DeleteSessionParams,
  GetHistoryResponse,
} from "@workspace/api-zod";

const execAsync = promisify(exec);

const router: IRouter = Router();

router.post("/repl/execute", async (req, res): Promise<void> => {
  const parsed = ExecuteCodeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { code, timeout = 10000 } = parsed.data;
  const start = Date.now();

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let error: string | null = null;

  try {
    const result = await execAsync(`node --eval ${JSON.stringify(code)}`, {
      timeout: timeout ?? 10000,
      env: { ...process.env, NODE_ENV: "sandbox" },
    });
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
  } catch (err: unknown) {
    exitCode = 1;
    if (err && typeof err === "object") {
      const execErr = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
      stdout = execErr.stdout ?? "";
      stderr = execErr.stderr ?? "";
      if (execErr.killed) {
        error = `Execution timed out after ${timeout}ms`;
        stderr = error;
      } else {
        error = execErr.message ?? "Execution failed";
      }
    } else {
      error = String(err);
    }
  }

  const executionTimeMs = Date.now() - start;

  await db.insert(historyTable).values({
    code,
    stdout,
    stderr,
    exitCode,
    executionTimeMs,
  });

  res.json(
    ExecuteCodeResponse.parse({
      stdout,
      stderr,
      exitCode,
      executionTimeMs,
      error,
    }),
  );
});

router.get("/repl/sessions", async (_req, res): Promise<void> => {
  const sessions = await db
    .select()
    .from(sessionsTable)
    .orderBy(desc(sessionsTable.updatedAt));
  res.json(ListSessionsResponse.parse(sessions));
});

router.post("/repl/sessions", async (req, res): Promise<void> => {
  const parsed = CreateSessionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [session] = await db
    .insert(sessionsTable)
    .values(parsed.data)
    .returning();

  res.status(201).json(GetSessionResponse.parse(session));
});

router.get("/repl/sessions/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetSessionParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.id, params.data.id));

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json(GetSessionResponse.parse(session));
});

router.delete("/repl/sessions/:id", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteSessionParams.safeParse({ id: parseInt(raw, 10) });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deleted] = await db
    .delete(sessionsTable)
    .where(eq(sessionsTable.id, params.data.id))
    .returning();

  if (!deleted) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.sendStatus(204);
});

router.get("/repl/history", async (_req, res): Promise<void> => {
  const history = await db
    .select()
    .from(historyTable)
    .orderBy(desc(historyTable.executedAt))
    .limit(100);
  res.json(GetHistoryResponse.parse(history));
});

export default router;
