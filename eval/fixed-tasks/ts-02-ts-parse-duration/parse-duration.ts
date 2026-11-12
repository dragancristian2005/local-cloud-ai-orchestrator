const UNIT_SECONDS: Record<string, number> = { h: 3600, m: 60, s: 1 };

/**
 * Parse a duration such as "1h30m", "45s" or "2h" into seconds.
 * Throws on anything else, including an empty string.
 */
export function parseDuration(text: string): number {
  const pattern = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const match = pattern.exec(text.trim());
  if (!match || text.trim() === "") {
    throw new Error(`invalid duration: ${text}`);
  }
  const [, hours, minutes, seconds] = match;
  return (
    Number(hours ?? 0) * UNIT_SECONDS.h! +
    Number(minutes ?? 0) * UNIT_SECONDS.m! +
    Number(seconds ?? 0) * UNIT_SECONDS.s!
  );
}
