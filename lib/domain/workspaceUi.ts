export type CommandPalettePage = {
  _id: string;
  title: string;
  archived: boolean;
  position: number;
  createdAt?: number;
  updatedAt?: number;
  searchTerms?: string[];
};

function normalizeQuery(value: string) {
  return value.trim().toLowerCase();
}

function titleScore(title: string, query: string) {
  const normalizedTitle = title.toLowerCase();
  if (normalizedTitle.startsWith(query)) {
    return 0;
  }

  const wordStartPattern = new RegExp(`\\b${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  if (wordStartPattern.test(normalizedTitle)) {
    return 1;
  }

  if (normalizedTitle.includes(query)) {
    return 2;
  }

  return Number.POSITIVE_INFINITY;
}

function metadataScore(terms: string[] | undefined, query: string) {
  if (!terms || terms.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  let bestScore = Number.POSITIVE_INFINITY;
  for (const term of terms) {
    const score = titleScore(term, query);
    if (score < bestScore) {
      bestScore = score;
    }
  }

  return bestScore === Number.POSITIVE_INFINITY ? bestScore : bestScore + 3;
}

function pageSearchScore(page: CommandPalettePage, query: string) {
  return Math.min(
    titleScore(page.title, query),
    metadataScore(page.searchTerms, query),
  );
}

function getPageRecency(page: CommandPalettePage) {
  return page.updatedAt ?? page.createdAt ?? Number.NEGATIVE_INFINITY;
}

export function filterPagesForCommandPalette<T extends CommandPalettePage>(
  pages: T[],
  query: string,
  limit = 12,
) {
  const normalizedQuery = normalizeQuery(query);
  const results =
    normalizedQuery.length === 0
      ? [...pages]
      : pages.filter((page) => pageSearchScore(page, normalizedQuery) !== Number.POSITIVE_INFINITY);

  return results
    .sort((left, right) => {
      if (normalizedQuery.length > 0) {
        const leftScore = pageSearchScore(left, normalizedQuery);
        const rightScore = pageSearchScore(right, normalizedQuery);
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
      }

      if (left.archived !== right.archived) {
        return left.archived ? 1 : -1;
      }

      const leftRecency = getPageRecency(left);
      const rightRecency = getPageRecency(right);
      if (leftRecency !== rightRecency) {
        return rightRecency - leftRecency;
      }

      if (left.position !== right.position) {
        return left.position - right.position;
      }

      return left.title.localeCompare(right.title);
    })
    .slice(0, limit);
}

export function buildNodeSelectionIds(
  orderedNodeIds: string[],
  anchorNodeId: string,
  currentNodeId: string,
) {
  const anchorIndex = orderedNodeIds.indexOf(anchorNodeId);
  const currentIndex = orderedNodeIds.indexOf(currentNodeId);
  if (anchorIndex === -1 || currentIndex === -1) {
    return new Set<string>(anchorNodeId === currentNodeId ? [anchorNodeId] : []);
  }

  const start = Math.min(anchorIndex, currentIndex);
  const end = Math.max(anchorIndex, currentIndex);
  return new Set(orderedNodeIds.slice(start, end + 1));
}
