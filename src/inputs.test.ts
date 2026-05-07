import { describe, expect, it } from 'vitest';
import { parseBool, parseDuration, parseNonNegInt } from './inputs';

describe('parseBool', () => {
  it.each([
    ['true', true],
    ['TRUE', true],
    ['True', true],
    ['1', true],
    ['yes', true],
    ['YES', true],
    ['false', false],
    ['False', false],
    ['0', false],
    ['no', false],
    [' true ', true],
    [' yes', true],
  ])('parses %j as %j', (input, expected) => {
    expect(parseBool(input, !expected)).toBe(expected);
  });

  it('returns the fallback for empty input', () => {
    expect(parseBool('', false)).toBe(false);
    expect(parseBool('', true)).toBe(true);
    expect(parseBool('   ', false)).toBe(false); // whitespace-only
  });

  it.each(['ture', 'yse', 'enabled', 'on', 'off', '2', 'tru', 'truthy'])(
    'throws for unrecognized non-empty input %j',
    (input) => {
      expect(() => parseBool(input, false)).toThrow(/Invalid boolean/);
    }
  );
});

describe('parseDuration', () => {
  it.each([
    ['30s', 30_000],
    ['5m', 5 * 60_000],
    ['1h', 60 * 60_000],
    ['120s', 120_000],
    ['0s', 0],
    [' 5m ', 5 * 60_000],
  ])('parses %j as %d ms', (input, expected) => {
    expect(parseDuration(input, 999)).toBe(expected);
  });

  it('returns the fallback for empty input', () => {
    expect(parseDuration('', 12_345)).toBe(12_345);
    expect(parseDuration('   ', 12_345)).toBe(12_345);
  });

  it.each(['30sec', '5min', '1hr', '120', 'abc', '5 m', 'm5', '-5m', '5.5m'])(
    'throws for malformed input %j',
    (input) => {
      expect(() => parseDuration(input, 999)).toThrow(/Invalid duration/);
    }
  );
});

describe('parseNonNegInt', () => {
  it.each([
    ['0', 0],
    ['1', 1],
    ['42', 42],
    [' 7 ', 7],
  ])('parses %j as %d', (input, expected) => {
    expect(parseNonNegInt(input, 999)).toBe(expected);
  });

  it('returns the fallback for empty input', () => {
    expect(parseNonNegInt('', 5)).toBe(5);
    expect(parseNonNegInt('   ', 5)).toBe(5);
  });

  it.each(['abc', '1.5', '-1', '5x', 'two', '1e3', ' 1 a'])(
    'throws for non-integer input %j',
    (input) => {
      expect(() => parseNonNegInt(input, 999)).toThrow(/Invalid non-negative integer/);
    }
  );
});
