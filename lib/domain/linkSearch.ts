// Scoring for the inline [[ link autocomplete. Lower scores are better; a
// score of Number.POSITIVE_INFINITY means "no match". Tiers, best to worst:
//   0 — query is a prefix of the text
//   1 — query matches at a word start
//   2 — query appears as a contiguous substring
//   3 — every query word matches at some word start ("go cof" → "go to coffee shop")
//   4 — query characters appear in order, not necessarily adjacent
//       ("cofsho" → "coffee shop")
// Ties are broken by the callers (text length, then recency/position).

export function normalizeLinkSearchQuery(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesAtWordStart(text: string, token: string) {
  return new RegExp(`\\b${escapeRegExp(token)}`).test(text);
}

function isCharacterSubsequence(query: string, text: string) {
  let queryIndex = 0;
  for (let textIndex = 0; textIndex < text.length && queryIndex < query.length; textIndex += 1) {
    if (text[textIndex] === query[queryIndex]) {
      queryIndex += 1;
    }
  }
  return queryIndex === query.length;
}

export function linkSearchScore(text: string, query: string) {
  if (query.length === 0) {
    return 0;
  }

  const normalizedText = text.toLowerCase();
  if (normalizedText.startsWith(query)) {
    return 0;
  }
  if (matchesAtWordStart(normalizedText, query)) {
    return 1;
  }
  if (normalizedText.includes(query)) {
    return 2;
  }

  const queryWords = query.split(" ").filter((word) => word.length > 0);
  if (
    queryWords.length > 1 &&
    queryWords.every((word) => matchesAtWordStart(normalizedText, word))
  ) {
    return 3;
  }

  const compactQuery = query.replace(/ /g, "");
  if (compactQuery.length >= 3 && isCharacterSubsequence(compactQuery, normalizedText)) {
    return 4;
  }

  return Number.POSITIVE_INFINITY;
}
