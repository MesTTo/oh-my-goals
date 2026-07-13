"""Resident AlphaBeta HyperBase parse worker: line-framed JSON over stdio.

The oh-my-goals HyperBase adapter drives this as a long-lived child process.
Loading spaCy en_core_web_trf and the DistilBERT atomizer costs several seconds
and a few GB of RSS, so the worker builds the parser once, keeps it resident,
and answers many requests over its lifetime.

Protocol. One JSON request per stdin line, one JSON response per stdout line.

  request  {"op": "probe", "lang": "en"}
           {"op": "parse", "sentences": ["..."], "lang": "en", "max_parse_time": 10.0}
  response {"ok": true, "op": "probe", "parser": "alphabeta", "spacy_model": "..."}
           {"ok": true, "op": "parse", "parser": "alphabeta", "spacy_model": "...",
            "results": [ <record per input sentence> ]}
           {"ok": false, "error": "<Type>: <message>", "trace": "..."}

Stdout purity. The parser calls bare print(...) on parse errors, timeouts, and
(only under debug) the model name. Each request wraps its whole build+parse
window in redirect_stdout(stderr); the single JSON response is the only thing
written to the real stdout. stdin.readline() drives the loop (never
`for line in sys.stdin`, whose read-ahead would deadlock a request/response
protocol).

This worker emits raw parse facts only (the SH string, the typed and untyped
MeTTa projections, the recursive typed tree, tokens, token positions, root
type, argument roles, coverage positions, and correctness diagnostics). The
Node adapter recovers speech-act mood and polarity, decides source coverage
over content tokens, and runs the quality gate. Keeping interpretation on the
TypeScript side gives one authoritative, unit-testable acceptance layer.
"""
from __future__ import annotations

import contextlib
import json
import sys
import traceback

REAL_STDOUT = sys.stdout

# One parser instance per language, built on first use and reused thereafter.
_PARSERS: dict[str, object] = {}


def get_cached_parser(lang: str):
    parser = _PARSERS.get(lang)
    if parser is None:
        from mettabase._vendor.hyperbase import get_parser

        parser = get_parser("alphabeta", lang=lang)
        _PARSERS[lang] = parser
    return parser


def collect_positions(tok_pos) -> list[int]:
    if tok_pos.atom:
        try:
            p = int(str(tok_pos))
        except ValueError:
            return []
        return [p] if p >= 0 else []
    out: list[int] = []
    for sub in tok_pos:
        out.extend(collect_positions(sub))
    return out


def node_tree(edge) -> dict:
    """Recursive typed view: type, subtype, roles, label/root, children."""
    if edge.atom:
        parts = edge.parts()
        role = edge.role()
        return {
            "atom": True,
            "atom_str": str(edge),
            "root": edge.root(),
            "label": edge.label(),
            "main_type": edge.type()[:1],
            "type": edge.type(),
            "role": ".".join(role),
        }
    conn = edge[0]
    return {
        "atom": False,
        "edge_str": str(edge),
        "main_type": edge.mtype(),
        "type": edge.type(),
        "argroles": edge.argroles(),
        "connector": node_tree(conn),
        "children": [node_tree(c) for c in edge[1:]],
    }


def parse_one(parser, sentence: str, check_parse_correctness) -> dict:
    from mettabase.hyperbase.typed_projection import edge_to_typed_metta
    from mettabase.hyperbase.bridge import edge_to_metta

    rec = {"input": sentence}
    try:
        parses = parser.parse(sentence)
        rec["n_parses"] = len(parses)
        rec["parses"] = []
        for r in parses:
            sh = str(r.edge)
            argroles = r.edge.argroles()
            covered = sorted(set(collect_positions(r.tok_pos)))
            ntok = len(r.tokens)
            uncovered = [i for i in range(ntok) if i not in covered]
            diag = None
            if check_parse_correctness is not None:
                try:
                    diag = {
                        str(k): v
                        for k, v in check_parse_correctness(r.edge, r.tokens).items()
                    }
                except Exception as e:
                    diag = {"_error": str(e)}
            rec["parses"].append(
                {
                    "sh": sh,
                    "raw_metta": edge_to_metta(r.edge),
                    "typed_metta": edge_to_typed_metta(r.edge),
                    "tree": node_tree(r.edge),
                    "text": r.text,
                    "tokens": r.tokens,
                    "tok_pos": str(r.tok_pos),
                    "root_type": r.edge.type(),
                    "root_main_type": r.edge.mtype(),
                    "root_argroles": argroles,
                    "failed": r.failed,
                    "errors": r.errors,
                    "coverage": {
                        "n_tokens": ntok,
                        "covered_positions": covered,
                        "uncovered_positions": uncovered,
                        "uncovered_tokens": [r.tokens[i] for i in uncovered],
                        "full": len(uncovered) == 0,
                    },
                    "diagnostics": diag,
                }
            )
    except Exception as e:
        rec["error"] = f"{type(e).__name__}: {e}"
        rec["trace"] = traceback.format_exc()
    return rec


def handle(payload: dict) -> dict:
    op = payload.get("op", "parse")
    lang = payload.get("lang", "en")
    parser = get_cached_parser(lang)
    spacy_model = getattr(parser, "spacy_model", None)

    if op == "probe":
        return {
            "ok": True,
            "op": "probe",
            "parser": "alphabeta",
            "spacy_model": spacy_model,
        }

    if op != "parse":
        return {"ok": False, "error": f"ValueError: unknown op {op!r}"}

    try:
        from mettabase._vendor.hyperbase.parsers.correctness import (
            check_parse_correctness,
        )
    except Exception:
        check_parse_correctness = None

    parser.max_parse_time = float(payload.get("max_parse_time", 10.0))
    results = [
        parse_one(parser, s, check_parse_correctness)
        for s in payload.get("sentences", [])
    ]
    return {
        "ok": True,
        "op": "parse",
        "parser": "alphabeta",
        "spacy_model": spacy_model,
        "results": results,
    }


def respond(obj: dict) -> None:
    json.dump(obj, REAL_STDOUT, ensure_ascii=False)
    REAL_STDOUT.write("\n")
    REAL_STDOUT.flush()


def main() -> None:
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        # Redirect any parser stdout chatter to stderr for the whole window so
        # that the single JSON response is the only thing on real stdout.
        with contextlib.redirect_stdout(sys.stderr):
            try:
                payload = json.loads(line)
                out = handle(payload)
            except Exception as e:
                out = {
                    "ok": False,
                    "error": f"{type(e).__name__}: {e}",
                    "trace": traceback.format_exc(),
                }
        respond(out)


if __name__ == "__main__":
    main()
