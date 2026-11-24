import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from "react";
import type { KeywordRenameResult, KeywordUsage, MeResponse } from "../../../shared/types";
import { errorMessage, renameKeyword } from "../api";
import { planKeywordRename, supportsKeywordRename, type KeywordRenamePlan } from "../lib/keywords";

const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

const MUTED = "text-sm leading-relaxed text-stone-500 dark:text-stone-400";
const ERROR = "text-sm leading-relaxed text-red-700 dark:text-red-400";
const PRIMARY_BUTTON =
  "min-h-11 min-w-11 rounded-full bg-indigo-700 px-4 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50 dark:bg-indigo-600 dark:hover:bg-indigo-500";
const SECONDARY_BUTTON =
  "min-h-11 min-w-11 rounded-full bg-stone-100 px-4 text-sm font-semibold text-stone-800 hover:bg-stone-200 disabled:opacity-50 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700";

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function usageLabel(entry: KeywordUsage): string {
  return entry.count > 0 ? plural(entry.count, "memory", "memories") : "Only on outdated memories";
}

/** Whether the browser believes it is online, following `online`/`offline` events. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    update();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

/** The `planKeywordRename` result as a sentence shown under the input. */
function planText(from: KeywordUsage, plan: KeywordRenamePlan): string {
  switch (plan.kind) {
    case "invalid":
      return plan.message;
    case "unchanged":
      return "Type a new spelling or a different keyword.";
    case "respell":
      return `Changes the spelling of “${from.keyword}” to “${plan.to}” everywhere it’s used.`;
    case "rename":
      return `Renames “${from.keyword}” to “${plan.to}” everywhere it’s used.`;
    case "merge": {
      const spelling = plan.to === plan.target.keyword ? "" : `, spelled “${plan.to}”`;
      return `“${plan.target.keyword}” already exists (${usageLabel(plan.target).toLowerCase()}). Saving merges “${from.keyword}” into it${spelling}.`;
    }
  }
}

/** The status line after a successful rename, reporting the server's `affected` count. */
function resultText(from: KeywordUsage, result: KeywordRenameResult): string {
  const changed = `${plural(result.affected, "memory", "memories")} changed.`;
  switch (result.status) {
    case "renamed":
      return `Renamed “${from.keyword}” to “${result.keyword}”. ${changed}`;
    case "merged":
      return `Merged “${from.keyword}” into “${result.keyword}”. ${changed}`;
    case "respelled":
      return `Respelled “${from.keyword}” as “${result.keyword}”. ${changed}`;
    case "unchanged":
      return `“${result.keyword}” was already spelled that way. ${changed}`;
  }
}

function RenameForm({
  entry,
  vocabulary,
  inFlight,
  onSendingChange,
  onCancel,
  onRenamed,
}: {
  entry: KeywordUsage;
  vocabulary: readonly KeywordUsage[];
  /**
   * Owned by KeywordManager, not by this form, so the guard survives this form being closed and reopened: at most
   * one rename is in flight for the whole section (double tap, Enter + click, reopening a row).
   */
  inFlight: RefObject<boolean>;
  /** Tells KeywordManager to lock the other rows, so this form cannot be replaced while its request is pending. */
  onSendingChange: (sending: boolean) => void;
  onCancel: () => void;
  onRenamed: (entry: KeywordUsage, result: KeywordRenameResult) => void;
}) {
  const inputId = useId();
  const planId = useId();
  const [text, setText] = useState(entry.keyword);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const backButton = useRef<HTMLButtonElement>(null);
  const online = useOnline();

  const plan = planKeywordRename(vocabulary, entry, text);
  const valid = plan.kind === "rename" || plan.kind === "respell" || plan.kind === "merge";
  const canSave = valid && online && !sending;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  useEffect(() => {
    if (confirming) backButton.current?.focus();
  }, [confirming]);

  // If the plan stops being a merge (vocabulary refreshed), drop a pending confirmation for it.
  useEffect(() => {
    if (plan.kind !== "merge") setConfirming(false);
  }, [plan.kind]);

  async function send(to: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    onSendingChange(true);
    setError(null);
    let result: KeywordRenameResult;
    try {
      result = await renameKeyword(entry.keyword, to);
    } catch (caught) {
      // The text stays as typed and the list is untouched, so the user can retry or cancel.
      setError(errorMessage(caught));
      setConfirming(false);
      setSending(false);
      return;
    } finally {
      inFlight.current = false;
      onSendingChange(false);
    }
    onRenamed(entry, result);
  }

  function save() {
    if (!canSave || inFlight.current) return;
    if (plan.kind === "merge" && !confirming) {
      // Nothing is sent until the merge is confirmed.
      setConfirming(true);
      return;
    }
    void send(plan.to);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    // Enter saves only when the plan is valid (and never while confirming: that needs the explicit Merge button).
    if (!confirming) save();
  }

  function keyDown(event: KeyboardEvent) {
    if (event.key !== "Escape") return;
    // Close only this form, not the Settings sheet. While sending, the result must still arrive here.
    event.preventDefault();
    event.stopPropagation();
    if (!inFlight.current) onCancel();
  }

  const mergeTarget = plan.kind === "merge" ? plan.target : null;

  return (
    <form onSubmit={submit} onKeyDown={keyDown} aria-busy={sending} className="space-y-2 rounded-2xl bg-stone-50 p-3 dark:bg-stone-800/60">
      <label htmlFor={inputId} className="block text-sm font-medium">
        Rename “{entry.keyword}”
      </label>
      <input
        ref={input}
        id={inputId}
        type="text"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
        }}
        disabled={sending || confirming}
        aria-invalid={plan.kind === "invalid"}
        aria-describedby={planId}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="done"
        className="min-h-11 w-full rounded-xl bg-white px-3 text-base ring-1 ring-stone-200 outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60 dark:bg-stone-900 dark:ring-stone-700"
      />
      <p id={planId} aria-live="polite" className={plan.kind === "invalid" ? ERROR : MUTED}>
        {planText(entry, plan)}
      </p>

      {confirming && mergeTarget && plan.kind === "merge" ? (
        <div role="group" aria-labelledby={`${planId}-confirm`} className="rounded-xl bg-amber-50 p-3 dark:bg-amber-950/40">
          <p id={`${planId}-confirm`} className="text-sm leading-relaxed text-amber-900 dark:text-amber-100">
            Merge “{entry.keyword}” into “{mergeTarget.keyword}”? Every memory with “{entry.keyword}” will have “{plan.to}”
            instead, and outdated memories change too. This can’t be undone.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void send(plan.to)} disabled={!canSave} className={PRIMARY_BUTTON}>
              {sending ? "Merging…" : "Merge"}
            </button>
            <button
              ref={backButton}
              type="button"
              onClick={() => {
                setConfirming(false);
                requestAnimationFrame(() => input.current?.focus());
              }}
              disabled={sending}
              className={SECONDARY_BUTTON}
            >
              Back
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={!canSave} className={PRIMARY_BUTTON}>
            {sending ? "Saving…" : "Save"}
          </button>
          <button type="button" onClick={onCancel} disabled={sending} className={SECONDARY_BUTTON}>
            Cancel
          </button>
        </div>
      )}

      {!online && <p className={MUTED}>You’re offline. Renaming needs a connection to Recall.</p>}
      {error && (
        <p role="alert" className={ERROR}>
          {error}
        </p>
      )}
    </form>
  );
}

/**
 * Settings: every custom keyword with its usage, renamed or merged one at a time. The rules live in
 * `planKeywordRename` (preview), `supportsKeywordRename` (server capability) and `renameKeyword` (request);
 * `onKeywordsRenamed` lets the app refetch the vocabulary and lists and update the Recall keyword filter.
 */
export function KeywordManager({
  vocabulary,
  vocabularyError,
  me,
  meError,
  onKeywordsRenamed,
}: {
  vocabulary: readonly KeywordUsage[];
  vocabularyError: string | null;
  /** The `/api/me` response Settings already loads; null while loading or after a failure. */
  me: MeResponse | null;
  meError: string | null;
  onKeywordsRenamed: (fromKey: string, result: KeywordRenameResult) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // One rename at a time for the whole section. The ref is the synchronous guard; the state locks the other rows,
  // so the pending form (and, on failure, its text and error) cannot be replaced or reopened while it is sending.
  const inFlight = useRef(false);
  const [sending, setSending] = useState(false);
  const canRename = supportsKeywordRename(me);

  if (vocabulary.length === 0) {
    return vocabularyError ? (
      <p className={ERROR}>Couldn’t load your keywords. {vocabularyError}</p>
    ) : (
      <p className={MUTED}>No keywords yet. Keywords you add to memories show up here.</p>
    );
  }

  const sorted = [...vocabulary].sort((a, b) => compareText(a.key, b.key) || compareText(a.keyword, b.keyword));

  function renamed(entry: KeywordUsage, result: KeywordRenameResult) {
    const id = entry.key || entry.keyword;
    // Close only the form that sent this rename, never a different one opened since.
    setEditing((current) => (current === id ? null : current));
    setStatus(resultText(entry, result));
    onKeywordsRenamed(entry.key, result);
  }

  return (
    <div>
      {me && !canRename ? (
        <p className={`mb-2 ${MUTED}`}>Renaming keywords needs an updated Recall server. Your keywords are shown read-only.</p>
      ) : !me && meError ? (
        <p className={`mb-2 ${MUTED}`}>Couldn’t check whether Recall can rename keywords, so they’re shown read-only.</p>
      ) : (
        canRename && <p className={`mb-2 ${MUTED}`}>Tap a keyword to rename it, or to merge it into another one.</p>
      )}
      {vocabularyError && <p className={`mb-2 ${MUTED}`}>Showing saved keywords. Couldn’t refresh: {vocabularyError}</p>}
      {status && (
        <p role="status" className="mb-2 text-sm leading-relaxed text-emerald-700 dark:text-emerald-400">
          {status}
        </p>
      )}
      <ul className="divide-y divide-stone-100 dark:divide-stone-800">
        {sorted.map((entry) => {
          const id = entry.key || entry.keyword;
          const count = usageLabel(entry);
          return (
            <li key={id} className="py-1">
              {canRename && editing === id ? (
                <RenameForm
                  entry={entry}
                  vocabulary={vocabulary}
                  inFlight={inFlight}
                  onSendingChange={setSending}
                  onCancel={() => {
                    if (!inFlight.current) setEditing(null);
                  }}
                  onRenamed={renamed}
                />
              ) : canRename ? (
                <button
                  type="button"
                  disabled={sending}
                  onClick={() => {
                    // While a rename is pending, its form must stay open: switching rows would drop its result.
                    if (inFlight.current) return;
                    setEditing(id);
                    setStatus(null);
                  }}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-2 text-left hover:bg-stone-100 disabled:opacity-50 dark:hover:bg-stone-800"
                >
                  <span className="min-w-0 truncate text-[15px] font-medium">{entry.keyword}</span>
                  <span className={`shrink-0 ${MUTED}`}>{count}</span>
                </button>
              ) : (
                <div className="flex min-h-11 items-center justify-between gap-3 px-2">
                  <span className="min-w-0 truncate text-[15px] font-medium">{entry.keyword}</span>
                  <span className={`shrink-0 ${MUTED}`}>{count}</span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
