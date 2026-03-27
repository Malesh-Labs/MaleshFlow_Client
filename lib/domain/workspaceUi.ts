export type CommandPalettePage = {
  _id: string;
  title: string;
  archived: boolean;
  position: number;
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

export function filterPagesForCommandPalette<T extends CommandPalettePage>(
  pages: T[],
  query: string,
  limit = 12,
) {
  const normalizedQuery = normalizeQuery(query);
  const results =
    normalizedQuery.length === 0
      ? [...pages]
      : pages.filter((page) => titleScore(page.title, normalizedQuery) !== Number.POSITIVE_INFINITY);

  return results
    .sort((left, right) => {
      if (normalizedQuery.length > 0) {
        const leftScore = titleScore(left.title, normalizedQuery);
        const rightScore = titleScore(right.title, normalizedQuery);
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
      }

      if (left.archived !== right.archived) {
        return left.archived ? 1 : -1;
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
