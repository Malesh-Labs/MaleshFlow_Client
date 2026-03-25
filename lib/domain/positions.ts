import { DEFAULT_POSITION_GAP } from "./constants";

export function sortByPosition<T extends { position: number }>(items: T[]) {
  return [...items].sort((left, right) => left.position - right.position);
}

export function getAppendPosition(lastPosition?: number | null) {
  if (lastPosition === undefined || lastPosition === null) {
    return DEFAULT_POSITION_GAP;
  }

  return lastPosition + DEFAULT_POSITION_GAP;
}

export function getPositionBetween(
  before?: number | null,
  after?: number | null,
) {
  if (before === undefined || before === null) {
    if (after === undefined || after === null) {
      return DEFAULT_POSITION_GAP;
    }

    return after / 2;
  }

  if (after === undefined || after === null) {
    return before + DEFAULT_POSITION_GAP;
  }

  return (before + after) / 2;
}

export function needsSiblingRenormalization(
  before?: number | null,
  after?: number | null,
) {
  if (before === undefined || before === null) {
    return after !== undefined && after !== null && after <= 1;
  }

  if (after === undefined || after === null) {
    return false;
  }

  return after - before < 1;
}

export function buildRenormalizedPositions(ids: string[]) {
  return ids.map((id, index) => ({
    id,
    position: (index + 1) * DEFAULT_POSITION_GAP,
  }));
}
