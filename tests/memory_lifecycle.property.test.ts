import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { InMemoryDurableStore } from "../src/durable_store.js";
import { MemorySpace, type MemoryKind, type MemoryScope } from "../src/memory.js";

// Property-based lifecycle test (PLAN.md "Property-based lifecycle tests"). It
// generates sequences of remember, derive, drop-source, restore, bulk-retract,
// supersede, add-proof, purge, and restart, replays them against a real
// MemorySpace, and after every operation asserts the plan's invariants against a
// shadow model:
//
//   1-3. the active set is exactly the model's fixpoint of active supports and
//        valid proofs, so an active proposition has an active source or an
//        all-active-premise proof, and an inactive one appears in no active list;
//   4.   a conclusion with two proofs survives losing one premise;
//   5.   a proposition's revision never decreases;
//   6.   an active-scope list returns only propositions of that scope;
//   7.   reopening the store reproduces the same active state;
//   8.   a purged proposition is gone from reads, active lists, and the store,
//        and stays gone across a restart.
//
// The model computes active state the way oh-my-goals.metta does. A base
// proposition is active with at least one active source and no bulk retraction; a
// bulk retract sets a sticky retracted state that adding a source does not undo,
// while dropping and re-adding individual sources is reversible. A derived
// conclusion is active when some proof has every premise active. Superseded or
// purged propositions are inactive. Fixpoint iteration resolves proof chains.

const SCOPES: readonly MemoryScope[] = ["session", "project", "user", "derived"];
const BASE_KINDS: readonly MemoryKind[] = ["observation", "goal", "norm", "hypothesis", "action"];
const REPO = "prop-repo";
const SESSION = "prop-session";

interface Entry {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly index: number; // creation order, for keeping the proof graph acyclic
  readonly type: "base" | "derived";
  activeSources: number; // base: count of active supporting sources
  retracted: boolean; // base: sticky bulk retraction
  proofs: string[][]; // derived: each proof is a premise-id list
  superseded: boolean;
  purged: boolean;
}

function baseActive(e: Entry): boolean {
  return e.type === "base" && !e.retracted && e.activeSources > 0;
}

// The active set as the MeTTa rules define it, by fixpoint over proof chains.
function computeActive(model: Map<string, Entry>): Set<string> {
  const alive = [...model.values()].filter((e) => !e.purged && !e.superseded);
  const active = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of alive) {
      if (active.has(e.id)) continue;
      const nowActive =
        e.type === "base"
          ? baseActive(e)
          : e.proofs.some((proof) => proof.length > 0 && proof.every((p) => active.has(p)));
      if (nowActive) {
        active.add(e.id);
        changed = true;
      }
    }
  }
  return active;
}

// One generated operation. Existing propositions are addressed by an index that
// replay resolves modulo the current candidate list, so a command is never
// invalid: it acts on a real id or, when no candidate exists, is a no-op.
type Command =
  | { op: "remember"; scope: MemoryScope; kind: MemoryKind }
  | { op: "derive"; scope: MemoryScope; a: number; b: number; two: boolean }
  | { op: "dropSource"; pick: number }
  | { op: "restore"; pick: number }
  | { op: "retract"; pick: number }
  | { op: "supersede"; scope: MemoryScope; kind: MemoryKind; pick: number }
  | { op: "addProof"; target: number; premise: number }
  | { op: "purge"; pick: number }
  | { op: "restart" };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ op: fc.constant("remember" as const), scope: fc.constantFrom(...SCOPES), kind: fc.constantFrom(...BASE_KINDS) }),
  fc.record({ op: fc.constant("derive" as const), scope: fc.constantFrom(...SCOPES), a: fc.nat(), b: fc.nat(), two: fc.boolean() }),
  fc.record({ op: fc.constant("dropSource" as const), pick: fc.nat() }),
  fc.record({ op: fc.constant("restore" as const), pick: fc.nat() }),
  fc.record({ op: fc.constant("retract" as const), pick: fc.nat() }),
  fc.record({ op: fc.constant("supersede" as const), scope: fc.constantFrom(...SCOPES), kind: fc.constantFrom(...BASE_KINDS), pick: fc.nat() }),
  fc.record({ op: fc.constant("addProof" as const), target: fc.nat(), premise: fc.nat() }),
  fc.record({ op: fc.constant("purge" as const), pick: fc.nat() }),
  fc.constant({ op: "restart" as const }),
);

const at = <T>(items: readonly T[], index: number): T | undefined =>
  items.length === 0 ? undefined : items[index % items.length];

const SOURCE = [{ type: "user" as const, reference: "prop" }];

const BASE_MS = Date.UTC(2026, 6, 13, 0, 0, 0);

function newSpace(store: InMemoryDurableStore): MemorySpace {
  let tick = 0;
  // Valid, monotonic ISO timestamps for any sequence length, so a long run never
  // rolls past 59 seconds into an unparseable recordedAt.
  return new MemorySpace({
    store,
    repository: REPO,
    session: SESSION,
    now: () => new Date(BASE_MS + tick++ * 1000).toISOString(),
  });
}

function runSequence(commands: readonly Command[]): void {
  const store = new InMemoryDurableStore();
  let space = newSpace(store);
  const model = new Map<string, Entry>();
  const order: string[] = []; // insertion order, for stable index resolution
  const revisionSeen = new Map<string, number>();
  let content = 0;

  const nonPurged = (): string[] => order.filter((id) => !model.get(id)!.purged);
  // Base propositions that can still take a source operation: live and not superseded.
  const baseLive = (): string[] =>
    order.filter((id) => {
      const e = model.get(id)!;
      return e.type === "base" && !e.purged && !e.superseded;
    });
  const baseActiveEligible = (): string[] => baseLive().filter((id) => !model.get(id)!.retracted);
  const derivedLive = (): string[] =>
    order.filter((id) => {
      const e = model.get(id)!;
      return e.type === "derived" && !e.purged && !e.superseded;
    });
  const firstActiveAssertion = (id: string): string | undefined =>
    space.get(id)?.sources.find((s) => s.state === "active")?.assertionId;

  const apply = (cmd: Command): void => {
    switch (cmd.op) {
      case "remember": {
        const p = space.remember({ content: `p${content++}`, scope: cmd.scope, kind: cmd.kind, sources: SOURCE });
        model.set(p.id, { id: p.id, scope: cmd.scope, index: order.length, type: "base", activeSources: 1, retracted: false, proofs: [], superseded: false, purged: false });
        order.push(p.id);
        return;
      }
      case "derive": {
        const candidates = nonPurged();
        const first = at(candidates, cmd.a);
        if (first === undefined) return;
        const premises = cmd.two ? [first, at(candidates, cmd.b)!] : [first];
        const p = space.derive({ content: `d${content++}`, rule: "r", premises, scope: cmd.scope, kind: "derived-conclusion" });
        model.set(p.id, { id: p.id, scope: cmd.scope, index: order.length, type: "derived", activeSources: 0, retracted: false, proofs: [[...premises]], superseded: false, purged: false });
        order.push(p.id);
        return;
      }
      case "dropSource": {
        const id = at(baseLive(), cmd.pick);
        if (id === undefined) return;
        const assertionId = firstActiveAssertion(id);
        if (assertionId === undefined) return; // no active source to drop
        space.retractSource(id, assertionId);
        model.get(id)!.activeSources -= 1;
        return;
      }
      case "restore": {
        const id = at(baseLive(), cmd.pick);
        if (id === undefined) return;
        space.addSource(id, { type: "tool", reference: `restore${content++}` });
        model.get(id)!.activeSources += 1;
        return;
      }
      case "retract": {
        const id = at(baseActiveEligible(), cmd.pick);
        if (id === undefined) return;
        space.retract(id);
        const e = model.get(id)!;
        e.retracted = true;
        e.activeSources = 0;
        return;
      }
      case "supersede": {
        const id = at(baseActiveEligible(), cmd.pick);
        if (id === undefined) return;
        const result = space.supersede(id, { content: `s${content++}`, scope: cmd.scope, kind: cmd.kind, sources: SOURCE });
        if (!("ok" in result) || result.ok !== true) return;
        model.get(id)!.superseded = true;
        const created = result.replacement.id;
        model.set(created, { id: created, scope: cmd.scope, index: order.length, type: "base", activeSources: 1, retracted: false, proofs: [], superseded: false, purged: false });
        order.push(created);
        return;
      }
      case "addProof": {
        const id = at(derivedLive(), cmd.target);
        if (id === undefined) return;
        // Keep the proof graph acyclic: a premise must predate the conclusion.
        const targetIndex = model.get(id)!.index;
        const premise = at(nonPurged().filter((p) => model.get(p)!.index < targetIndex), cmd.premise);
        if (premise === undefined) return;
        space.addProof(id, "r2", [premise]);
        model.get(id)!.proofs.push([premise]);
        return;
      }
      case "purge": {
        const id = at(nonPurged(), cmd.pick);
        if (id === undefined) return;
        space.purge(id);
        model.get(id)!.purged = true;
        return;
      }
      case "restart": {
        // Rebuild from the same store to exercise load()/rebuildFacts. The old
        // space is dropped without close(), because closing clears the in-memory
        // store; a real process restart reopens the persisted store, which this
        // rebuild reproduces at the record-to-facts level.
        space = newSpace(store);
        return;
      }
    }
  };

  const check = (): void => {
    const expected = computeActive(model);

    // 1-3, 8: the live active set is exactly the model's fixpoint, and a purged
    // proposition is unreadable and inactive.
    for (const [id, e] of model) {
      if (e.purged) {
        expect(space.get(id), `purged ${id} is unreadable`).toBeUndefined();
        expect(space.isActive(id), `purged ${id} is inactive`).toBe(false);
      } else {
        expect(space.isActive(id), `active(${id}) matches the model`).toBe(expected.has(id));
      }
    }

    // 2, 6: each active-scope list is exactly the active propositions of that
    // scope, and returns nothing from another scope.
    for (const scope of SCOPES) {
      const got = [...space.activeInScope(scope)].sort();
      const want = [...expected].filter((id) => model.get(id)!.scope === scope).sort();
      expect(got, `activeInScope(${scope})`).toEqual(want);
      for (const id of got) expect(model.get(id)!.scope, `${id} belongs to ${scope}`).toBe(scope);
    }

    // 5: revision never decreases for any proposition.
    for (const [id, e] of model) {
      if (e.purged) continue;
      const revision = space.get(id)?.revision;
      if (revision === undefined) continue;
      expect(revision, `revision(${id}) monotonic`).toBeGreaterThanOrEqual(revisionSeen.get(id) ?? 0);
      revisionSeen.set(id, revision);
    }

    // 8: a purged id is absent from the durable store, not merely hidden.
    const stored = new Set(store.allRecords().map((record) => record.id));
    for (const [id, e] of model) {
      if (e.purged) expect(stored.has(id), `purged ${id} left the store`).toBe(false);
    }
  };

  check();
  for (const cmd of commands) {
    apply(cmd);
    check();
  }
  // 7: a final restart reproduces the active state one more time.
  space = newSpace(store);
  check();
  space.close();
}

describe("property: memory lifecycle invariants hold across generated operation sequences", () => {
  it("keeps active state, revisions, scope, purge, and restart consistent with the model", () => {
    // A fixed seed keeps the suite deterministic instead of flaky; this seed and
    // run count were confirmed against 30000 runs while hardening the invariants.
    fc.assert(
      fc.property(fc.array(command, { minLength: 1, maxLength: 40 }), (commands) => {
        runSequence(commands);
      }),
      { numRuns: 500, seed: 12345 },
    );
  });

  // Invariant 4 deterministically: a conclusion with two proofs survives losing
  // the premise of one, and goes inactive only when both premises are gone, then
  // reactivates when a premise is restored.
  it("preserves a conclusion through an alternate proof and reactivates it when a premise returns", () => {
    const store = new InMemoryDurableStore();
    const space = newSpace(store);
    const a = space.remember({ content: "premise a", scope: "project", kind: "observation", sources: SOURCE });
    const b = space.remember({ content: "premise b", scope: "project", kind: "observation", sources: SOURCE });
    const c = space.derive({ content: "conclusion", rule: "r", premises: [a.id], scope: "project", kind: "derived-conclusion" });
    space.addProof(c.id, "r2", [b.id]);
    expect(space.isActive(c.id)).toBe(true);

    const drop = (id: string) => space.retractSource(id, space.get(id)!.sources.find((s) => s.state === "active")!.assertionId);

    drop(a.id); // one proof fails, the other still holds
    expect(space.isActive(a.id)).toBe(false);
    expect(space.isActive(c.id)).toBe(true);

    drop(b.id); // both proofs fail
    expect(space.isActive(c.id)).toBe(false);

    space.addSource(b.id, { type: "tool", reference: "restore" }); // restore the surviving proof
    expect(space.isActive(b.id)).toBe(true);
    expect(space.isActive(c.id)).toBe(true);
    space.close();
  });
});
