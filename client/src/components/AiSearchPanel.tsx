import { useEffect, useRef, useState } from "react";
import { fetchAiSearchStatus, runAiSearch, type AiSearchStatus } from "../api/client.js";
import { useFilters } from "../lib/FiltersContext.js";
import { useAuth } from "../lib/AuthContext.js";
import { hasPermission } from "../lib/permissions.js";
import { Modal } from "./ui/Modal.js";
import { Button } from "./ui/Button.js";
import { useToast } from "./Toast.js";
import { AiSearchIcon, DismissIcon, ErrorIcon } from "../lib/icons.js";
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
const recentResultCache = new Map<string, Awaited<ReturnType<typeof runAiSearch>>>();

function applyResultToFilters(result: Awaited<ReturnType<typeof runAiSearch>>): Partial<AssetFilters> {
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
  const [notMatched, setNotMatched] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const allowed = hasPermission(user, "register", "aiSearch");

  useEffect(() => {
    if (!allowed) return;
    fetchAiSearchStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [allowed]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  if (!allowed || status?.enabled === false) return null;

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    setNotMatched(null);
    try {
      const cached = recentResultCache.get(trimmed);
      const result = cached ?? (await runAiSearch(trimmed));
      recentResultCache.set(trimmed, result);
      if (recentResultCache.size > 20) recentResultCache.delete(recentResultCache.keys().next().value!);

      setStatus((prev) => (prev ? { ...prev, remainingToday: result.remainingToday } : prev));

      if (!result.applied) {
        setNotMatched(result.explanation);
        return;
      }

      const before = mergeFilters(applyResultToFilters(result));
      setOpen(false);
      setQuestion("");
      const warningSuffix = result.warnings.length > 0 ? ` (${result.warnings.length} note${result.warnings.length > 1 ? "s" : ""} — see filters applied)` : "";
      showToast(`AI Search: ${result.explanation}${warningSuffix}`, "success", {
        label: "Undo",
        onClick: () => replaceFilters(before)
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI Search failed — try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-label="Ask AI to filter the Register"
        title="Ask AI to filter the Register"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-md border border-brand-teal/40 bg-brand-teal/10 px-2 py-1 text-xs font-semibold text-brand-teal hover:bg-brand-teal/20"
      >
        <AiSearchIcon fontSize={14} />
        AI
      </button>

      {open && (
        <Modal onClose={() => setOpen(false)} widthClassName="max-w-xl" stacked>
          <div className="flex items-start justify-between">
            <div>
              <h2 className="flex items-center gap-1.5 font-heading text-base font-semibold text-ink">
                <AiSearchIcon fontSize={18} className="text-brand-teal" />
                Ask AI to filter the Register
              </h2>
              <p className="mt-0.5 text-xs text-gray-500">
                Describe what you're looking for — AI turns it into the same filters you'd pick by hand.
              </p>
            </div>
            <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="rounded p-1 text-gray-400 hover:bg-gray-100">
              <DismissIcon fontSize={16} />
            </button>
          </div>

          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              ask(question);
            }}
          >
            <textarea
              ref={inputRef}
              rows={2}
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
              className="w-full resize-none rounded-md border border-gray-300 p-2.5 text-sm focus:border-brand-teal focus:outline-none focus:ring-1 focus:ring-brand-teal"
            />

            {notMatched && (
              <p className="mt-2 flex items-start gap-1.5 rounded-md bg-amber-50 p-2 text-xs text-amber-800">
                <ErrorIcon fontSize={14} className="mt-0.5 shrink-0" />
                {notMatched}
              </p>
            )}
            {error && (
              <p className="mt-2 flex items-start gap-1.5 rounded-md bg-accent-light p-2 text-xs text-accent-hover">
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
                  className="rounded-full border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 hover:border-brand-teal hover:text-brand-teal"
                >
                  {q}
                </button>
              ))}
            </div>

            <div className="mt-4 flex items-center justify-between">
              <span className="text-[11px] text-gray-400">
                {status ? `${status.remainingToday} of ${status.dailyLimit} searches left today` : ""}
              </span>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
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
        </Modal>
      )}
    </>
  );
}
