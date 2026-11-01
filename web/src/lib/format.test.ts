import { describe, expect, it } from "vitest";
import { formatWhen, highlightParts, personLabel, personName } from "./format";

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
