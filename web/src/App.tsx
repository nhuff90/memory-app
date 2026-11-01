import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { MeResponse, Memory } from "../../shared/types";
import { ApiError, getMe, onUnauthorized } from "./api";
import { GearIcon } from "./components/icons";
import { Login } from "./components/Login";
import { MemorySheet } from "./components/MemorySheet";
import { RecallTab } from "./components/RecallTab";
import { RememberTab } from "./components/RememberTab";
import { SettingsSheet } from "./components/SettingsSheet";
import { UpdateBanner } from "./components/UpdateBanner";
import { useOutboxSync } from "./lib/outbox";

type Tab = "remember" | "recall";
type Auth = "checking" | "in" | "out";

const TAB_KEY = "recall:tab";
const TABS: { id: Tab; label: string }[] = [
  { id: "remember", label: "Remember" },
  { id: "recall", label: "Recall" },
];

export default function App() {
  const [auth, setAuth] = useState<Auth>("checking");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [tab, setTab] = useState<Tab>(() => (localStorage.getItem(TAB_KEY) === "recall" ? "recall" : "remember"));
  const [refreshKey, setRefreshKey] = useState(0);
  const [openMemory, setOpenMemory] = useState<Memory | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rememberInput = useRef<HTMLTextAreaElement>(null);
  const recallInput = useRef<HTMLInputElement>(null);

  const checkSession = useCallback(() => {
    getMe()
      .then((info) => {
        setMe(info);
        setAuth("in");
      })
      .catch((error: unknown) => {
        // Offline is not logged out: show the app so saved drafts and cached screens still work.
        setAuth(error instanceof ApiError && error.status === 401 ? "out" : "in");
      });
  }, []);

  useEffect(() => {
    onUnauthorized(() => {
      setAuth("out");
      setOpenMemory(null);
      setSettingsOpen(false);
    });
    checkSession();
  }, [checkSession]);

  useEffect(() => {
    if (auth !== "in") return;
    (localStorage.getItem(TAB_KEY) === "recall" ? recallInput : rememberInput).current?.focus({ preventScroll: true });
  }, [auth]);

  const changed = useCallback(() => setRefreshKey((key) => key + 1), []);
  useOutboxSync(auth === "in", changed);
  const closeMemory = useCallback(() => setOpenMemory(null), []);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  function switchTab(next: Tab) {
    // Render synchronously so focusing the input stays inside the tap, which iOS requires to open the keyboard.
    flushSync(() => setTab(next));
    localStorage.setItem(TAB_KEY, next);
    (next === "remember" ? rememberInput : recallInput).current?.focus();
  }

  if (auth === "checking") return null;
  if (auth === "out") {
    return (
      <Login
        onLoggedIn={() => {
          setAuth("in");
          checkSession();
          changed();
        }}
      />
    );
  }

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-stone-200/80 bg-stone-100/90 pt-[env(safe-area-inset-top)] backdrop-blur dark:border-stone-800/80 dark:bg-stone-950/90">
        <div className="mx-auto flex max-w-xl items-center gap-2 px-4 py-2.5">
          <nav role="tablist" aria-label="Sections" className="flex flex-1 rounded-full bg-stone-200/80 p-1 dark:bg-stone-800/80">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => switchTab(id)}
                className={`flex-1 rounded-full py-1.5 text-sm font-semibold transition ${
                  tab === id
                    ? "bg-white text-indigo-700 shadow-sm dark:bg-stone-700 dark:text-white"
                    : "text-stone-600 dark:text-stone-400"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="rounded-full p-2 text-xl text-stone-600 hover:bg-stone-200 dark:text-stone-300 dark:hover:bg-stone-800"
            aria-label="Settings"
          >
            <GearIcon />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-xl px-4 pb-[calc(env(safe-area-inset-bottom)+2rem)]">
        <div hidden={tab !== "remember"}>
          <RememberTab inputRef={rememberInput} refreshKey={refreshKey} onOpen={setOpenMemory} onChanged={changed} />
        </div>
        <div hidden={tab !== "recall"}>
          <RecallTab
            inputRef={recallInput}
            refreshKey={refreshKey}
            aiEnabled={me?.aiEnabled ?? false}
            onOpen={setOpenMemory}
          />
        </div>
      </main>

      {openMemory && (
        <MemorySheet
          key={openMemory.id}
          memory={openMemory}
          onClose={closeMemory}
          onChanged={changed}
          onDeleted={() => {
            setOpenMemory(null);
            changed();
          }}
        />
      )}
      {settingsOpen && <SettingsSheet onClose={closeSettings} onLoggedOut={() => setAuth("out")} />}
      <UpdateBanner />
    </div>
  );
}
