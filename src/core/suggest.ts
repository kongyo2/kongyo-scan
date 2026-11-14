/**
 * Typo suggestions. A suggestion is offered only when it is close to what was
 * typed; a far guess is worse than none.
 */

function distance(a: string, b: string): number {
  const rows = a.length + 1;
  const columns = b.length + 1;
  let previous = Array.from({ length: columns }, (_, index) => index);
  for (let row = 1; row < rows; row++) {
    const current = [row];
    for (let column = 1; column < columns; column++) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + cost,
      );
    }
    previous = current;
  }
  return previous[columns - 1]!;
}

/** At most one close alternative; never a guess that is far from what was typed. */
export function closest(input: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const d = distance(input, candidate);
    if (d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  const limit = input.length <= 3 ? 1 : input.length <= 8 ? 2 : 3;
  return best !== undefined && bestDistance <= limit ? best : undefined;
}
