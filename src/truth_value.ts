// Parse Simple Truth Values from MeTTa and PLN output.

const STV_RE = /\(STV\s+([0-9.eE+-]+)\s+([0-9.eE+-]+)\)/;

export type Stv = readonly [strength: number, confidence: number];

/** Read the first `(STV strength confidence)` embedded in text. */
export function parseStv(text: string | null | undefined): Stv | null {
  if (text !== null && text !== undefined && typeof text !== "string") {
    throw new TypeError("STV input must be a string, null, or undefined");
  }
  if (!text) return null;
  const match = STV_RE.exec(text);
  if (!match) return null;
  const strength = Number(match[1]);
  const confidence = Number(match[2]);
  if (!Number.isFinite(strength) || !Number.isFinite(confidence)) {
    throw new SyntaxError(`invalid STV numeric value: ${match[0]}`);
  }
  return [strength, confidence];
}
