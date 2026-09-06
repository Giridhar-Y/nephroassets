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
// Escalation target for a retry after the cheap model corrupts its own output. Found
// live-testing a real, near-deterministic failure: a question needing 2 conditions at
// once where the first is a date (e.g. "Dialysis machines acquired after April 2022
// with NBV above 2 lakhs") corrupted gpt-4o-mini's output 10 of 11 raw attempts across
// different seeds — the model writes a value's digits correctly, then hallucinates a
// fragment of the JSON it's about to write next (e.g. "},{") INTO that same string
// before actually closing the quote. The SAME prompt and question came back clean on
// gpt-4o every single time (0 corrupted of 10 attempts tested) — a real capability gap
// for this failure mode, not something more retries on the cheap model would fix (its
// own failure rate is too high for 3 attempts to reliably clear). Escalating only on
// retry keeps the common single-condition case on the cheap model.
const FALLBACK_MODEL = process.env.AI_SEARCH_FALLBACK_MODEL || "gpt-4o";
// A cheap per-user cost guard, not a precise budget — see ai_search_log's own comment in
// schema.sql. Configurable so a deployment that finds 40/day too tight (or too loose)
// doesn't need a code change.
const DAILY_LIMIT = Number(process.env.AI_SEARCH_DAILY_LIMIT ?? 40);

const searchBodySchema = z.object({ question: z.string().trim().min(1).max(300) });

interface OpenAiChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// A condition's value/valueTo should never contain JSON structural characters — if it
// does, generation glitched mid-string. Found live-testing: a response needing multiple
// populated array entries at once (2 conditions, or a named field alongside a
// condition) intermittently re-emitted a fragment of its own closing JSON syntax (e.g.
// "0},{") INTO a string value — not a parse failure (JSON.parse succeeds fine on a
// syntactically valid string that happens to contain garbage), so it has to be caught
// here, by content, not by JSON.parse throwing. Non-deterministic in practice even with
// temperature turned down and a fixed seed (see callOpenAiOnce's own comment) — an
// automatic one-time retry is the pragmatic fix for a low-probability generation
// glitch, not chasing it further through prompt wording alone.
function looksCorrupted(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null || !("conditions" in raw)) return false;
  const conditions = (raw as { conditions?: unknown }).conditions;
  if (!Array.isArray(conditions)) return false;
  const hasJunk = (v: unknown) => typeof v === "string" && /[{}[\]]/.test(v);
  return conditions.some((c) => hasJunk((c as { value?: unknown })?.value) || hasJunk((c as { valueTo?: unknown })?.valueTo));
}

async function callOpenAiOnce(
  question: string,
  todayIso: string,
  masters: MasterLookupMaps,
  attempt: number,
  model: string
): Promise<{ raw: unknown; promptTokens: number; completionTokens: number; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("AI Search is not configured on this server yet."), { statusCode: 503 });

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      // temperature: 0 (greedy decoding) was found live-testing to be a real cause, not
      // just a determinism choice — any response needing MULTIPLE populated fields at
      // once (e.g. status + a condition, or 2 sub-classifications + 2 conditions)
      // reliably degenerated into a repetition loop, re-emitting a fragment of closing
      // JSON syntax (e.g. "0},{") INTO a string value mid-write, a well-documented
      // failure mode of greedy decoding getting stuck once it revisits a similar
      // generation state. A small non-zero temperature plus `seed` is the current
      // recommended way to get repeatable output without that degeneracy — determinism
      // from the seed, not from removing all randomness. The seed is varied PER ATTEMPT
      // (found live-testing: "written down value under 50000" degenerated identically on
      // ALL 3 attempts, back to back, twice in a row — a fixed seed across retries isn't
      // an independent second sample, it's asking the same near-deterministic question
      // again and getting the same near-deterministic wrong answer) so a retry actually
      // explores a different completion instead of very likely repeating attempt 1.
      temperature: 0.2,
      seed: 20260906 + attempt,
      // The direct, targeted fix for the exact failure confirmed by inspecting a raw
      // truncated completion: the model got stuck re-emitting "}]}]}]}]..." (closing
      // array/object syntax) literally hundreds of times until max_tokens cut it off —
      // a textbook token-repetition loop, not a content/reasoning problem.
      // frequency_penalty discourages the model from repeating a token it has already
      // used, which is precisely what breaks this kind of loop; temperature/seed above
      // help but didn't fully stop it alone. json_schema strict mode still constrains
      // every token to valid grammar regardless of this penalty, so it can't produce
      // invalid JSON — only affects which valid continuation it picks.
      frequency_penalty: 0.4,
      presence_penalty: 0.4,
      // Small on purpose — the response is a short JSON object (a handful of filter
      // fields), never prose — but not too small: found live-testing that even a
      // question whose correct answer is tiny (one condition) can intermittently hit an
      // unstable, runaway-length generation (see the finish_reason==="length" comment
      // below for the full account) — raised twice now (500 -> 1000 -> 1500) chasing
      // that headroom, alongside the retry-on-corruption/truncation safety net, which
      // matters more here than the exact number: still bounding real runaway cost, not
      // trying to eliminate the instability through token budget alone.
      max_tokens: 1500,
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
  if (!content) throw Object.assign(new Error("AI Search didn't come back with anything that time — try asking again."), { statusCode: 502 });

  // Caught here specifically, not left to surface as a generic JSON.parse failure below —
  // a max_tokens cutoff mid-JSON is a diagnosable case worth a clearer message. Found
  // live-testing: this fires intermittently even for questions whose correct answer is
  // tiny (one condition) — the SAME instability looksCorrupted guards against below,
  // just manifesting as a runaway-length generation instead of a garbled value this
  // time, on the identical question, across otherwise-identical calls. Marked
  // `corrupted` too (despite the different cause) so callOpenAi's retry covers it — a
  // second attempt at non-zero temperature has a real chance of not repeating whatever
  // triggered the first one to run long.
  if (body.choices?.[0]?.finish_reason === "length") {
    throw Object.assign(new Error("That question needed a longer answer than AI Search allows — try asking something a bit more specific."), {
      statusCode: 502,
      corrupted: true
    });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw Object.assign(new Error("That didn't come back in a shape AI Search understood — try again, maybe with simpler wording."), {
      statusCode: 502,
      corrupted: true
    });
  }
  if (looksCorrupted(raw)) {
    throw Object.assign(new Error("AI Search got a bit tangled up on that one — try again, maybe with simpler wording."), {
      statusCode: 502,
      corrupted: true
    });
  }
  return { raw, promptTokens: body.usage?.prompt_tokens ?? 0, completionTokens: body.usage?.completion_tokens ?? 0, model };
}

const MAX_ATTEMPTS = 3;

/** Up to 3 attempts total — only ever retries the specific, diagnosed glitch (parse
 *  failure or looksCorrupted's content check), never a real config/permission/rate-limit
 *  error (503/429/etc. from callOpenAiOnce itself), which retrying wouldn't fix and would
 *  just double the cost of. Each attempt gets a different `seed` (see callOpenAiOnce) so
 *  a retry is a genuinely different sample, not the same near-deterministic completion
 *  again. Attempt 1 uses the cheap MODEL; every retry escalates to FALLBACK_MODEL (see
 *  its own comment) — live-testing found some multi-condition questions corrupt the
 *  cheap model's output on nearly EVERY attempt, so more retries on the same model
 *  wouldn't reliably clear it, only a stronger model does. */
async function callOpenAi(
  question: string,
  todayIso: string,
  masters: MasterLookupMaps
): Promise<{ raw: unknown; promptTokens: number; completionTokens: number; model: string }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await callOpenAiOnce(question, todayIso, masters, attempt, attempt === 1 ? MODEL : FALLBACK_MODEL);
    } catch (err) {
      lastErr = err;
      if (!(err as { corrupted?: boolean })?.corrupted) throw err;
    }
  }
  throw lastErr;
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
          callResult.model,
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
