import { useEffect, useRef, type ReactNode } from "react";
import { CloseIcon } from "./icons";

/** A panel that slides up from the bottom on phones and sits centered on wider screens. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panel.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-30 flex items-end justify-center bg-black/40 sm:items-center sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="max-h-[92dvh] w-full max-w-xl overflow-y-auto overscroll-contain rounded-t-3xl bg-white px-4 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] shadow-xl outline-none sm:rounded-3xl dark:bg-stone-900"
      >
        {/* The top padding lives here: sticky headers stop at the scroller's padding, letting text show above. */}
        <div className="sticky top-0 z-10 -mx-4 mb-2 flex items-center justify-between bg-white/95 px-4 pt-4 pb-1 backdrop-blur dark:bg-stone-900/95">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="-mr-2 rounded-full p-2 text-xl text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
            aria-label="Close"
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
