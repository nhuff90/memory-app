import type { AskResponse } from "../../../shared/types";
import { SparkIcon } from "./icons";

export type AnswerState =
  | { question: string; status: "loading" }
  | { question: string; status: "done"; response: AskResponse }
  | { question: string; status: "error"; message: string };

export function AnswerCard({ state, onRetry }: { state: AnswerState; onRetry: () => void }) {
  const used = state.status === "done" ? state.response.usedIds.length : 0;
  return (
    <div
      className="mt-3 rounded-2xl bg-indigo-50 p-4 ring-1 ring-indigo-100 dark:bg-indigo-950/40 dark:ring-indigo-900/60"
      aria-live="polite"
      aria-busy={state.status === "loading"}
    >
      <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-indigo-700 uppercase dark:text-indigo-300">
        <SparkIcon className="text-sm" />
        Answer
      </p>
      {state.status === "loading" && (
        <div className="mt-3 space-y-2" aria-label="Thinking">
          <div className="h-3.5 w-4/5 animate-pulse rounded-full bg-indigo-200/80 dark:bg-indigo-900" />
          <div className="h-3.5 w-1/2 animate-pulse rounded-full bg-indigo-200/80 dark:bg-indigo-900" />
        </div>
      )}
      {state.status === "done" && (
        <>
          <p className="mt-1.5 text-[17px] leading-relaxed whitespace-pre-line text-stone-900 dark:text-stone-50">
            {state.response.answer}
          </p>
          {used > 0 && (
            <p className="mt-2 text-sm text-indigo-800/70 dark:text-indigo-200/70">
              From {used === 1 ? "the note" : `${used} notes`} highlighted below.
            </p>
          )}
        </>
      )}
      {state.status === "error" && (
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <p className="text-[15px] text-red-700 dark:text-red-400">{state.message}</p>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 dark:text-indigo-300 dark:hover:bg-indigo-900/50"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
