/** Sum binary64 values with Python 3.12+'s compensated float algorithm. */
export function pythonFloatSum(values: readonly number[]): number {
  let high = 0;
  let low = 0;
  for (const value of values) {
    const total = high + value;
    low += Math.abs(high) >= Math.abs(value)
      ? (high - total) + value
      : (value - total) + high;
    high = total;
  }
  return low !== 0 && Number.isFinite(low) ? high + low : high;
}

/** Round to 6 decimal places the way Python's round() does for reports. */
export function round6(value: number): number {
  return roundN(value, 6);
}

/** Round a binary64 number to decimal places using Python's ties-to-even rule. */
export function roundN(value: number, digits: number): number {
  if (!Number.isInteger(digits)) {
    throw new TypeError("digits must be an integer");
  }
  if (typeof value !== "number") throw new TypeError("value must be a number");
  if (!Number.isFinite(value) || value === 0 || digits > 323) return value;
  if (digits < -308) return value < 0 ? -0 : 0;

  const negative = value < 0;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(value));
  const bits = view.getBigUint64(0);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);

  let numerator: bigint;
  let binaryExponent: number;
  if (exponentBits === 0) {
    numerator = fraction;
    binaryExponent = -1074;
  } else {
    numerator = (1n << 52n) | fraction;
    binaryExponent = exponentBits - 1023 - 52;
  }

  let denominator = 1n;
  if (binaryExponent >= 0) {
    numerator <<= BigInt(binaryExponent);
  } else {
    denominator <<= BigInt(-binaryExponent);
  }
  if (digits >= 0) {
    numerator *= 10n ** BigInt(digits);
  } else {
    denominator *= 10n ** BigInt(-digits);
  }

  let rounded = numerator / denominator;
  const twiceRemainder = (numerator % denominator) * 2n;
  if (
    twiceRemainder > denominator ||
    (twiceRemainder === denominator && rounded % 2n === 1n)
  ) {
    rounded += 1n;
  }

  const result = Number(`${negative ? "-" : ""}${rounded}e${-digits}`);
  if (!Number.isFinite(result)) {
    throw new RangeError("rounded value too large to represent");
  }
  return result;
}
