import { highlightParts } from "../lib/format";

export function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  return (
    <>
      {highlightParts(text, query).map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-sm bg-amber-200/80 text-inherit dark:bg-amber-400/30">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
