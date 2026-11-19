import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { keywordKey, MAX_CUSTOM_KEYWORD_LENGTH, MAX_CUSTOM_KEYWORDS } from "../../../shared/keywords";
import type { KeywordUsage } from "../../../shared/types";
import { applyKeywordInput, pendingKeywordError, suggestKeywords, type PillInput } from "../lib/keywords";
import { CloseIcon } from "./icons";

type Option = { kind: "existing"; keyword: string; count: number } | { kind: "create"; keyword: string };

/**
 * Removable keyword pills with a text input, matching suggestions and an explicit "Create" option. The same
 * control is used in Remember and the recall editor. Enter accepts the highlighted option or creates the typed
 * keyword and never submits the surrounding form. Invalid text stays in the input with its explanation.
 */
export function KeywordPills({
  id,
  label,
  value,
  onChange,
  vocabulary,
  vocabularyError = null,
  disabled = false,
}: {
  id: string;
  label: string;
  value: PillInput;
  onChange: (next: PillInput) => void;
  vocabulary: readonly KeywordUsage[];
  vocabularyError?: string | null;
  disabled?: boolean;
}) {
  const { keywords, input } = value;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);
  const uid = useId();
  const listId = `${uid}-list`;
  const helpId = `${uid}-help`;
  const errorId = `${uid}-error`;
  const error = pendingKeywordError(keywords, input);
  const typed = input.split(",").at(-1)?.trim() ?? "";

  const options = useMemo((): Option[] => {
    const suggestions = suggestKeywords(vocabulary, input, keywords);
    const list: Option[] = suggestions.map((entry) => ({ kind: "existing", keyword: entry.keyword, count: entry.count }));
    const key = keywordKey(typed);
    const selected = keywords.some((keyword) => keywordKey(keyword) === key);
    if (key && !selected && !suggestions.some((entry) => entry.key === key)) list.push({ kind: "create", keyword: typed });
    return list;
  }, [vocabulary, input, keywords, typed]);
  const showList = open && !disabled && options.length > 0;
  const alreadyAdded = typed && keywords.some((keyword) => keywordKey(keyword) === keywordKey(typed));

  function update(next: PillInput) {
    setActive(-1);
    onChange(next);
  }

  function choose(option: Option) {
    // Replace the unfinished tail with the chosen keyword; earlier complete parts are applied as usual.
    const head = input.includes(",") ? input.slice(0, input.lastIndexOf(",") + 1) : "";
    const applied = applyKeywordInput(keywords, `${head}${option.keyword}`, true);
    update(applied);
    setOpen(true);
    inputRef.current?.focus();
  }

  function remove(keyword: string) {
    update({ keywords: keywords.filter((entry) => entry !== keyword), input });
    inputRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + options.length + (current < 0 && step < 0 ? 1 : 0)) % options.length);
    } else if (event.key === "Enter") {
      // Never submit the recall form from the keyword input.
      event.preventDefault();
      if (showList && active >= 0 && options[active]) choose(options[active]!);
      else if (input.trim()) update(applyKeywordInput(keywords, input, true));
    } else if (event.key === "Escape" && showList) {
      // Close the suggestions first; a second Escape reaches the sheet.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      setActive(-1);
    } else if (event.key === "Tab") {
      setOpen(false);
    }
  }

  const atLimit = keywords.length >= MAX_CUSTOM_KEYWORDS;

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <div
        className={`mt-1 flex flex-wrap items-center gap-1.5 rounded-xl bg-stone-50 px-2 py-1.5 ring-1 focus-within:ring-2 dark:bg-stone-950 ${
          error ? "ring-red-500 focus-within:ring-red-500" : "ring-stone-200 focus-within:ring-indigo-500 dark:ring-stone-800"
        }`}
      >
        {keywords.length > 0 && (
          <ul aria-label={`${label} added`} className="contents">
            {keywords.map((keyword) => (
              <li
                key={keyword}
                className="inline-flex min-h-11 items-center rounded-full bg-indigo-100 pl-3 text-sm font-medium text-indigo-900 dark:bg-indigo-900/50 dark:text-indigo-100"
              >
                <span className="max-w-[14rem] truncate">{keyword}</span>
                <button
                  type="button"
                  onClick={() => remove(keyword)}
                  disabled={disabled}
                  aria-label={`Remove keyword ${keyword}`}
                  className="flex h-11 w-11 items-center justify-center rounded-full text-indigo-700 hover:bg-indigo-200 disabled:opacity-50 dark:text-indigo-200 dark:hover:bg-indigo-800"
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listId}
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
          aria-invalid={error !== null}
          aria-describedby={`${helpId}${error ? ` ${errorId}` : ""}`}
          value={input}
          disabled={disabled}
          autoComplete="off"
          autoCapitalize="words"
          enterKeyHint="enter"
          placeholder={keywords.length ? "Add another…" : "Add a keyword…"}
          onChange={(event) => {
            update(applyKeywordInput(keywords, event.target.value));
            setOpen(true);
          }}
          onFocus={() => {
            window.clearTimeout(closeTimer.current);
            setOpen(true);
          }}
          onBlur={() => {
            // Close a moment later, so a tap on Save (which the list pushes down) lands before the layout moves.
            closeTimer.current = window.setTimeout(() => {
              setOpen(false);
              setActive(-1);
            }, 250);
          }}
          onKeyDown={onKeyDown}
          className="min-h-11 min-w-[8rem] flex-1 bg-transparent px-1 text-base outline-none placeholder:text-stone-400"
        />
      </div>
      {showList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Keyword suggestions"
          // In the page flow, not an overlay: it must never cover Save or other controls on a phone.
          className="mt-1 overflow-hidden rounded-xl bg-white py-1 shadow-sm ring-1 ring-stone-200 dark:bg-stone-900 dark:ring-stone-700"
        >
          {options.map((option, index) => (
            <li
              key={`${option.kind}-${option.keyword}`}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              // Keep focus in the input so the list stays open and typing continues.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
              className={`flex min-h-11 cursor-pointer items-center justify-between gap-3 px-3 text-sm ${
                index === active ? "bg-indigo-50 dark:bg-stone-800" : ""
              }`}
            >
              {option.kind === "create" ? (
                <span>
                  Create “<span className="font-semibold">{option.keyword}</span>”
                </span>
              ) : (
                <>
                  <span className="font-medium">{option.keyword}</span>
                  {option.count > 0 && <span className="text-xs text-stone-500">{option.count}</span>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <p id={helpId} className="mt-1 text-xs text-stone-500">
        Press Enter or type a comma to add. Up to {MAX_CUSTOM_KEYWORDS} keywords, {MAX_CUSTOM_KEYWORD_LENGTH} characters each.
        Separate from automatic tags.
        {atLimit && " You've reached the limit."}
        {alreadyAdded && " Already added."}
        {vocabularyError && vocabulary.length === 0 && " Suggestions aren't available right now; you can still type keywords."}
      </p>
      {error && (
        <p id={errorId} role="alert" className="mt-1 text-sm text-red-700 dark:text-red-400">
          {error} Fix or remove “{input.trim()}” to save.
        </p>
      )}
    </div>
  );
}
