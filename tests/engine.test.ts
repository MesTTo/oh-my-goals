import { describe, expect, it } from "vitest";

import { addTerms, type MettaDB } from "../src/engine.js";

describe("shared MeTTa-TS engine helpers", () => {
  it("adds more terms than V8 accepts as spread arguments", () => {
    let calls = 0;
    let termsAdded = 0;
    const db = {
      add(...terms: unknown[]) {
        calls += 1;
        termsAdded += terms.length;
        return this;
      },
    } as unknown as MettaDB;
    const terms = Array.from({ length: 130_000 }, (_, index) => index);

    addTerms(db, terms);

    expect(calls).toBe(terms.length);
    expect(termsAdded).toBe(terms.length);
  });
});
