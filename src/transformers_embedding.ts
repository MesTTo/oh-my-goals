// Contextual embedding provider: BGE (bge-small-en-v1.5) run locally through
// transformers.js. This is the opt-in quality path for the semmatch retrieval
// layer; the deterministic token-hash provider in embedding.ts stays the default
// and the fallback. transformers.js produces 384-dim, CLS-pooled, L2-normalized
// vectors numerically identical to the mettabase PyTorch BGE reference (max abs
// diff ~1e-7 at fp32), so it is a drop-in for the same semmatch contract.
//
// @huggingface/transformers is an optional peer dependency loaded by dynamic
// import, so the base library and the token-hash default carry none of its weight
// (its onnxruntime-node runtime is hundreds of MB). It is imported through a
// non-literal specifier so a build without the package installed still type-checks.
//
// Offline is enforced with env.allowRemoteModels = false. The HF_HUB_OFFLINE and
// TRANSFORMERS_OFFLINE environment variables are inert in transformers.js (verified
// against 4.2.0: the source references neither), so they are never relied on. The
// model is fetched once with `allowDownload`, then every query runs offline.

import { l2normalize, type EmbeddingProvider, TokenEmbeddingProvider } from "./embedding.js";

const DEFAULT_MODEL = "Xenova/bge-small-en-v1.5";
const DEFAULT_DIMENSIONS = 384;
const PACKAGE = "@huggingface/transformers";

// Measured over the controlled-English retrieval fixture (ai-tmp/retrieval_eval):
// relevant-query cosines run 0.54 to 0.77, top unrelated cosines up to 0.69. A
// 0.65 cutoff maximizes recall minus false-positive rate (0.81 vs 0.06), so it is
// the default query threshold for BGE. A caller can widen recall by lowering it.
const BGE_RECOMMENDED_THRESHOLD = 0.65;

export type TransformersDtype = "fp32" | "fp16" | "q8" | "q4";

export interface TransformersProviderOptions {
  /** Model repo id. Default `Xenova/bge-small-en-v1.5`. */
  readonly model?: string;
  /** Reported dimensionality; re-confirmed from the first embedding. Default 384. */
  readonly dimensions?: number;
  /** ONNX weight precision. `q8` is 32 MB with negligible quality loss; `fp32` (127 MB)
   * matches the PyTorch reference exactly. Default `q8`. */
  readonly dtype?: TransformersDtype;
  /** Allow a one-time network fetch of the model. Default false: query time is offline. */
  readonly allowDownload?: boolean;
  /** transformers.js cache directory for the fetched model. */
  readonly cacheDir?: string;
  /** Directory holding a local ONNX model tree, for fully air-gapped use. */
  readonly localModelPath?: string;
}

// The slice of the transformers.js API this provider uses. Declared locally so the
// build does not need the package, and matched against it at runtime.
interface FeatureTensor {
  readonly data: Float32Array | number[];
}
type FeatureExtractor = (
  text: string,
  options: { pooling: "cls" | "mean"; normalize: boolean },
) => Promise<FeatureTensor>;
interface TransformersEnv {
  allowRemoteModels: boolean;
  cacheDir?: string;
  localModelPath?: string;
}
interface TransformersModule {
  readonly env: TransformersEnv;
  pipeline(
    task: "feature-extraction",
    model: string,
    options?: { dtype?: TransformersDtype },
  ): Promise<FeatureExtractor>;
}

/** Thrown when @huggingface/transformers is not installed. */
export class TransformersUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      `${PACKAGE} is not installed. Install it to use the contextual embedding ` +
        `provider, or use the token-hash default: npm install ${PACKAGE}`,
      { cause },
    );
    this.name = "TransformersUnavailableError";
  }
}

function isModuleNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND"
  );
}

/** Local BGE embeddings through transformers.js. Embedding is async; the vector
 * index stays synchronous by storing the precomputed vectors this returns. */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly name = "BGE";
  readonly model: string;
  dimensions: number | null;
  readonly recommendedThreshold = BGE_RECOMMENDED_THRESHOLD;
  readonly #dtype: TransformersDtype;
  readonly #allowDownload: boolean;
  readonly #cacheDir: string | undefined;
  readonly #localModelPath: string | undefined;
  #extractor: Promise<FeatureExtractor> | undefined;
  readonly #cache = new Map<string, number[]>();

  constructor(options: TransformersProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS;
    this.#dtype = options.dtype ?? "q8";
    this.#allowDownload = options.allowDownload ?? false;
    this.#cacheDir = options.cacheDir;
    this.#localModelPath = options.localModelPath;
  }

  /** Load the model once (lazy). Concurrent callers share the one load. */
  async #load(): Promise<FeatureExtractor> {
    if (this.#extractor === undefined) this.#extractor = this.#createExtractor();
    return this.#extractor;
  }

  async #createExtractor(): Promise<FeatureExtractor> {
    let transformers: TransformersModule;
    try {
      // A string-typed (non-literal) specifier keeps the build independent of the
      // optional package: tsc does not resolve import() of a non-literal.
      const specifier: string = PACKAGE;
      transformers = (await import(specifier)) as unknown as TransformersModule;
    } catch (error) {
      if (isModuleNotFound(error)) throw new TransformersUnavailableError(error);
      throw error;
    }
    transformers.env.allowRemoteModels = this.#allowDownload;
    if (this.#cacheDir !== undefined) transformers.env.cacheDir = this.#cacheDir;
    if (this.#localModelPath !== undefined) transformers.env.localModelPath = this.#localModelPath;
    return transformers.pipeline("feature-extraction", this.model, { dtype: this.#dtype });
  }

  async embed(text: string): Promise<number[]> {
    if (typeof text !== "string") throw new TypeError("embed expects a string");
    const cached = this.#cache.get(text);
    if (cached !== undefined) return cached;
    const extractor = await this.#load();
    const output = await extractor(text, { pooling: "cls", normalize: true });
    // normalize: true already L2-normalizes; re-normalize defensively so a future
    // pooling change cannot silently break the unit-vector assumption cosine relies on.
    const vector = l2normalize(Array.from(output.data));
    this.dimensions = vector.length;
    this.#cache.set(text, vector);
    return vector;
  }

  /** Force the model to load (and, with allowDownload, fetch) now. */
  async warm(): Promise<void> {
    await this.embed("warm up the model");
  }
}

/** The contextual provider name, so a token-hash fallback is never reported as it. */
export const CONTEXTUAL_PROVIDER = "BGE";

export interface ResolveEmbeddingOptions extends TransformersProviderOptions {
  /** Dimensionality of the token-hash fallback. Default 256. */
  readonly fallbackDimensions?: number;
}

/** Resolve an embedding provider. `"BGE"` tries the contextual provider and falls
 * back to token-hash if its dependency or model is unavailable, so the system
 * degrades instead of crashing. The returned provider reports its own name and
 * model, so a fallback is visible in query receipts. */
export async function resolveEmbeddingProvider(
  choice: "Local" | "BGE" = "Local",
  options: ResolveEmbeddingOptions = {},
): Promise<EmbeddingProvider> {
  const fallback = new TokenEmbeddingProvider(options.fallbackDimensions ?? 256);
  if (choice === "Local") return fallback;
  const provider = new TransformersEmbeddingProvider(options);
  try {
    await provider.warm();
    return provider;
  } catch {
    return fallback;
  }
}
