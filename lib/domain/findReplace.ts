export function countLiteralOccurrences(text: string, find: string) {
  if (find.length === 0) {
    return 0;
  }

  let count = 0;
  let searchFrom = 0;

  while (searchFrom <= text.length - find.length) {
    const matchIndex = text.indexOf(find, searchFrom);
    if (matchIndex === -1) {
      break;
    }

    count += 1;
    searchFrom = matchIndex + find.length;
  }

  return count;
}

export function replaceLiteralOccurrences(
  text: string,
  find: string,
  replace: string,
) {
  const occurrenceCount = countLiteralOccurrences(text, find);
  if (occurrenceCount === 0) {
    return null;
  }

  const value = text.split(find).join(replace);
  if (value === text) {
    return null;
  }

  return {
    value,
    occurrenceCount,
  };
}
