export type DraftEditLike = {
  type: string;
  editorId?: string;
};

export function limitHistoryEntries<T>(entries: T[], maxEntries = 100) {
  if (entries.length <= maxEntries) {
    return entries;
  }

  return entries.slice(entries.length - maxEntries);
}

export function extractTrailingDraftEdits<T extends DraftEditLike>(
  entries: T[],
  editorId: string,
) {
  const draftEntries: T[] = [];
  let index = entries.length - 1;

  while (index >= 0) {
    const entry = entries[index];
    if (!entry || entry.type !== "draft_edit" || entry.editorId !== editorId) {
      break;
    }

    draftEntries.unshift(entry);
    index -= 1;
  }

  return {
    remainingEntries: entries.slice(0, index + 1),
    draftEntries,
  };
}
