import { useEffect, useRef, useState } from "react";
import { fetchAiSearchStatus, runAiSearch, type AiSearchResult, type AiSearchStatus } from "../api/client.js";
import { useFilters } from "../lib/FiltersContext.js";
import { useAuth } from "../lib/AuthContext.js";
import { hasPermission } from "../lib/permissions.js";
import { ALL_COLUMNS } from "../lib/columns.js";
import { OPERATORS_BY_TYPE } from "../lib/columnFilters.js";
import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";
import { useToast } from "./Toast.js";
import { AiSearchIcon, DismissIcon, ErrorIcon, RetryIcon } from "../lib/icons.js";
import type { AssetFilters } from "../lib/types.js";

// A handful of realistic starting points — not a feature list, just enough to show the
// kind of question this understands (a name/location, an amount, a date range, a
// disposal outcome) so a first-time user isn't staring at a blank box. Clicking one
// fills the input rather than submitting immediately, so it can still be edited.
const EXAMPLE_QUESTIONS = [
  "Active dialysis machines at Hyderabad",
  "Assets acquired this financial year over ₹5 lakh",
  "Disposed assets with a loss",
  "C1 NBV under 10,000 in Chennai"
];

// Client-side memo of the last few questions asked this session, keyed by the exact
// question text — a repeated/typo-corrected-back-to-original question doesn't need a
// second OpenAI call. Deliberately small and in-memory only (module-level, not
// persisted): a cheap win, not a real cache layer.
const recentResultCache = new Map<string, AiSearchResult>();

function applyResultToFilters(result: AiSearchResult): Partial<AssetFilters> {
  const partial: Partial<AssetFilters> = {};
  if (result.globalSearch) partial.globalSearch = result.globalSearch;
  if (result.subClassification?.length) partial.subClassification = result.subClassification;
  if (result.status?.length) partial.status = result.status;
  if (result.center?.length) partial.center = result.center;
  if (result.capLocation?.length) partial.capLocation = result.capLocation;
  if (result.dateAcquiredFrom) partial.dateAcquiredFrom = result.dateAcquiredFrom;
  if (result.dateAcquiredTo) partial.dateAcquiredTo = result.dateAcquiredTo;
  if (result.conditions.length) partial.conditions = result.conditions;
  return partial;
}

// Reuses Register's own column labels/operator labels (ALL_COLUMNS, OPERATORS_BY_TYPE) —
// the same names/wording a manually-picked filter already shows — so a reviewed AI
// filter reads exactly like one the user picked by hand, not a second, differently-worded
// vocabulary.
const COLUMN_LABELS: Record<string, string> = Object.fromEntries(ALL_COLUMNS.map((c) => [c.id, c.label]));
const OPERATOR_LABELS: Record<string, string> = Object.fromEntries(
  Object.values(OPERATORS_BY_TYPE)
    .flat()
    .map((op) => [op.value, op.label])
);

/** One human-readable line per filter field the AI actually set — the thing a user scans
 *  to answer "did it understand me correctly?" before committing to anything. Named
 *  fields first (the common case), then each Excel-style condition. */
function describeFilters(result: AiSearchResult): string[] {
  const lines: string[] = [];
  if (result.globalSearch) lines.push(`Search: "${result.globalSearch}"`);
  if (result.subClassification?.length) lines.push(`Sub Classification: ${result.subClassification.join(", ")}`);
  if (result.status?.length) lines.push(`Status: ${result.status.join(", ")}`);
  if (result.center?.length) lines.push(`Current Location: ${result.center.join(", ")}`);
  if (result.capLocation?.length) lines.push(`Capitalized Location: ${result.capLocation.join(", ")}`);
  if (result.dateAcquiredFrom) lines.push(`Date Acquired from: ${result.dateAcquiredFrom}`);
  if (result.dateAcquiredTo) lines.push(`Date Acquired to: ${result.dateAcquiredTo}`);
  for (const cond of result.conditions) {
    const column = COLUMN_LABELS[cond.columnId] ?? cond.columnId;
    const op = OPERATOR_LABELS[cond.op] ?? cond.op;
    const value = cond.op === "between" ? `${cond.value} – ${cond.valueTo}` : cond.value;
    lines.push(value ? `${column} ${op.toLowerCase()} ${value}` : `${column} ${op.toLowerCase()}`);
  }
  return lines;
}

// The AI icon next to Register's density/full-screen controls (GridViewControls) — opens
// a search box that turns a plain-English question into the exact same filters the
// manual filter UI produces (see api/client.ts's AiSearchResult), applied through the
// same FiltersContext every other Register filter uses. Self-contained: owns its own
// open/loading/error state, renders nothing if the signed-in user lacks
// register:aiSearch or the server reports the feature isn't configured.
export function AiSearchButton() {
  const { user } = useAuth();
  const { mergeFilters, replaceFilters } = useFilters();
  const { showToast } = useToast();
  const [status, setStatus] = useState<AiSearchStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The result awaiting review — nothing is applied to Register's real filters until the
  // user explicitly confirms it. AI output isn't always right, so this is a deliberate
  // "show your work" step before it touches anything, not just a toast after the fact.
  const [pending, setPending] = useState<AiSearchResult | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const allowed = hasPermission(user, "register", "aiSearch");

  useEffect(() => {
    if (!allowed) return;
    fetchAiSearchStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [allowed]);

  useEffect(() => {
    if (open && !pending) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, pending]);

  if (!allowed || status?.enabled === false) return null;

  function reset() {
    setOpen(false);
    setQuestion("");
    setPending(null);
    setError(null);
  }

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    try {
      const cached = recentResultCache.get(trimmed);
      const result = cached ?? (await runAiSearch(trimmed));
      recentResultCache.set(trimmed, result);
      if (recentResultCache.size > 20) recentResultCache.delete(recentResultCache.keys().next().value!);

      setStatus((prev) => (prev ? { ...prev, remainingToday: result.remainingToday } : prev));
      // Always lands in the review step, matched or not — describeFilters([]) for an
      // unmatched result just renders empty, and the explanation alone (e.g. "that's not
      // something Register can filter on") is exactly what the user needs to see next.
      setPending(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI Search failed — try again.");
    } finally {
      setLoading(false);
    }
  }

  function apply() {
    if (!pending) return;
    const before = mergeFilters(applyResultToFilters(pending));
    reset();
    showToast(`AI Search applied: ${pending.explanation}`, "success", {
      label: "Undo",
      onClick: () => replaceFilters(before)
    });
  }

  const filterLines = pending ? describeFilters(pending) : [];

  return (
    <>
      <button
        type="button"
        aria-label="Ask AI to filter the Register"
        title="Ask AI to filter the Register"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full bg-brand-teal px-3 py-1.5 text-xs font-bold text-white shadow-sm transition-colors hover:bg-brand-teal/90"
      >
        <AiSearchIcon fontSize={14} />
        Ask AI
      </button>

      {open && (
        <Modal onClose={reset} widthClassName="max-w-xl" stacked>
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-teal/15 text-brand-teal">
                <AiSearchIcon fontSize={18} />
              </span>
              <div>
                <h2 className="font-heading text-base font-semibold text-ink">Ask AI to filter the Register</h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  Describe what you're looking for — AI turns it into the same filters you'd pick by hand.
                </p>
              </div>
            </div>
            <button type="button" aria-label="Close" onClick={reset} className="rounded p-1 text-gray-400 hover:bg-gray-100">
              <DismissIcon fontSize={16} />
            </button>
          </div>

          {!pending ? (
            <form
              className="mt-5"
              onSubmit={(e) => {
                e.preventDefault();
                ask(question);
              }}
            >
              <textarea
                ref={inputRef}
                rows={3}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    ask(question);
                  }
                }}
                maxLength={300}
                placeholder="e.g. Dialysis machines at Hyderabad acquired after April 2024 with NBV over ₹2 lakh"
                className="w-full resize-none rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-ink placeholder:text-gray-400 focus:border-brand-teal focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
              />

              {error && (
                <p className="mt-2.5 flex items-start gap-1.5 rounded-md bg-accent-light p-2 text-xs text-accent-hover">
                  <ErrorIcon fontSize={14} className="mt-0.5 shrink-0" />
                  {error}
                </p>
              )}

              <div className="mt-3 flex flex-wrap gap-1.5">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setQuestion(q)}
                    className="rounded-full border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 transition-colors hover:border-brand-teal hover:text-brand-teal"
                  >
                    {q}
                  </button>
                ))}
              </div>

              <div className="mt-5 flex items-center justify-between border-t border-gray-100 pt-4">
                <span className="text-[11px] text-gray-400">
                  {status ? `${status.remainingToday} of ${status.dailyLimit} searches left today` : ""}
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={reset}>
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={loading || !question.trim() || (status ? status.remainingToday <= 0 : false)}
                    className="!bg-brand-teal hover:!bg-brand-teal/90"
                  >
                    {loading ? "Thinking…" : "Ask AI"}
                  </Button>
                </div>
              </div>
            </form>
          ) : (
            // Review step — nothing above has touched Register's real filters yet.
            // AI output isn't always right, so this shows exactly what would happen and
            // waits for an explicit Apply, rather than applying first and hoping Undo
            // covers it.
            <div className="mt-5">
              <p className="rounded-lg bg-gray-50 p-3 text-sm text-ink">{pending.explanation}</p>

              {filterLines.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Filters found</div>
                  <ul className="mt-1.5 space-y-1">
                    {filterLines.map((line, i) => (
                      <li key={i} className="flex items-center gap-2 rounded-md bg-brand-teal/10 px-2.5 py-1.5 text-xs font-medium text-brand-deepBlue">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-teal" />
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {pending.warnings.length > 0 && (
                <div className="mt-3 space-y-1">
                  {pending.warnings.map((w, i) => (
                    <p key={i} className="flex items-start gap-1.5 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                      <ErrorIcon fontSize={14} className="mt-0.5 shrink-0" />
                      {w}
                    </p>
                  ))}
                </div>
              )}

              <div className="mt-5 flex items-center justify-between border-t border-gray-100 pt-4">
                <button
                  type="button"
                  onClick={() => setPending(null)}
                  className="flex items-center gap-1 text-xs font-semibold text-gray-500 hover:text-ink"
                >
                  <RetryIcon fontSize={13} />
                  Try a different question
                </button>
                <div className="flex gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={reset}>
                    Discard
                  </Button>
                  {filterLines.length > 0 && (
                    <Button type="button" size="sm" onClick={apply} className="!bg-brand-teal hover:!bg-brand-teal/90">
                      Apply Filters
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
