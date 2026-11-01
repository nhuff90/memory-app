import { useEffect, useState } from "react";
import type { OutboxItem } from "../lib/outbox";

function PendingCard({
  item,
  onEdit,
  onDiscard,
}: {
  item: OutboxItem;
  onEdit: (item: OutboxItem) => void;
  onDiscard: (item: OutboxItem) => void;
}) {
  const [thumbs, setThumbs] = useState<string[]>([]);

  useEffect(() => {
    const urls = item.photos.slice(0, 4).map((photo) => URL.createObjectURL(photo.thumb));
    setThumbs(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [item.photos]);

  return (
    <li
      className={`rounded-2xl bg-white p-4 shadow-sm dark:bg-stone-900 ${
        item.error ? "ring-1 ring-red-300 dark:ring-red-900" : "border border-dashed border-stone-300 dark:border-stone-700"
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
      {item.error ? (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-red-700 dark:text-red-400">Not saved: {item.error}</p>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => onEdit(item)}
              className="rounded-full px-3 py-1.5 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 dark:text-indigo-300 dark:hover:bg-stone-800"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => onDiscard(item)}
              className="rounded-full px-3 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
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
}: {
  items: OutboxItem[];
  onEdit: (item: OutboxItem) => void;
  onDiscard: (item: OutboxItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <>
      <h2 className="mt-3 mb-2 px-1 text-sm font-semibold text-stone-500 dark:text-stone-400">Waiting to upload</h2>
      <ul className="mb-4 space-y-2.5">
        {[...items].reverse().map((item) => (
          <PendingCard key={item.clientId} item={item} onEdit={onEdit} onDiscard={onDiscard} />
        ))}
      </ul>
    </>
  );
}
