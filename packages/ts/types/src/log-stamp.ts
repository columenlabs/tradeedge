// Runner log times. The runner's lines carry no time, so the Worker stamps each new line of the
// running job's log tail with the UTC second it first saw it (`2026-10-07T18:05:01Z <line>`), and
// researchedge shows that time. A line the runner stamps itself one day is shown as it is.

const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) /;

const lines = (text: string) => text.split('\n').filter((l) => l !== '');

/** One stamped line's time (ISO, UTC) and its text without the stamp. */
export function splitStamp(line: string): { at: string | null; text: string } {
  const m = STAMP.exec(line);
  return m?.[1] ? { at: m[1], text: line.slice(m[0].length) } : { at: null, text: line };
}

/**
 * Where `prev` (the raw lines seen before) ends inside `next` (the new raw lines): the count of
 * `next` lines already seen. A tail is the log's last few KB, so its first line may be cut short.
 */
function seenCount(prev: string[], next: string[]): number {
  for (let k = Math.min(prev.length, next.length); k > 0; k--) {
    const head = next[0] ?? '';
    const start = prev.length - k;
    if (!(prev[start] ?? '').endsWith(head)) continue;
    let same = true;
    for (let i = 1; i < k && same; i++) same = next[i] === prev[start + i];
    if (same) return k;
  }
  return 0;
}

/** The new tail with every line stamped: lines seen before keep their time, new ones get `now`. */
export function stampTail(prevStamped: string | null, nextRaw: string, now: Date): string {
  const prev = lines(prevStamped ?? '').map(splitStamp);
  const next = lines(nextRaw);
  const seen = seenCount(
    prev.map((p) => p.text),
    next,
  );
  const stamp = `${now.toISOString().slice(0, 19)}Z`;
  return next
    .map((line, i) => {
      if (STAMP.test(line)) return line;
      const at = i < seen ? prev[prev.length - seen + i]?.at : null;
      return `${at ?? stamp} ${line}`;
    })
    .join('\n');
}

/**
 * A finished job's full log with the times the stamped tail knows: the tail is the log's end, so
 * its lines line up with the last lines of the log. Earlier lines have no time.
 */
export function timesFor(
  fullRaw: string,
  stampedTail: string | null,
): { at: string | null; text: string }[] {
  const full = lines(fullRaw).map(splitStamp);
  const tail = lines(stampedTail ?? '').map(splitStamp);
  const seen = seenCount(
    full.map((f) => f.text),
    tail.map((t) => t.text),
  );
  const from = full.length - seen;
  return full.map((f, i) =>
    f.at || i < from ? f : { at: tail[i - from]?.at ?? null, text: f.text },
  );
}
