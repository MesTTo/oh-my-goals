import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  ClaimExtractorError,
  type ClaimExtractor,
  type ClaimLocator,
  type ExtractionResult,
  formatLocator,
  OpenAiCompatibleExtractor,
  type ProposedClaim,
  resolveClaimExtractor,
  type StoreOutcome,
  storeExtractedClaims,
} from "../src/extractor.js";
import type { ParsedPaper } from "../src/research.js";

const PAPER: ParsedPaper = {
  metadata: { title: "A Study", arxivId: "0000.00000", year: 2020, abstract: "We study things." },
  sections: [{ heading: "Results", text: "The method improves recall by ten points." }],
  references: [],
};

const LOC: ClaimLocator = { section: "Results", quote: "improves recall" };

// A scripted extractor for the loop tests: fixed proposals, and a rewrite hook
// that records the feedback it was handed so the loop's wiring can be checked.
function fakeExtractor(
  claims: readonly ProposedClaim[],
  rewrite: (claim: string, feedback: string) => string,
  seen?: { claim: string; feedback: string }[],
): ClaimExtractor {
  return {
    model: "fake-model",
    async extract(): Promise<ExtractionResult> {
      return { model: "fake-model", claims };
    },
    async rewrite(claim: string, feedback: string): Promise<string> {
      seen?.push({ claim, feedback });
      return rewrite(claim, feedback);
    },
  };
}

const claim = (text: string, confidence = 0.7): ProposedClaim => ({ text, locator: LOC, confidence });

describe("storeExtractedClaims loop", () => {
  it("stores a claim the store accepts on the first try", async () => {
    const extractor = fakeExtractor([claim("good", 0.9)], () => "unused");
    const outcome = await storeExtractedClaims(extractor, PAPER, async () => ({ stored: true, id: "p1" }));
    expect(outcome.model).toBe("fake-model");
    expect(outcome.proposed).toBe(1);
    expect(outcome.dropped).toHaveLength(0);
    expect(outcome.stored).toEqual([{ id: "p1", text: "good", locator: LOC, confidence: 0.9, attempts: 1 }]);
  });

  it("rewrites a rejected claim with the parser feedback, then stores it", async () => {
    const seen: { claim: string; feedback: string }[] = [];
    const extractor = fakeExtractor([claim("bad")], () => "fixed", seen);
    const store = async (text: string): Promise<StoreOutcome> =>
      text === "fixed" ? { stored: true, id: "p2" } : { stored: false, feedback: "make it simpler", reasons: ["no-root-relation"] };
    const outcome = await storeExtractedClaims(extractor, PAPER, store);
    expect(outcome.stored).toHaveLength(1);
    expect(outcome.stored[0]!.attempts).toBe(2);
    expect(outcome.stored[0]!.id).toBe("p2");
    // The rewrite saw the rejected text and the parser's feedback verbatim.
    expect(seen).toEqual([{ claim: "bad", feedback: "make it simpler" }]);
  });

  it("drops a claim that never parses after the rewrite budget, keeping its reasons", async () => {
    let n = 0;
    const extractor = fakeExtractor([claim("never")], () => `never-${(n += 1)}`);
    const outcome = await storeExtractedClaims(
      extractor,
      PAPER,
      async () => ({ stored: false, feedback: "no", reasons: ["parse-failed"] }),
    );
    expect(outcome.stored).toHaveLength(0);
    expect(outcome.dropped).toHaveLength(1);
    expect(outcome.dropped[0]!.attempts).toBe(3); // one try plus the default two rewrites
    expect(outcome.dropped[0]!.reasons).toEqual(["parse-failed"]);
  });

  it("does not rewrite when maxRewrites is zero", async () => {
    const seen: { claim: string; feedback: string }[] = [];
    const extractor = fakeExtractor([claim("bad")], () => "fixed", seen);
    const outcome = await storeExtractedClaims(
      extractor,
      PAPER,
      async () => ({ stored: false, feedback: "no", reasons: ["r"] }),
      { maxRewrites: 0 },
    );
    expect(outcome.dropped[0]!.attempts).toBe(1);
    expect(seen).toHaveLength(0);
  });

  it("rejects a negative rewrite budget", async () => {
    const extractor = fakeExtractor([claim("x")], () => "y");
    await expect(
      storeExtractedClaims(extractor, PAPER, async () => ({ stored: true, id: "p" }), { maxRewrites: -1 }),
    ).rejects.toThrow(RangeError);
  });
});

// --- the OpenAI-compatible adapter against a real local endpoint ---

interface MockCall {
  method: string | undefined;
  url: string | undefined;
  auth: string | undefined;
  body: any;
}

async function withServer(
  reply: (call: MockCall) => { status?: number; body: unknown },
  run: (baseUrl: string, calls: MockCall[]) => Promise<void>,
): Promise<void> {
  const calls: MockCall[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const call: MockCall = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        body: raw === "" ? undefined : JSON.parse(raw),
      };
      calls.push(call);
      const { status = 200, body } = reply(call);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`, calls);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function completion(content: string): { body: unknown } {
  return { body: { choices: [{ message: { content } }] } };
}

describe("OpenAiCompatibleExtractor", () => {
  it("posts a chat-completions request and parses the claims", async () => {
    const payload = JSON.stringify({
      claims: [{ text: "The method improves recall.", section: "Results", quote: "improves recall", confidence: 0.8 }],
    });
    await withServer(
      () => completion(payload),
      async (baseUrl, calls) => {
        const extractor = new OpenAiCompatibleExtractor({ baseUrl, model: "test-model" });
        const result = await extractor.extract(PAPER);
        expect(result.model).toBe("test-model");
        expect(result.claims).toEqual([
          { text: "The method improves recall.", locator: { section: "Results", quote: "improves recall" }, confidence: 0.8 },
        ]);
        // The request is a well-formed OpenAI-compatible call.
        expect(calls[0]!.method).toBe("POST");
        expect(calls[0]!.url).toBe("/v1/chat/completions");
        expect(calls[0]!.body.model).toBe("test-model");
        expect(calls[0]!.body.messages).toHaveLength(2);
        expect(calls[0]!.body.messages[0].role).toBe("system");
        expect(calls[0]!.body.response_format).toEqual({ type: "json_object" });
      },
    );
  });

  it("defaults a missing confidence and tolerates JSON wrapped in prose", async () => {
    const content = 'Sure, here you go:\n{"claims":[{"text":"The drug reduces risk.","section":"","quote":""}]}\nHope that helps!';
    await withServer(
      () => completion(content),
      async (baseUrl) => {
        const extractor = new OpenAiCompatibleExtractor({ baseUrl, model: "m" });
        const result = await extractor.extract(PAPER);
        expect(result.claims[0]!.text).toBe("The drug reduces risk.");
        expect(result.claims[0]!.confidence).toBe(0.5);
      },
    );
  });

  it("sends the api key as a bearer token and honors json_schema mode", async () => {
    await withServer(
      () => completion(JSON.stringify({ claims: [] })),
      async (baseUrl, calls) => {
        const extractor = new OpenAiCompatibleExtractor({ baseUrl, model: "m", apiKey: "secret-key", responseFormat: "json_schema" });
        await extractor.extract(PAPER);
        expect(calls[0]!.auth).toBe("Bearer secret-key");
        expect(calls[0]!.body.response_format.type).toBe("json_schema");
        expect(calls[0]!.body.response_format.json_schema.strict).toBe(true);
      },
    );
  });

  it("rewrites one claim and returns the replacement text", async () => {
    await withServer(
      () => completion(JSON.stringify({ text: "The method improves recall." })),
      async (baseUrl, calls) => {
        const extractor = new OpenAiCompatibleExtractor({ baseUrl, model: "m" });
        const text = await extractor.rewrite("recall goes up and to the right, and also everything", "too many clauses");
        expect(text).toBe("The method improves recall.");
        expect(calls[0]!.body.messages[1].content).toContain("too many clauses");
      },
    );
  });

  it("raises a clear error on a non-2xx response", async () => {
    await withServer(
      () => ({ status: 500, body: { error: "boom" } }),
      async (baseUrl) => {
        const extractor = new OpenAiCompatibleExtractor({ baseUrl, model: "m" });
        await expect(extractor.extract(PAPER)).rejects.toThrow(/returned 500/);
      },
    );
  });

  it("raises a clear error when the content is not JSON", async () => {
    await withServer(
      () => completion("the model just chatted at you"),
      async (baseUrl) => {
        const extractor = new OpenAiCompatibleExtractor({ baseUrl, model: "m" });
        await expect(extractor.extract(PAPER)).rejects.toThrow(ClaimExtractorError);
      },
    );
  });

  it("rejects blank configuration", () => {
    expect(() => new OpenAiCompatibleExtractor({ baseUrl: "", model: "m" })).toThrow(ClaimExtractorError);
    expect(() => new OpenAiCompatibleExtractor({ baseUrl: "http://x/v1", model: "  " })).toThrow(ClaimExtractorError);
  });
});

describe("resolveClaimExtractor", () => {
  const saved = { base: process.env.OH_MY_GOALS_LLM_BASE_URL, model: process.env.OH_MY_GOALS_LLM_MODEL };
  afterEach(() => {
    restore("OH_MY_GOALS_LLM_BASE_URL", saved.base);
    restore("OH_MY_GOALS_LLM_MODEL", saved.model);
  });

  it("returns undefined when no model is configured", () => {
    delete process.env.OH_MY_GOALS_LLM_BASE_URL;
    delete process.env.OH_MY_GOALS_LLM_MODEL;
    expect(resolveClaimExtractor()).toBeUndefined();
  });

  it("builds an extractor from explicit options", () => {
    const extractor = resolveClaimExtractor({ baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" });
    expect(extractor).toBeInstanceOf(OpenAiCompatibleExtractor);
    expect(extractor?.model).toBe("qwen2.5:7b");
  });

  it("reads the environment when options are absent", () => {
    process.env.OH_MY_GOALS_LLM_BASE_URL = "http://localhost:1234/v1";
    process.env.OH_MY_GOALS_LLM_MODEL = "local-model";
    expect(resolveClaimExtractor()?.model).toBe("local-model");
  });
});

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("formatLocator", () => {
  it("renders a section and a quote", () => {
    expect(formatLocator({ section: "Results", quote: "BLEU rose" })).toBe('§Results: "BLEU rose"');
  });
  it("falls back when a part is missing", () => {
    expect(formatLocator({ section: "Intro", quote: "" })).toBe("Intro");
    expect(formatLocator({ section: "", quote: "a finding" })).toBe('"a finding"');
    expect(formatLocator({ section: "", quote: "" })).toBe("unspecified");
  });
  it("truncates a long quote", () => {
    const long = "x".repeat(400);
    const formatted = formatLocator({ section: "S", quote: long });
    expect(formatted.length).toBeLessThan(long.length);
    expect(formatted).toContain("…");
  });
});
