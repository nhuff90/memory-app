import { useEffect, useState } from "react";
import { canEditHeld, type OutboxItem, type Resolution } from "../lib/outbox";

const action =
  "min-h-11 rounded-full px-3 py-1.5 text-sm font-semibold hover:bg-indigo-50 disabled:opacity-50 dark:hover:bg-stone-800";

function PendingCard({
  item,
  onEdit,
  onDiscard,
  onRecover,
}: {
  item: OutboxItem;
  onEdit: (item: OutboxItem) => void;
  onDiscard: (item: OutboxItem) => void;
  onRecover: (item: OutboxItem, resolution?: Resolution) => Promise<void>;
}) {
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [recovering, setRecovering] = useState(false);
  const keywords = item.customKeywords ?? [];
  const conflict = item.held?.reason === "conflict" ? item.held.conflict : undefined;

  useEffect(() => {
    const urls = item.photos.slice(0, 4).map((photo) => URL.createObjectURL(photo.thumb));
    setThumbs(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [item.photos]);

  const recover = async (resolution?: Resolution) => {
    setRecovering(true);
    try {
      await onRecover(item, resolution);
    } finally {
      setRecovering(false);
    }
  };

  return (
    <li
      aria-label={item.held ? "Needs reconciliation" : item.error ? "Not saved" : "Waiting to upload"}
      className={`rounded-2xl bg-white p-4 shadow-sm dark:bg-stone-900 ${
        item.held
          ? "ring-1 ring-amber-400 dark:ring-amber-700"
          : item.error
            ? "ring-1 ring-red-300 dark:ring-red-900"
            : "border border-dashed border-stone-300 dark:border-stone-700"
      }`}
    >
      {item.body && <p className="line-clamp-3 text-[15px] leading-relaxed whitespace-pre-line">{item.body}</p>}
      {thumbs.length > 0 && (
        <div className="mt-2 flex gap-2">
          {thumbs.map((url) => (
            <img key={url} src={url} alt="" className="h-16 w-16 rounded-lg object-cover" />
          ))}
        </div>
      )}
      {keywords.length > 0 && (
        <ul aria-label="Keywords" className="mt-2 flex flex-wrap gap-1.5">
          {keywords.map((keyword) => (
            <li key={keyword} className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200">
              {keyword}
            </li>
          ))}
        </ul>
      )}
      {item.held ? (
        <div className="mt-2">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Needs reconciliation</p>
          <p className="text-sm text-amber-800 dark:text-amber-300">{item.held.message}</p>
          {conflict && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 text-sm text-stone-700 dark:text-stone-300">
              <dt className="font-semibold">Recall has</dt>
              <dd>{conflict.keywords.length ? conflict.keywords.join(", ") : "no keywords"}</dd>
              <dt className="font-semibold">Missing</dt>
              <dd>{conflict.missing.join(", ")}</dd>
            </dl>
          )}
          <div className="mt-1 flex flex-wrap justify-end gap-1">
            {conflict ? (
              <>
                <button type="button" onClick={() => void recover("add")} disabled={recovering} className={`${action} text-indigo-700 dark:text-indigo-300`}>
                  {recovering ? "Checking…" : "Add missing keywords"}
                </button>
                <button type="button" onClick={() => void recover("keep")} disabled={recovering} className={`${action} text-indigo-700 dark:text-indigo-300`}>
                  Keep Recall's version
                </button>
              </>
            ) : (
              <button type="button" onClick={() => void recover()} disabled={recovering} className={`${action} text-indigo-700 dark:text-indigo-300`}>
                {recovering ? "Checking…" : item.held.reason === "unsupported" ? "Try again" : "Recover keywords"}
              </button>
            )}
            {canEditHeld(item) && (
              <button type="button" onClick={() => onEdit(item)} disabled={recovering} className={`${action} text-indigo-700 dark:text-indigo-300`}>
                Edit
              </button>
            )}
            <button type="button" onClick={() => onDiscard(item)} disabled={recovering} className={`${action} text-red-700 dark:text-red-400`}>
              Discard
            </button>
          </div>
        </div>
      ) : item.error ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-red-700 dark:text-red-400">Not saved: {item.error}</p>
          <div className="flex gap-1">
            <button type="button" onClick={() => onEdit(item)} className={`${action} text-indigo-700 dark:text-indigo-300`}>
              Edit
            </button>
            <button type="button" onClick={() => onDiscard(item)} className={`${action} text-red-700 dark:text-red-400`}>
              Discard
            </button>
          </div>
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">On this phone · uploads when you're online</p>
      )}
    </li>
  );
}

export function PendingList({
  items,
  onEdit,
  onDiscard,
  onRecover,
}: {
  items: OutboxItem[];
  onEdit: (item: OutboxItem) => void;
  onDiscard: (item: OutboxItem) => void;
  onRecover: (item: OutboxItem, resolution?: Resolution) => Promise<void>;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <h2 className="mt-3 mb-2 px-1 text-sm font-semibold text-stone-500 dark:text-stone-400">Waiting to upload</h2>
      <ul className="mb-4 space-y-2.5">
        {[...items].reverse().map((item) => (
          <PendingCard key={item.clientId} item={item} onEdit={onEdit} onDiscard={onDiscard} onRecover={onRecover} />
        ))}
      </ul>
    </>
  );
}
