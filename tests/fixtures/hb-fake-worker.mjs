// Deterministic stand-in for assets/hb_worker.py, driven by FAKE_MODE.
//
// It speaks the same line-framed JSON protocol as the real worker so the adapter
// exercises its real machinery (spawn, readline, serialization, timeout, crash,
// validation, quality gate) without loading the multi-GB spaCy and atomizer
// models. Each mode returns a canned payload that isolates one adapter behavior.

import { createInterface } from "node:readline";

const MODE = process.env.FAKE_MODE ?? "ok";

function atom(root, type, mainType) {
  return {
    atom: true,
    atom_str: `${root}/${type}`,
    root,
    label: root,
    main_type: mainType,
    type,
    role: type,
  };
}

// A well-formed accepted declarative: root relation, one covered content token,
// trailing punctuation uncovered. Overrides tailor a mode's single difference.
function makeParse(overrides = {}) {
  const base = {
    sh: '(adds/Pv.so subject/Cc object/Cc)',
    raw_metta: '(adds/Pv.so subject/Cc object/Cc)',
    typed_metta: '(sh (tag P v so ()) "adds" (args ()))',
    tree: {
      atom: false,
      edge_str: '(adds/Pv.so subject/Cc object/Cc)',
      main_type: 'R',
      type: 'Rv',
      argroles: 'so',
      connector: atom('adds', 'Pv.so', 'P'),
      children: [atom('subject', 'Cc', 'C'), atom('object', 'Cc', 'C')],
    },
    text: 'The subject adds the object.',
    tokens: ['The', 'subject', 'adds', 'the', 'object', '.'],
    tok_pos: '(2 (0 1) (3 4))',
    root_type: 'Rv',
    root_main_type: 'R',
    root_argroles: 'so',
    failed: false,
    errors: [],
    coverage: {
      n_tokens: 6,
      covered_positions: [0, 1, 2, 3, 4],
      uncovered_positions: [5],
      uncovered_tokens: ['.'],
      full: false,
    },
    diagnostics: {},
  };
  return { ...base, ...overrides };
}

function item(input, parses) {
  return { input, n_parses: parses.length, parses };
}

function withChild(parse, child) {
  return { ...parse, tree: { ...parse.tree, children: [...parse.tree.children, child] } };
}

function parseResults(sentences) {
  return sentences.map((input) => {
    switch (MODE) {
      case "negated":
        return item(input, [withChild(makeParse(), atom("no", "Mn", "M"))]);
      case "ci-declarative":
        return item(input, [
          withChild(makeParse({ text: "The output supports the proposition." }), atom("that", "Ci", "C")),
        ]);
      case "interrogative":
        return item(input, [makeParse({ text: "Which action preserves it?" })]);
      case "imperative":
        return item(input, [makeParse({ text: "Upgrade the package.", root_argroles: "o" })]);
      case "coordination":
        return item(input, [
          makeParse({
            root_main_type: "C",
            root_type: "C",
            tree: { ...makeParse().tree, main_type: "C", type: "C" },
          }),
        ]);
      case "atom-root":
        return item(input, [makeParse({ tree: atom("thing", "Cc", "C") })]);
      case "multiple-clauses":
        return item(input, [makeParse(), makeParse()]);
      case "parser-error-item":
        return { input, error: "ValueError: boom", trace: "..." };
      case "incomplete-coverage":
        return item(input, [
          makeParse({
            tokens: ["The", "subject", "adds", "leftover", "."],
            coverage: {
              n_tokens: 5,
              covered_positions: [0, 1, 2],
              uncovered_positions: [3, 4],
              uncovered_tokens: ["leftover", "."],
              full: false,
            },
          }),
        ]);
      case "failed-parse":
        return item(input, [makeParse({ failed: true, errors: ["reduction failed"] })]);
      case "diagnostics":
        return item(input, [makeParse({ diagnostics: { "0": [["argrole", "mismatch", 2]] } })]);
      case "malformed-tree":
        return item(input, [makeParse({ tree: { ...makeParse().tree, main_type: "Z" } })]);
      default:
        return item(input, [makeParse()]);
    }
  });
}

function handle(payload) {
  const op = payload.op ?? "parse";
  if (op === "probe") {
    if (MODE === "probe-nomodel") {
      return { ok: true, op: "probe", parser: "alphabeta", spacy_model: "" };
    }
    return { ok: true, op: "probe", parser: "alphabeta", spacy_model: "fake-en" };
  }
  if (MODE === "worker-error") {
    return { ok: false, error: "RuntimeError: model missing" };
  }
  return {
    ok: true,
    op: "parse",
    parser: "alphabeta",
    spacy_model: "fake-en",
    results: parseResults(payload.sentences ?? []),
  };
}

const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  if (line.trim() === "") return;
  if (MODE === "crash") {
    process.exit(1);
  }
  if (MODE === "hang") {
    return; // never respond
  }
  if (MODE === "badjson") {
    process.stdout.write("this is not json\n");
    return;
  }
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    payload = {};
  }
  process.stdout.write(`${JSON.stringify(handle(payload))}\n`);
});
