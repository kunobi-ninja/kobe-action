/**
 * Strict parsers for action.yml inputs.
 *
 * Strictness rationale: action inputs come from user-authored workflow YAML.
 * Silently coercing typos (`ture`, `30sec`, `abc`) to a fallback hides
 * configuration bugs in CI logs. Each parser throws a descriptive
 * `Error` so the failure surfaces at job startup instead of as a delayed
 * timeout or wrong-default behavior.
 *
 * Every parser accepts the empty string (the value `core.getInput`
 * returns when an input isn't set) and applies the documented default,
 * so the action's defaults still flow through cleanly.
 */

/**
 * Parse a "wait-for-ready"-style boolean input.
 *
 * Accepts (case-insensitive): `true | 1 | yes` → true; `false | 0 | no`
 * → false; empty string → `fallback`. Any other non-empty value throws —
 * we don't want `wait-for-ready: ture` silently using the default.
 */
export function parseBool(input: string, fallback: boolean): boolean {
  const v = input.trim().toLowerCase();
  if (v === '') return fallback;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new Error(
    `Invalid boolean: "${input}". Expected one of: true, false, 1, 0, yes, no.`
  );
}

/**
 * Parse a duration string like `30s`, `5m`, `1h` to milliseconds.
 *
 * Empty string → `defaultMs`. Anything that doesn't match the strict
 * `<int><unit>` shape throws — the previous silent fallback to 5 minutes
 * could make a typo'd `ready-timeout: 30sec` accept ~10× the intended
 * window without any warning.
 */
export function parseDuration(input: string, defaultMs: number): number {
  if (input.trim() === '') return defaultMs;
  const match = input.trim().match(/^(\d+)(s|m|h)$/);
  if (!match) {
    throw new Error(
      `Invalid duration: "${input}". Expected formats like 30s, 5m, 1h.`
    );
  }
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case 'h':
      return value * 3_600_000;
    case 'm':
      return value * 60_000;
    case 's':
      return value * 1_000;
    default:
      // Unreachable — the regex guarantees one of the above.
      throw new Error(`Invalid duration unit: "${match[2]}"`);
  }
}

/**
 * Parse a non-negative integer input.
 *
 * Empty string → `fallback`. Non-numeric input (or a decimal) throws —
 * the previous `parseInt('abc', 10)` would silently produce `NaN`,
 * making downstream `>=` comparisons always false and exhausting the
 * action's timeout window with no diagnostic pointing at the typo.
 */
export function parseNonNegInt(input: string, fallback: number): number {
  const trimmed = input.trim();
  if (trimmed === '') return fallback;
  // Reject anything that isn't purely digits — `parseInt` is too permissive
  // (`"1.5"` becomes `1`, `"5x"` becomes `5`).
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid non-negative integer: "${input}". Expected a whole number ≥ 0.`
    );
  }
  return parseInt(trimmed, 10);
}
