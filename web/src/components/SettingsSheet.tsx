import { useEffect, useState } from "react";
import type { KeywordRenameResult, KeywordUsage, MeResponse, UsageSummary } from "../../../shared/types";
import { browserTimeZone, errorMessage, getMe, getUsage, logout, updateSettings } from "../api";
import { KeywordManager } from "./KeywordManager";
import { Sheet } from "./Sheet";
import { ShortcutsSetup } from "./ShortcutsSetup";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-stone-100 py-4 first:border-t-0 first:pt-1 dark:border-stone-800">
      <h3 className="mb-2 text-sm font-semibold text-stone-500 dark:text-stone-400">{title}</h3>
      {children}
    </section>
  );
}

const plural = (count: number, one: string, many: string) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

function formatCost(usd: number | null): string {
  if (usd === null) return "cost unknown for this model";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return "under 1¢";
  return `about $${usd.toFixed(2)}`;
}

function UsageLine({ usage }: { usage: UsageSummary }) {
  const month = new Date(`${usage.month}-15T12:00:00`).toLocaleDateString(undefined, { month: "long" });
  const parts = [plural(usage.asks, "question", "questions"), plural(usage.enrichments, "note tagged", "notes tagged")];
  if (usage.captions > 0) parts.push(plural(usage.captions, "photo described", "photos described"));
  return (
    <p className="mt-1 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
      {month}: {parts.join(", ")} · {formatCost(usage.estimatedCostUsd)}
    </p>
  );
}

function Switch({
  checked,
  onChange,
  disabled = false,
  labelledBy,
  describedBy,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  labelledBy: string;
  describedBy?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
        checked ? "bg-indigo-700 dark:bg-indigo-600" : "bg-stone-300 dark:bg-stone-700"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}

export function SettingsSheet({
  onClose,
  onLoggedOut,
  vocabulary,
  vocabularyError,
  onKeywordsRenamed,
}: {
  onClose: () => void;
  onLoggedOut: () => void;
  vocabulary: readonly KeywordUsage[];
  vocabularyError: string | null;
  onKeywordsRenamed: (fromKey: string, result: KeywordRenameResult) => void;
}) {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingCaptions, setSavingCaptions] = useState(false);
  const [captionsError, setCaptionsError] = useState<string | null>(null);

  useEffect(() => {
    getMe()
      .then((info) => {
        setMe(info);
        if (info.aiEnabled) return getUsage().then(setUsage);
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, []);

  async function setPhotoCaptions(photoCaptions: boolean) {
    setSavingCaptions(true);
    setCaptionsError(null);
    try {
      setMe(await updateSettings({ photoCaptions }));
    } catch (caught) {
      setCaptionsError(errorMessage(caught));
    } finally {
      setSavingCaptions(false);
    }
  }

  async function signOut() {
    try {
      await logout();
    } finally {
      onLoggedOut();
    }
  }

  return (
    <Sheet title="Settings" onClose={onClose}>
      <Section title="Your memories">
        <p className="text-[15px]">
          {me
            ? `${plural(me.counts.memories, "memory", "memories")}, ${plural(me.counts.photos, "photo", "photos")}`
            : (error ?? "Loading…")}
        </p>
      </Section>

      {me && (
        <Section title="Claude">
          {me.aiEnabled ? (
            <>
              <p className="text-[15px]">
                Ask and auto-tagging use <span className="font-medium">{me.model}</span>.
              </p>
              {usage && <UsageLine usage={usage} />}
              <p className="mt-2 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
                A question sends Claude up to 50 of your notes, the best matches first. Each new note is sent once to
                be tagged.
              </p>
              <div className="mt-4 flex items-start justify-between gap-4">
                <div>
                  <p id="captions-label" className="text-[15px] font-medium">
                    Describe photos
                  </p>
                  <p id="captions-help" className="mt-0.5 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
                    Claude writes a line about what’s in each photo, like “red toolbox on a garage shelf”, so search
                    finds photos even without a note. Each photo is sent once, including the ones you’ve already saved.
                    People are described, never named.
                  </p>
                </div>
                <Switch
                  checked={me.photoCaptions}
                  onChange={(on) => void setPhotoCaptions(on)}
                  disabled={savingCaptions}
                  labelledBy="captions-label"
                  describedBy="captions-help"
                />
              </div>
              {captionsError && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{captionsError}</p>}
            </>
          ) : (
            <p className="text-sm leading-relaxed text-stone-500 dark:text-stone-400">
              Ask and auto-tagging are off. Set <code className="text-[13px]">ANTHROPIC_API_KEY</code> on the server to
              turn them on. Search works either way.
            </p>
          )}
        </Section>
      )}

      <Section title="Keywords">
        <KeywordManager
          vocabulary={vocabulary}
          vocabularyError={vocabularyError}
          me={me}
          meError={error}
          onKeywordsRenamed={onKeywordsRenamed}
        />
      </Section>

      {me && (
        <Section title="Siri Shortcuts">
          <ShortcutsSetup aiEnabled={me.aiEnabled} />
        </Section>
      )}

      <Section title="Backup">
        <a
          href={`/api/export?tz=${encodeURIComponent(browserTimeZone())}`}
          download
          className="inline-flex rounded-full bg-stone-100 px-4 py-2.5 text-sm font-semibold text-stone-800 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700"
        >
          Export everything
        </a>
        <p className="mt-2 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
          Downloads a .zip with every memory (as JSON and as a readable Markdown file) and all photos.
        </p>
      </Section>

      <Section title="This device">
        <button
          type="button"
          onClick={() => void signOut()}
          className="rounded-full bg-stone-100 px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-red-400 dark:hover:bg-stone-700"
        >
          Log out
        </button>
      </Section>
    </Sheet>
  );
}
