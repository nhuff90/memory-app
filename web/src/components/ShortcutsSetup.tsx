import { Fragment, useCallback, useEffect, useState } from "react";
import type { ApiToken, CreatedApiToken } from "../../../shared/types";
import { createToken, errorMessage, listTokens, revokeToken } from "../api";
import { formatWhen } from "../lib/format";

function deviceName(): string {
  const agent = navigator.userAgent;
  if (/iPhone/.test(agent)) return "iPhone";
  // iPads ask for desktop sites, so they look like a Mac with a touch screen.
  if (/iPad/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Macintosh/.test(agent)) return "Mac";
  return "Siri Shortcuts";
}

function CopyButton({ text, label = "Copy", primary = false }: { text: string; label?: string; primary?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold ${
        primary
          ? "bg-indigo-700 text-white hover:bg-indigo-800"
          : "bg-stone-100 text-stone-800 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700"
      }`}
    >
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Hold the text to copy" : label}</span>
    </button>
  );
}

function CopyField({ value }: { value: string }) {
  return (
    <span className="my-1.5 flex items-center gap-2">
      <code className="min-w-0 flex-1 rounded-lg bg-stone-100 px-2.5 py-1.5 text-[13px] break-words select-all dark:bg-stone-800">
        {value.split(/(?<=\/)/).map((part, index) => (
          <Fragment key={index}>
            {part}
            <wbr />
          </Fragment>
        ))}
      </code>
      <CopyButton text={value} />
    </span>
  );
}

function Recipe({ name, prompt, url, field }: { name: string; prompt: string; url: string; field: string }) {
  return (
    <div>
      <p className="font-semibold text-stone-800 dark:text-stone-100">“{name}”</p>
      <ol className="mt-1 list-decimal space-y-1.5 pl-5">
        <li>
          In the Shortcuts app, tap <b>+</b> and name the shortcut <b>{name}</b>.
        </li>
        <li>
          Add <b>Ask for Input</b> with the prompt “{prompt}”.
        </li>
        <li>
          Add <b>Get Contents of URL</b> with this URL:
          <CopyField value={url} />
          Open its options with the <b>›</b> arrow. Set Method to <b>POST</b>. Under Headers, add <b>Authorization</b>{" "}
          and paste your key as its value. Set Request Body to <b>JSON</b>, and add a Text field named <b>{field}</b>{" "}
          set to <b>Provided Input</b>.
        </li>
        <li>
          Add <b>Get Dictionary Value</b> and get the value for the key <b>message</b>.
        </li>
        <li>
          Add <b>Show Result</b>.
        </li>
      </ol>
    </div>
  );
}

/** Keys for Siri Shortcuts, and how to build the two shortcuts that use them. */
export function ShortcutsSetup({ aiEnabled }: { aiEnabled: boolean }) {
  const [keys, setKeys] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState(deviceName);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(
    () =>
      listTokens().then(
        ({ tokens }) => setKeys(tokens),
        (caught: unknown) => setError(errorMessage(caught)),
      ),
    [],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  async function make() {
    setBusy(true);
    setError(null);
    try {
      setCreated(await createToken(name.trim() || "Siri Shortcuts"));
      await reload();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(key: ApiToken) {
    if (!window.confirm(`Remove the “${key.name}” key? Shortcuts that use it will stop working.`)) return;
    setBusy(true);
    setError(null);
    try {
      await revokeToken(key.id);
      if (created?.id === key.id) setCreated(null);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      await reload();
      setBusy(false);
    }
  }

  const origin = window.location.origin;
  const header = created ? `Bearer ${created.token}` : "";

  return (
    <>
      <p className="text-[15px] leading-relaxed">
        Save by voice with “Hey Siri, Recall”, and hear answers with “Hey Siri, Ask Recall”.
      </p>
      {!aiEnabled && (
        <p className="mt-1 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
          “Ask Recall” also needs an Anthropic API key on the server.
        </p>
      )}

      {created ? (
        <div className="mt-3 rounded-2xl bg-indigo-50 p-3 ring-1 ring-indigo-100 dark:bg-indigo-950/40 dark:ring-indigo-900">
          <p className="text-sm font-semibold text-indigo-950 dark:text-indigo-100">
            Your new key. It’s shown only this once.
          </p>
          <code className="mt-2 block rounded-lg bg-white px-2.5 py-2 text-[13px] break-all select-all dark:bg-stone-950">
            {header}
          </code>
          <div className="mt-2 flex items-center gap-2">
            <CopyButton text={header} label="Copy key" primary />
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="rounded-full px-3.5 py-1.5 text-sm font-medium text-stone-600 hover:bg-white/60 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              Done
            </button>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-indigo-950/80 dark:text-indigo-100/80">
            Paste it into both shortcuts now, following the steps below.
          </p>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void make();
          }}
          className="mt-3 flex gap-2"
        >
          <label htmlFor="key-name" className="sr-only">
            Name for the new key
          </label>
          <input
            id="key-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={60}
            placeholder="Name, like iPhone"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-full bg-stone-50 px-4 py-2 text-base ring-1 ring-stone-200 outline-none focus:ring-2 focus:ring-indigo-500 dark:bg-stone-950 dark:ring-stone-800"
          />
          <button
            type="submit"
            disabled={busy}
            className="shrink-0 rounded-full bg-indigo-700 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-800 disabled:opacity-50"
          >
            Make a key
          </button>
        </form>
      )}

      <details open={created !== null} className="mt-3">
        <summary className="cursor-pointer text-sm font-semibold text-indigo-700 dark:text-indigo-300">
          How to set up the shortcuts
        </summary>
        <div className="mt-2 space-y-4 text-sm leading-relaxed text-stone-600 dark:text-stone-300">
          <Recipe name="Recall" prompt="What should I remember?" url={`${origin}/api/capture`} field="text" />
          <Recipe name="Ask Recall" prompt="What do you want to know?" url={`${origin}/api/ask`} field="question" />
          <p>
            Then say “Hey Siri, Recall” or “Hey Siri, Ask Recall”. Siri asks what you want and reads Recall’s reply. If
            Siri mixes a name up with something else, rename that shortcut, for example to “Save to Recall”.
          </p>
        </div>
      </details>

      {keys && keys.length > 0 && (
        <ul className="mt-3 divide-y divide-stone-100 dark:divide-stone-800">
          {keys.map((key) => (
            <li key={key.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-[15px] font-medium">{key.name}</p>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Made {formatWhen(key.createdAt)} ·{" "}
                  {key.lastUsedAt === null ? "Not used yet" : `Used ${formatWhen(key.lastUsedAt)}`}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void remove(key)}
                disabled={busy}
                className="shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{error}</p>}

      <p className="mt-2 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
        Anyone with a key can save notes and ask questions, and answers can include anything you’ve saved. If a phone is
        lost, remove its key here.
      </p>
    </>
  );
}
