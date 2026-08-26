import { MAX_QUERY_CHARS, MAX_QUERY_TOKENS } from "./constants.js";

const WORD = /[A-Za-z0-9_./@:+-]+/g;

export function tokenize(value, { maxCharacters = Infinity, maxTokens = Infinity } = {}) {
  const tokens = [];
  const bounded = String(value ?? "").slice(0, maxCharacters);
  const append = (token) => {
    if (tokens.length >= maxTokens) return false;
    tokens.push(token);
    return tokens.length < maxTokens;
  };
  for (const match of bounded.matchAll(WORD)) {
    const exact = match[0].toLowerCase();
    if (!append(exact)) break;
    const pathParts = exact.split(/[\/.@:+-]+/).filter(Boolean);
    for (const part of pathParts) {
      if (part !== exact && !append(part)) break;
      const snakeParts = part.split("_").filter(Boolean);
      for (const snake of snakeParts) {
        if (snake !== part && !append(snake)) break;
      }
      if (tokens.length >= maxTokens) break;
    }
    if (tokens.length >= maxTokens) break;
    const camel = match[0]
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (camel.length > 1) {
      for (const part of camel) {
        if (!append(part)) break;
      }
    }
    if (tokens.length >= maxTokens) break;
  }
  return tokens;
}

function frequencies(tokens) {
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return counts;
}

export class RecallIndex {
  constructor({ loadRows }) {
    this.loadRows = loadRows;
    this.documents = [];
    this.dirty = true;
  }

  markDirty() {
    this.dirty = true;
  }

  rebuild() {
    this.documents = this.loadRows().map((row) => {
      const tokens = tokenize(row.content);
      return { row, tokens, frequencies: frequencies(tokens), length: Math.max(1, tokens.length) };
    });
    this.dirty = false;
  }

  search({ query = "", allowedCategories, candidateAllowed = () => true, limit = 20 }) {
    if (this.dirty) this.rebuild();
    const allowed = new Set(allowedCategories);
    const candidates = this.documents.filter(({ row }) => allowed.has(row.category) && candidateAllowed(row));
    if (!String(query ?? "").trim()) {
      return candidates
        .sort((a, b) => b.row.created_at.localeCompare(a.row.created_at))
        .slice(0, limit)
        .map(({ row }) => row);
    }

    const queryTokens = [...new Set(tokenize(query, {
      maxCharacters: MAX_QUERY_CHARS,
      maxTokens: MAX_QUERY_TOKENS,
    }))];
    if (!queryTokens.length || !candidates.length) return [];
    const averageLength = candidates.reduce((sum, doc) => sum + doc.length, 0) / candidates.length;
    const documentFrequency = new Map();
    for (const token of queryTokens) {
      documentFrequency.set(token, candidates.filter((doc) => doc.frequencies.has(token)).length);
    }
    const k1 = 1.2;
    const b = 0.75;
    return candidates
      .map((doc) => {
        let score = 0;
        for (const token of queryTokens) {
          const tf = doc.frequencies.get(token) ?? 0;
          if (!tf) continue;
          const df = documentFrequency.get(token);
          const idf = Math.log(1 + (candidates.length - df + 0.5) / (df + 0.5));
          score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (doc.length / averageLength))));
        }
        return { row: doc.row, score };
      })
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || right.row.created_at.localeCompare(left.row.created_at))
      .slice(0, limit)
      .map(({ row }) => row);
  }
}
