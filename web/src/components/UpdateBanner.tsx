import { useRegisterSW } from "virtual:pwa-register/react";
import { CloseIcon } from "./icons";

const CHECK_EVERY_MS = 60 * 60 * 1000;

/** Offers to reload when a new version has been deployed, instead of swapping code under the user. */
export function UpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => void registration.update(), CHECK_EVERY_MS);
    },
  });

  if (!needRefresh) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
      <div className="mx-auto flex max-w-xl items-center gap-3 rounded-2xl bg-stone-900 py-2.5 pr-2 pl-4 text-white shadow-lg dark:bg-stone-100 dark:text-stone-900">
        <p className="flex-1 text-sm">A new version of Recall is ready.</p>
        <button
          type="button"
          onClick={() => void updateServiceWorker(true)}
          className="rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-stone-900 dark:bg-stone-900 dark:text-white"
        >
          Reload
        </button>
        <button type="button" onClick={() => setNeedRefresh(false)} className="rounded-full p-2" aria-label="Not now">
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
