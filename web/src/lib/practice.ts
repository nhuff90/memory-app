import type { Memory } from "../../../shared/types";
import { personName } from "./format";

export interface PracticeCard {
  memoryId: number;
  photoId: number;
  name: string;
  /** The whole note, shown with the name: kids, job, where you met. */
  note: string;
}

export interface Familiarity {
  /** 0 for someone new or just missed. Each right answer moves them up a box. */
  box: number;
  seenAt: number;
}

export type PracticeProgress = Record<number, Familiarity>;

const DAY = 24 * 60 * 60 * 1000;
/** Days someone rests in each box before coming up again, so known faces come up less and less. */
const REST_DAYS = [0, 1, 3, 7, 21, 60];
const TOP_BOX = REST_DAYS.length - 1;
const ROUND_SIZE = 10;
const STORAGE_KEY = "recall:practice";

/** People with a photo and a name to learn, using each one's first photo. */
export function practiceCards(memories: Memory[]): PracticeCard[] {
  return memories.flatMap((memory) => {
    const photo = memory.photos[0];
    const name = personName(memory.body);
    if (!photo || !name || memory.archivedAt !== null) return [];
    return [{ memoryId: memory.id, photoId: photo.id, name, note: memory.body }];
  });
}

export function isDue(familiarity: Familiarity | undefined, now: number): boolean {
  return !familiarity || now - familiarity.seenAt >= REST_DAYS[familiarity.box]! * DAY;
}

/** Up to `size` people: those due first, the least known of them first, shuffled within each box. */
export function buildRound(
  cards: PracticeCard[],
  progress: PracticeProgress,
  now: number,
  size = ROUND_SIZE,
  random: () => number = Math.random,
): PracticeCard[] {
  return cards
    .map((card) => {
      const familiarity = progress[card.memoryId];
      return { card, due: isDue(familiarity, now), box: familiarity?.box ?? 0, shuffle: random() };
    })
    .sort((a, b) => Number(b.due) - Number(a.due) || a.box - b.box || a.shuffle - b.shuffle)
    .slice(0, size)
    .map(({ card }) => card);
}

export function recordAnswer(
  progress: PracticeProgress,
  memoryId: number,
  knewIt: boolean,
  now: number,
): PracticeProgress {
  const box = knewIt ? Math.min((progress[memoryId]?.box ?? 0) + 1, TOP_BOX) : 0;
  return { ...progress, [memoryId]: { box, seenAt: now } };
}

/** Progress is kept on this device only. */
export function loadProgress(storage: Pick<Storage, "getItem">): PracticeProgress {
  let saved: unknown;
  try {
    saved = JSON.parse(storage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
  if (!saved || typeof saved !== "object") return {};
  const progress: PracticeProgress = {};
  for (const [id, value] of Object.entries(saved)) {
    const { box, seenAt } = (value ?? {}) as Partial<Familiarity>;
    const validBox = typeof box === "number" && Number.isInteger(box) && box >= 0 && box <= TOP_BOX;
    if (validBox && typeof seenAt === "number" && Number.isFinite(seenAt)) progress[Number(id)] = { box, seenAt };
  }
  return progress;
}

export function saveProgress(storage: Pick<Storage, "setItem">, progress: PracticeProgress): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Full or blocked storage: practice still works, it just starts fresh next time.
  }
}
