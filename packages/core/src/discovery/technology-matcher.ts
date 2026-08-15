/**
 * TechnologyMatcher: Canonical multi-word, punctuation-aware, and alias-safe matching
 * for programming languages, frameworks, libraries, and developer tools.
 */

export interface TechAliasDefinition {
  canonical: string;
  aliases: string[];
  searchQuery: string;
  regexPatterns: RegExp[];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pre-compiled canonical alias dictionary
const CANONICAL_TECH_DEFINITIONS: TechAliasDefinition[] = [
  {
    canonical: 'c#',
    aliases: ['c#', 'csharp', 'c-sharp', 'cs'],
    searchQuery: '("c#" OR "csharp")',
    regexPatterns: [/(?:^|[^\w])(?:c#|csharp|c-sharp)(?:[^\w]|$)/i],
  },
  {
    canonical: 'c++',
    aliases: ['c++', 'cpp', 'cplusplus'],
    searchQuery: '("c++" OR "cpp")',
    regexPatterns: [/(?:^|[^\w])(?:c\+\+|cpp|cplusplus)(?:[^\w]|$)/i],
  },
  {
    canonical: '.net',
    aliases: ['.net', 'dotnet', 'dot-net', 'asp.net'],
    searchQuery: '(".net" OR "dotnet")',
    regexPatterns: [/(?:^|[^\w])(?:\.net|dotnet|dot-net|asp\.net)(?:[^\w]|$)/i],
  },
  {
    canonical: 'f#',
    aliases: ['f#', 'fsharp', 'f-sharp'],
    searchQuery: '("f#" OR "fsharp")',
    regexPatterns: [/(?:^|[^\w])(?:f#|fsharp|f-sharp)(?:[^\w]|$)/i],
  },
  {
    canonical: 'node.js',
    aliases: ['node.js', 'nodejs', 'node'],
    searchQuery: '("node.js" OR "nodejs")',
    regexPatterns: [/(?:^|[^\w])(?:node\.js|nodejs|\bnode\b)(?:[^\w]|$)/i],
  },
  {
    canonical: 'react native',
    aliases: ['react native', 'react-native', 'reactnative'],
    searchQuery: '("react native" OR "react-native")',
    regexPatterns: [/(?:^|[^\w])(?:react\s*native|react-native)(?:[^\w]|$)/i],
  },
  {
    canonical: 'next.js',
    aliases: ['next.js', 'nextjs', 'next'],
    searchQuery: '("next.js" OR "nextjs")',
    regexPatterns: [/(?:^|[^\w])(?:next\.js|nextjs)(?:[^\w]|$)/i],
  },
  {
    canonical: 'vue.js',
    aliases: ['vue.js', 'vuejs', 'vue', 'vue 3', 'vue 2', 'vue3', 'vue2'],
    searchQuery: '("vue.js" OR "vuejs" OR "vue")',
    regexPatterns: [/(?:^|[^\w])(?:vue\.js|vuejs|\bvue\b|vue\s*[23])(?:[^\w]|$)/i],
  },
  {
    canonical: 'opentelemetry',
    aliases: ['opentelemetry', 'otel'],
    searchQuery: '("opentelemetry" OR "otel")',
    regexPatterns: [/(?:^|[^\w])(?:opentelemetry|otel)(?:[^\w]|$)/i],
  },
  {
    canonical: 'pytorch',
    aliases: ['pytorch', 'torch'],
    searchQuery: '("pytorch" OR "torch")',
    regexPatterns: [/(?:^|[^\w])(?:pytorch|\btorch\b)(?:[^\w]|$)/i],
  },
  {
    canonical: 'webrtc',
    aliases: ['webrtc', 'web-rtc'],
    searchQuery: '("webrtc" OR "web-rtc")',
    regexPatterns: [/(?:^|[^\w])(?:webrtc|web-rtc)(?:[^\w]|$)/i],
  },
];

export class TechnologyMatcher {
  /**
   * Checks if a technical term or domain keyword matches the target text.
   * Uses canonical definitions when available, otherwise performs strict word-boundary token matching.
   */
  static matches(text: string, term: string): boolean {
    if (!text || !term) return false;
    const normalizedTerm = term.trim().toLowerCase();

    // Check predefined canonical dictionary
    const def = CANONICAL_TECH_DEFINITIONS.find(
      (d) => d.canonical === normalizedTerm || d.aliases.includes(normalizedTerm),
    );
    if (def) {
      return def.regexPatterns.some((p) => p.test(text));
    }

    // Generic multi-word or single-word token boundary matching
    const escaped = escapeRegex(normalizedTerm);
    const regex = new RegExp(`(?:^|[^\\w])${escaped}(?:[^\\w]|$)`, 'i');
    return regex.test(text);
  }

  /**
   * Generates a sanitized GitHub search query term with alias expansion.
   */
  static getSearchAliasQuery(term: string): string {
    if (!term) return '';
    const normalizedTerm = term.trim().toLowerCase();

    const def = CANONICAL_TECH_DEFINITIONS.find(
      (d) => d.canonical === normalizedTerm || d.aliases.includes(normalizedTerm),
    );
    if (def) {
      return def.searchQuery;
    }

    const clean = term.replace(/[^\w\s.+-]/g, '').trim();
    return clean ? `"${clean}"` : '';
  }
}
