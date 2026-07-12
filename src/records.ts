// Safe access to caller-supplied string-keyed records.

/** Return an own record value without consulting Object.prototype. */
export function ownValue<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Return a finite number in the closed unit interval. */
export function finiteProbability(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${path} must be finite and within [0, 1]`);
  }
  return value;
}

/** Require an actual array with an own value at every numeric index. */
export function assertDenseArray(
  value: unknown,
  field: string,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (descriptor === undefined) {
      throw new TypeError(`${field} must not contain holes`);
    }
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${field}[${index}] must be an enumerable data property`);
    }
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
      throw new TypeError(`${field} must contain only indexed data properties`);
    }
  }
}

/** Require a plain own-property record, including null-prototype records. */
export function assertPlainRecord<T>(
  value: T,
  field: string,
): asserts value is T & Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be a plain object record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object record`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError(`${field} must contain only string-keyed data properties`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${field}.${key} must be an enumerable data property`);
    }
  }
}

/** Reject misspelled or unsupported fields on a fixed-shape record. */
export function assertNoInheritedKeys(
  value: Readonly<Record<string, unknown>>,
  field: string,
  knownKeys: readonly string[],
): void {
  for (const key of knownKeys) {
    if (!Object.hasOwn(value, key) && key in value) {
      throw new TypeError(`${field}.${key} must be an own property when present`);
    }
  }
}

/** Reject misspelled, unsupported, or inherited fields on a fixed-shape record. */
export function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  field: string,
  allowedKeys: readonly string[],
): void {
  assertNoInheritedKeys(value, field, allowedKeys);
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${field} contains unknown fields: ${unknown.join(", ")}`);
  }
}
