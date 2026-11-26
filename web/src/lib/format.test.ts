import { describe, expect, it } from "vitest";
import { formatWhen, highlightParts, personLabel, personName, photoTextSnippet } from "./format";

describe("personLabel", () => {
  it("takes the name at the start of the note", () => {
    expect(personLabel("Sarah Mitchell, neighbor at #14. Kids Emma and Jake")).toBe("Sarah Mitchell");
    expect(personLabel("Dave from accounting - red beard")).toBe("Dave from accounting");
    expect(personLabel("Dr. Patel (dentist)")).toBe("Dr. Patel");
    expect(personLabel("Coach Rivera\nU10 soccer")).toBe("Coach Rivera");
  });

  it("shortens long openings at a word break", () => {
    expect(personLabel("The tall guy who always brings donuts to the Friday meeting")).toBe("The tall guy who always brings donuts…");
    expect(personLabel("")).toBe("");
  });
});

describe("personName", () => {
  it("finds the name a note starts with", () => {
    expect(personName("Sarah Mitchell, neighbor at #14. Kids Emma and Jake")).toBe("Sarah Mitchell");
    expect(personName("Dr. Kim is our dentist, office on Maple Ave")).toBe("Dr. Kim");
    expect(personName("Coach Ramirez runs Emma's soccer team")).toBe("Coach Ramirez");
    expect(personName("Linda across the street has the big garden")).toBe("Linda");
    expect(personName("Mary-Jane O'Neil from church")).toBe("Mary-Jane O'Neil");
    expect(personName("Sarah. Neighbor at 14")).toBe("Sarah");
  });

  it("falls back to the label when the note doesn't start with a name", () => {
    expect(personName("The tall guy who always brings donuts to the Friday meeting")).toBe("The tall guy who always brings donuts…");
    expect(personName("Emma's teacher Ms. Lopez")).toBe("Emma's teacher Ms. Lopez");
    expect(personName("Sarah Mitchell's mom, Joan")).toBe("Sarah Mitchell's mom");
    expect(personName("dave from accounting")).toBe("dave from accounting");
    expect(personName("")).toBe("");
  });
});

describe("highlightParts", () => {
  it("marks words that start with a search term", () => {
    expect(highlightParts("Sarah's kids are Emma and Jake", "sarah kid")).toEqual([
      { text: "Sarah", match: true },
      { text: "'s ", match: false },
      { text: "kids", match: true },
      { text: " are Emma and Jake", match: false },
    ]);
  });

  it("ignores filler words in the query", () => {
    expect(highlightParts("ipad in the gym", "where is the ipad")).toEqual([
      { text: "ipad", match: true },
      { text: " in the gym", match: false },
    ]);
  });

  it("doesn't match inside words", () => {
    expect(highlightParts("bookcase", "case")).toEqual([{ text: "bookcase", match: false }]);
  });
});

describe("photoTextSnippet", () => {
  const filler = (count: number) => Array.from({ length: count }, (_, i) => `word${i}`).join(" ");
  /** Strips the ellipses and checks the rest is whole words, cut only at spaces, of the one-line text. */
  const inner = (snippet: string, line: string) => {
    const body = snippet.replace(/^…/, "").replace(/…$/, "");
    const at = line.indexOf(body);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at === 0 || line[at - 1] === " ").toBe(true);
    expect(at + body.length === line.length || line[at + body.length] === " ").toBe(true);
    expect(snippet.startsWith("…")).toBe(at > 0);
    expect(snippet.endsWith("…")).toBe(at + body.length < line.length);
    return body;
  };

  it("returns short text as one line", () => {
    expect(photoTextSnippet("2 cups flour\n1 tsp salt", "flour")).toBe("2 cups flour 1 tsp salt");
    expect(photoTextSnippet("  Bake 350\r\n\n\tfor   10 min ", "bake")).toBe("Bake 350 for 10 min");
  });

  it("cuts long text at word boundaries around a deep match, with ellipses at both ends", () => {
    const text = `${filler(80)}\n\nAdd the sourdough starter\n${filler(80)}`;
    expect(text.length).toBeGreaterThan(1_000);
    const snippet = photoTextSnippet(text, "sourdough")!;
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    const body = inner(snippet, text.replace(/\s+/g, " "));
    expect(body).toContain("sourdough");
    expect(body.length).toBeLessThanOrEqual(160);
    expect(body).not.toMatch(/\n|\s{2}/);
    // Context on both sides of the match.
    expect(body.indexOf("sourdough")).toBeGreaterThan(40);
    expect(body.length - body.indexOf("sourdough")).toBeGreaterThan(40);
  });

  it("only adds ellipses at the ends that were cut", () => {
    const text = `Flour first ${filler(100)}`;
    const atStart = photoTextSnippet(text, "flour")!;
    expect(atStart.startsWith("Flour first")).toBe(true);
    expect(atStart.endsWith("…")).toBe(true);
    expect(inner(atStart, text).length).toBeLessThanOrEqual(160);

    const atEnd = photoTextSnippet(`${filler(100)} salt last`, "salt")!;
    expect(atEnd.startsWith("…")).toBe(true);
    expect(atEnd.endsWith("salt last")).toBe(true);
    expect(inner(atEnd, `${filler(100)} salt last`).length).toBeLessThanOrEqual(160);
  });

  it("respects a custom maxLength and uses the first match", () => {
    const text = `${filler(20)} salt one ${filler(20)} salt two`;
    const snippet = photoTextSnippet(text, "salt", 30)!;
    const body = inner(snippet, text);
    expect(body.length).toBeLessThanOrEqual(30);
    expect(body).toContain("salt one");
  });

  it("never cuts the matched word", () => {
    const long = `${"x".repeat(200)}/sourdoughstarter/${"y".repeat(200)}`;
    expect(photoTextSnippet(`intro ${long} outro`, "sourdough")).toBe("…sourdoughstarter…");
    expect(photoTextSnippet(`${"a ".repeat(100)}supercalifragilistic end`, "super", 10)).toBe("…supercalifragilistic…");
  });

  it("matches word prefixes, ignoring case, but not inside words", () => {
    expect(photoTextSnippet("Flour", "flo")).toBe("Flour");
    expect(photoTextSnippet("cauliflower", "flower")).toBeNull();
    expect(photoTextSnippet("2 cups flour", "sugar")).toBeNull();
  });

  it("is null for a query without search terms", () => {
    expect(photoTextSnippet("Where is the ipad", "where is the")).toBeNull();
    expect(photoTextSnippet("Where is the ipad", "")).toBeNull();
    expect(photoTextSnippet("Where is the ipad", "  ")).toBeNull();
  });
});

describe("formatWhen", () => {
  const now = new Date(2026, 9, 31, 15, 0).getTime();

  it("names recent days", () => {
    expect(formatWhen(new Date(2026, 9, 31, 9, 5).getTime(), now)).toMatch(/^Today /);
    expect(formatWhen(new Date(2026, 9, 30, 21, 0).getTime(), now)).toMatch(/^Yesterday /);
    expect(formatWhen(new Date(2026, 9, 27, 9, 0).getTime(), now)).toBe("Tuesday");
  });

  it("uses dates for older memories", () => {
    expect(formatWhen(new Date(2026, 2, 3).getTime(), now)).toMatch(/Mar\w* 3/);
    expect(formatWhen(new Date(2024, 2, 3).getTime(), now)).toMatch(/2024/);
  });
});
