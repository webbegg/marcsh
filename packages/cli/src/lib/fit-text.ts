const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `text` cut to at most `cells` terminal cells, ending with `…` when it had to be cut. Characters are measured with
 * Bun.stringWidth (a wide character or emoji is two cells) and never split. Text that fits is returned as it is.
 */
export function fitText(text: string, cells: number): string {
  if (cells <= 0) return "";
  if (Bun.stringWidth(text) <= cells) return text;
  const room = cells - 1;
  let out = "";
  let used = 0;
  for (const { segment } of segmenter.segment(text)) {
    const width = Bun.stringWidth(segment);
    if (used + width > room) break;
    out += segment;
    used += width;
  }
  return `${out}…`;
}
