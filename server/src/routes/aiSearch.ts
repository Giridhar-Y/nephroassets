import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPool } from "../db/pool.js";
import { requirePermission } from "../auth/middleware.js";
import { loadActiveMasterMaps, type MasterLookupMaps } from "./bulkParse.js";
import { describeCondition, describeNamedFilters } from "./assetColumnFilters.js";
import { buildSystemPrompt, REGISTER_SEARCH_JSON_SCHEMA, translateModelOutput } from "../ai/registerSearch.js";

// AI Register Search — "ask a question, get the register filtered" (see the AI icon
// next to Register's density/full-screen controls). Deliberately thin: all the actual
// column/operator/master-list safety logic lives in ai/registerSearch.ts (pure,
// unit-tested without a network call); this file is just the OpenAI call plus the
// per-app concerns a pure function can't own — permission gating, a daily per-user cost
// cap, and an audit trail of what was asked and what got applied.

const MODEL = process.env.AI_SEARCH_MODEL || "gpt-4o-mini";
// A cheap per-user cost guard, not a precise budget — see ai_search_log's own comment in
// schema.sql. Configurable so a deployment that finds 40/day too tight (or too loose)
// doesn't need a code change.
const DAILY_LIMIT = Number(process.env.AI_SEARCH_DAILY_LIMIT ?? 40);

const searchBodySchema = z.object({ question: z.string().trim().min(1).max(300) });

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function callOpenAi(
  question: string,
  todayIso: string,
  masters: MasterLookupMaps
): Promise<{ raw: unknown; promptTokens: number; completionTokens: number }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("AI Search is not configured on this server yet."), { statusCode: 503 });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      // Small on purpose — the response is a short JSON object (a handful of filter
      // fields), never prose. Keeping this tight is itself a cost guard, not just a
      // safety net: a runaway/looping completion can't burn tokens past this cap.
      max_tokens: 500,
      messages: [
        { role: "system", content: buildSystemPrompt(todayIso, masters) },
        { role: "user", content: question }
      ],
      response_format: { type: "json_schema", json_schema: REGISTER_SEARCH_JSON_SCHEMA }
    })
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw Object.assign(new Error(`AI Search request failed (${res.status}).`), { statusCode: 502, detail: bodyText });
  }
  const body = (await res.json()) as OpenAiChatResponse;
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw Object.assign(new Error("AI Search returned an empty response."), { statusCode: 502 });

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw Object.assign(new Error("AI Search returned a response that couldn't be read."), { statusCode: 502 });
  }
  return { raw, promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0 };
}

export default async function aiSearchRoutes(app: FastifyInstance) {
  // Lets the client show/hide the AI button and a "X of Y today" hint without a failed
  // search attempt being the first sign the feature is off or the cap is hit.
  app.get("/api/ai/register-search/status", { preHandler: requirePermission("register", "aiSearch") }, async (req) => {
    const db = await getPool();
    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ai_search_log WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
      [req.user!.id]
    );
    const usedToday = Number(rows[0]!.count);
    return {
      enabled: !!process.env.OPENAI_API_KEY,
      dailyLimit: DAILY_LIMIT,
      remainingToday: Math.max(0, DAILY_LIMIT - usedToday)
    };
  });

  app.post("/api/ai/register-search", { preHandler: requirePermission("register", "aiSearch") }, async (req, reply) => {
    const parsed = searchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "A question is required (up to 300 characters).", details: parsed.error.flatten() };
    }
    const db = await getPool();

    const { rows: capRows } = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM ai_search_log WHERE user_id = $1 AND created_at >= date_trunc('day', now())`,
      [req.user!.id]
    );
    const usedToday = Number(capRows[0]!.count);
    if (usedToday >= DAILY_LIMIT) {
      reply.code(429);
      return { error: `You've reached today's AI Search limit (${DAILY_LIMIT}). Try again tomorrow, or filter manually.` };
    }

    // Loaded before the OpenAI call, not after — the prompt itself needs these real
    // active values to ground the model's guesses (see buildSystemPrompt's own comment
    // for the real failure this fixes), not just to validate its output afterward. Same
    // maps serve both, one query instead of two.
    const masters = await loadActiveMasterMaps(db);

    const todayIso = new Date().toISOString().slice(0, 10);
    let callResult: Awaited<ReturnType<typeof callOpenAi>>;
    try {
      callResult = await callOpenAi(parsed.data.question, todayIso, masters);
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode ?? 502;
      req.log.error({ err }, "AI Register Search: OpenAI call failed");
      reply.code(statusCode);
      return { error: err instanceof Error ? err.message : "AI Search failed." };
    }

    const translated = translateModelOutput(callResult.raw, masters);
    // Deterministic, server-generated recap — reuses the SAME description functions the
    // Register Export's own filter-summary note already uses, built from `translated`
    // (the actual validated filters about to be applied), never from the model's own
    // `explanation` text. What the client shows in its "Filters found" review list is
    // guaranteed to match what Apply actually does, since both read the same data.
    const filterDescriptions = translated.applied
      ? [...describeNamedFilters(translated), ...translated.conditions.map(describeCondition)]
      : [];

    // Logged regardless of whether anything actually got applied — a string of
    // "matched: false" rows is itself useful signal (the prompt needs work, or users are
    // asking things this feature was never meant to answer), not noise to skip.
    await db
      .query(
        `INSERT INTO ai_search_log (user_id, question, model, matched, applied_filters, warnings, prompt_tokens, completion_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          req.user!.id,
          parsed.data.question,
          MODEL,
          translated.applied,
          JSON.stringify(translated),
          JSON.stringify(translated.warnings),
          callResult.promptTokens,
          callResult.completionTokens
        ]
      )
      .catch((err) => req.log.error({ err }, "AI Register Search: failed to write ai_search_log (non-fatal)"));

    return { ...translated, filterDescriptions, remainingToday: Math.max(0, DAILY_LIMIT - usedToday - 1) };
  });
}
