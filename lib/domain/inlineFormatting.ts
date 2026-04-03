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
