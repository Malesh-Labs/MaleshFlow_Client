export type InlineFormattingState = {
  strike: boolean;
  italic: boolean;
  bold: boolean;
};

export type InlineTextSegment = {
  key: string;
  text: string;
  strike: boolean;
  italic: boolean;
  bold: boolean;
};

export type InlineFormattingShortcutMarker = "__" | "**";

const DEFAULT_STATE: InlineFormattingState = {
  strike: false,
  italic: false,
  bold: false,
};

const FORMAT_MARKERS = [
  {
    token: "~~",
    field: "strike",
  },
  {
    token: "__",
    field: "italic",
  },
  {
    token: "**",
    field: "bold",
  },
] as const;

export function splitTextForInlineFormatting(
  text: string,
  initialState: InlineFormattingState = DEFAULT_STATE,
) {
  const segments: InlineTextSegment[] = [];
  let remaining = text;
  let state: InlineFormattingState = { ...initialState };
  let index = 0;

  while (remaining.length > 0) {
    let nextMarker:
      | {
          token: string;
          field: keyof InlineFormattingState;
          index: number;
        }
      | null = null;

    for (const marker of FORMAT_MARKERS) {
      const markerIndex = remaining.indexOf(marker.token);
      if (markerIndex === -1) {
        continue;
      }

      if (!nextMarker || markerIndex < nextMarker.index) {
        nextMarker = {
          token: marker.token,
          field: marker.field,
          index: markerIndex,
        };
      }
    }

    if (!nextMarker) {
      segments.push({
        key: `text:${index}`,
        text: remaining,
        ...state,
      });
      break;
    }

    const before = remaining.slice(0, nextMarker.index);
    if (before.length > 0) {
      segments.push({
        key: `text:${index}`,
        text: before,
        ...state,
      });
      index += 1;
    }

    remaining = remaining.slice(nextMarker.index + nextMarker.token.length);
    state = {
      ...state,
      [nextMarker.field]: !state[nextMarker.field],
    };
  }

  return {
    segments,
    nextState: state,
  };
}

export function hasRenderableInlineFormatting(text: string) {
  const { segments } = splitTextForInlineFormatting(text);
  return segments.some((segment) => segment.strike || segment.italic || segment.bold);
}

export function applySelectedInlineFormattingShortcut(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  marker: InlineFormattingShortcutMarker,
) {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd));
  const end = Math.max(start, Math.max(selectionStart, selectionEnd));
  if (start === end) {
    return null;
  }

  const selectedText = text.slice(start, end);
  const isWrapped =
    selectedText.startsWith(marker) &&
    selectedText.endsWith(marker) &&
    selectedText.length >= marker.length * 2;
  const replacement = isWrapped
    ? selectedText.slice(marker.length, selectedText.length - marker.length)
    : `${marker}${selectedText}${marker}`;
  const selectionOffset = isWrapped ? 0 : marker.length;

  return {
    value: `${text.slice(0, start)}${replacement}${text.slice(end)}`,
    selectionStart: start + selectionOffset,
    selectionEnd: start + selectionOffset + replacement.length - selectionOffset * 2,
  };
}
