import { useEffect, useRef, useState } from "react";
import type { KeywordRenameResult, KeywordUsage, MeResponse, UsageSummary } from "../../../shared/types";
import { browserTimeZone, errorMessage, getMe, getUsage, logout, readSavedPhotoText, updateSettings } from "../api";
import { photoTextStatus } from "../lib/photoText";
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

/** How often the sheet asks the server how many saved photos are left while their text is being read. */
const PHOTO_TEXT_REFRESH_MS = 10_000;

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
  const [sendingReadSaved, setSendingReadSaved] = useState(false);
  const [readSavedError, setReadSavedError] = useState<string | null>(null);
  /** Set once saved photos were being read while this sheet was open, so reaching 0 can say it's done. */
  const [readThisSession, setReadThisSession] = useState(false);
  /** Guards against a second tap before the disabled button re-renders. */
  const readSavedInFlight = useRef(false);
  const online = useOnline();

  const photoText = photoTextStatus(me);
  const readingSaved = photoText?.reading === true;

  useEffect(() => {
    getMe()
      .then((info) => {
        setMe(info);
        if (info.aiEnabled) return getUsage().then(setUsage);
      })
      .catch((caught: unknown) => setError(errorMessage(caught)));
  }, []);

  // While saved photos are being read, refresh the count every 10 seconds. The sheet is only mounted while open, so
  // the interval stops when it closes (unmount), when Describe photos is turned off, or when nothing is left.
  useEffect(() => {
    if (!readingSaved) return;
    setReadThisSession(true);
    let active = true;
    const timer = window.setInterval(() => {
      getMe()
        .then((info) => {
          if (active) setMe(info);
        })
        .catch(() => {
          // Keep the last count; the next refresh tries again.
        });
    }, PHOTO_TEXT_REFRESH_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [readingSaved]);

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

  async function readSavedPhotos() {
    if (readSavedInFlight.current) return;
    readSavedInFlight.current = true;
    setSendingReadSaved(true);
    setReadSavedError(null);
    try {
      setMe(await readSavedPhotoText());
      setReadThisSession(true);
    } catch (caught) {
      setReadSavedError(errorMessage(caught));
    } finally {
      readSavedInFlight.current = false;
      setSendingReadSaved(false);
    }
  }

  let photoTextLine: string | null = null;
  if (photoText?.reading) photoTextLine = `Reading text in saved photos: ${photoText.unread.toLocaleString()} left.`;
  else if (photoText?.paused) photoTextLine = "Reading text in saved photos is paused while Describe photos is off.";
  else if (photoText?.requested && photoText.unread === 0 && readThisSession) photoTextLine = "Text read in all saved photos.";

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
                    Claude writes a line about what’s in each photo, like “red toolbox on a garage shelf”, and copies
                    out any text in it, like a recipe card or a sign, so search finds photos even without a note. Each
                    photo is sent once, including the ones you’ve already saved. People are described, never named.
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
              {photoText && (
                <>
                  {!photoText.requested && me.photoCaptions && photoText.unread > 0 && (
                    <div className="mt-4">
                      <p className="text-[15px]">
                        {plural(photoText.unread, "photo", "photos")} {photoText.unread === 1 ? "was" : "were"} described
                        before Recall could read the text in {photoText.unread === 1 ? "it" : "them"}.
                      </p>
                      <button
                        type="button"
                        onClick={() => void readSavedPhotos()}
                        disabled={sendingReadSaved || !online}
                        aria-describedby={online ? "read-saved-help" : "read-saved-help read-saved-offline"}
                        className="mt-2 inline-flex min-h-11 items-center rounded-full bg-stone-100 px-4 text-sm font-semibold text-stone-800 hover:bg-stone-200 disabled:opacity-50 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700"
                      >
                        Read text in {plural(photoText.unread, "photo", "photos")}
                      </button>
                      <p id="read-saved-help" className="mt-1 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
                        Each one is sent to Claude once more.
                      </p>
                      {!online && (
                        <p id="read-saved-offline" className="mt-1 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
                          You’re offline.
                        </p>
                      )}
                      {readSavedError && <p className="mt-2 text-sm text-red-700 dark:text-red-400">{readSavedError}</p>}
                    </div>
                  )}
                  <div aria-live="polite">
                    {photoTextLine && (
                      <p className="mt-4 text-sm leading-relaxed text-stone-500 dark:text-stone-400">{photoTextLine}</p>
                    )}
                  </div>
                </>
              )}
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
