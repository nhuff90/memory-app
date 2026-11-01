import { useEffect, useState } from "react";
import { photoUrl, type Memory } from "../../../shared/types";
import { errorMessage, listMemories } from "../api";
import { buildRound, loadProgress, practiceCards, recordAnswer, saveProgress, type PracticeCard } from "../lib/practice";
import { Sheet } from "./Sheet";

const MAX_PEOPLE = 500;

async function loadPeople(): Promise<Memory[]> {
  const people: Memory[] = [];
  let cursor: string | null = null;
  do {
    const page = await listMemories({ category: "people", photos: true, limit: 100, cursor });
    people.push(...page.memories);
    cursor = page.nextCursor;
  } while (cursor && people.length < MAX_PEOPLE);
  return people;
}

interface Round {
  /** The round's people, then anyone missed, who comes back once at the end. */
  queue: PracticeCard[];
  size: number;
  position: number;
  known: number;
  missed: number;
}

function newRound(cards: PracticeCard[]): Round {
  const queue = buildRound(cards, loadProgress(localStorage), Date.now());
  return { queue, size: queue.length, position: 0, known: 0, missed: 0 };
}

/** "Who's this?": flash cards from People photos, missed faces first next time. */
export function PracticeSheet({ onClose }: { onClose: () => void }) {
  const [cards, setCards] = useState<PracticeCard[] | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPeople().then(
      (people) => {
        if (cancelled) return;
        const loaded = practiceCards(people);
        setCards(loaded);
        setRound(newRound(loaded));
      },
      (caught: unknown) => {
        if (!cancelled) setError(errorMessage(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const card = round?.queue[round.position];
  const upNext = round?.queue[round.position + 1];

  useEffect(() => {
    if (upNext) new Image().src = photoUrl(upNext.photoId);
  }, [upNext]);

  function answer(knewIt: boolean) {
    if (!round || !card) return;
    const firstTry = round.position < round.size;
    if (firstTry) saveProgress(localStorage, recordAnswer(loadProgress(localStorage), card.memoryId, knewIt, Date.now()));
    setRound({
      ...round,
      queue: firstTry && !knewIt ? [...round.queue, card] : round.queue,
      position: round.position + 1,
      known: round.known + (firstTry && knewIt ? 1 : 0),
      missed: round.missed + (firstTry && !knewIt ? 1 : 0),
    });
    setRevealed(false);
  }

  let content: React.ReactNode;
  if (error) {
    content = <p className="text-sm text-red-700 dark:text-red-400">{error}</p>;
  } else if (!cards || !round) {
    content = <div className="mx-auto aspect-square w-full max-w-sm animate-pulse rounded-3xl bg-stone-200 dark:bg-stone-800" />;
  } else if (cards.length === 0) {
    content = (
      <p className="text-sm leading-relaxed text-stone-500 dark:text-stone-400">
        To practice, save people with a photo and start the note with their name, like “Sarah Mitchell, neighbor”.
      </p>
    );
  } else if (!card) {
    content = (
      <div className="py-6 text-center">
        <p className="text-2xl font-semibold">
          You knew {round.known} of {round.size}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-stone-500 dark:text-stone-400">
          {round.missed > 0
            ? "The ones you missed come up first next time."
            : "Faces you know come back less and less often."}
        </p>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-stone-100 py-3 text-base font-semibold text-stone-800 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700"
          >
            Done
          </button>
          <button
            type="button"
            onClick={() => setRound(newRound(cards))}
            className="rounded-full bg-indigo-700 py-3 text-base font-semibold text-white hover:bg-indigo-800"
          >
            Practice again
          </button>
        </div>
      </div>
    );
  } else {
    const retry = round.position >= round.size;
    content = (
      <div>
        <p className="text-center text-xs font-medium text-stone-500 dark:text-stone-400">
          {retry ? "One more look" : `${round.position + 1} of ${round.size}`}
        </p>
        <img
          key={card.photoId}
          src={photoUrl(card.photoId)}
          alt=""
          className="mx-auto mt-2 aspect-square w-full max-w-sm rounded-3xl bg-stone-100 object-cover dark:bg-stone-800"
        />
        {revealed ? (
          <div className="mt-4 text-center">
            <p className="text-2xl font-semibold">{card.name}</p>
            {card.note !== card.name && (
              <p className="mx-auto mt-1 line-clamp-6 max-w-sm text-sm leading-relaxed whitespace-pre-wrap text-stone-500 dark:text-stone-400">
                {card.note}
              </p>
            )}
            <div className="mt-5 grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => answer(false)}
                className="rounded-full bg-stone-100 py-3 text-base font-semibold text-stone-800 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700"
              >
                Missed it
              </button>
              <button
                type="button"
                onClick={() => answer(true)}
                className="rounded-full bg-indigo-700 py-3 text-base font-semibold text-white hover:bg-indigo-800"
              >
                Got it
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 text-center">
            <p className="text-sm text-stone-500 dark:text-stone-400">Say the name, then check.</p>
            <button
              type="button"
              onClick={() => setRevealed(true)}
              className="mt-3 w-full rounded-full bg-indigo-700 py-3 text-base font-semibold text-white hover:bg-indigo-800"
            >
              Show name
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <Sheet title="Who’s this?" onClose={onClose}>
      {content}
    </Sheet>
  );
}
