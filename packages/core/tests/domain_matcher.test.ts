import { describe, expect, it } from 'bun:test';
import { TechnologyMatcher } from '../src/domain/matcher.js';

describe('domain/TechnologyMatcher.getSearchAliasQuery (pure alias expansion)', () => {
  it('returns empty string for empty / whitespace term', () => {
    expect(TechnologyMatcher.getSearchAliasQuery('')).toBe('');
    expect(TechnologyMatcher.getSearchAliasQuery('   ')).toBe('');
  });

  it('expands a canonical alias to its GitHub OR-query', () => {
    expect(TechnologyMatcher.getSearchAliasQuery('c#')).toBe('("c#" OR "csharp")');
    expect(TechnologyMatcher.getSearchAliasQuery('csharp')).toBe('("c#" OR "csharp")');
    expect(TechnologyMatcher.getSearchAliasQuery('C#')).toBe('("c#" OR "csharp")'); // case-insensitive
  });

  it('expands other canonical definitions', () => {
    expect(TechnologyMatcher.getSearchAliasQuery('node.js')).toBe('("node.js" OR "nodejs")');
    expect(TechnologyMatcher.getSearchAliasQuery('react native')).toBe('("react native" OR "react-native")');
    expect(TechnologyMatcher.getSearchAliasQuery('pytorch')).toBe('("pytorch" OR "torch")');
  });

  it('wraps a non-listed term in quotes', () => {
    expect(TechnologyMatcher.getSearchAliasQuery('golang')).toBe('"golang"');
    expect(TechnologyMatcher.getSearchAliasQuery('Apache Kafka')).toBe('"Apache Kafka"');
  });

  it('strips unsafe punctuation but keeps word/dot/plus/hyphen characters', () => {
    expect(TechnologyMatcher.getSearchAliasQuery('my@lib!')).toBe('"mylib"');
    expect(TechnologyMatcher.getSearchAliasQuery('c++')).toBe('("c++" OR "cpp")'); // listed → alias
    expect(TechnologyMatcher.getSearchAliasQuery('@#$')).toBe(''); // nothing left → empty
  });
});

describe('domain/TechnologyMatcher.matches (pure canonical + generic matching)', () => {
  it('returns false for empty text or empty term', () => {
    expect(TechnologyMatcher.matches('', 'react')).toBe(false);
    expect(TechnologyMatcher.matches('react', '')).toBe(false);
    expect(TechnologyMatcher.matches('', '')).toBe(false);
    expect(TechnologyMatcher.matches('   ', '  ')).toBe(false);
  });

  it('matches canonical aliases via their regex patterns (case-insensitive, boundary-aware)', () => {
    expect(TechnologyMatcher.matches('We use C# for the backend', 'c#')).toBe(true);
    expect(TechnologyMatcher.matches('Built with React-Native', 'react native')).toBe(true);
    expect(TechnologyMatcher.matches('node.js powers the server', 'node.js')).toBe(true);
    expect(TechnologyMatcher.matches('No csharp here', 'csharp')).toBe(true);
  });

  it('does not match a canonical alias when boundaries are violated', () => {
    // 'c#' must appear as a standalone token, not inside another word.
    expect(TechnologyMatcher.matches('csharpish', 'c#')).toBe(false);
    expect(TechnologyMatcher.matches('reactnativecrypto', 'react native')).toBe(false);
  });

  it('falls back to strict word-boundary matching for non-listed terms', () => {
    expect(TechnologyMatcher.matches('Our service is written in golang', 'golang')).toBe(true);
    expect(TechnologyMatcher.matches('golanguage basics', 'golang')).toBe(false); // not a standalone token
    expect(TechnologyMatcher.matches('Kafka is great', 'kafka')).toBe(true);
  });
});

