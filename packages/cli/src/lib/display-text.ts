import { escapeProjectText } from "./engine/pi-trust";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The lines of text a model, tool or engine supplied, each escaped (see `escapeProjectText`); real newlines are kept as the line breaks. */
export const escapedLines = (text: string): string[] => text.split("\n").map(escapeProjectText);

/** The text with every control, escape and invisible character shown as a visible escape; newlines and tabs stay as they are. */
export const escapeTranscriptText = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.split("\t").map(escapeProjectText).join("\t"))
    .join("\n");

/**
 * One line cut into rows no wider than `width` terminal columns (a CJK character or an emoji counts two), never inside a character
 * and without dropping any: a row ends after a space when there is one in its second half, so words stay whole where they can.
 * A character wider than the whole width gets a row of its own. An empty line is one empty row.
 */
export function wrapByWidth(line: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  let row: { text: string; cells: number }[] = [];
  let used = 0;
  // How many characters of the row end at the last space, and the columns they take.
  let breakAt = 0;
  let breakCells = 0;

  const text = (parts: { text: string }[]) => parts.map((part) => part.text).join("");

  for (const { segment } of segmenter.segment(line)) {
    const cells = Bun.stringWidth(segment);
    if (used > 0 && used + cells > limit) {
      const atSpace = breakAt > 0 && breakCells * 2 >= limit;
      const keep = atSpace ? breakAt : row.length;
      rows.push(text(row.slice(0, keep)));
      row = row.slice(keep);
      used = row.reduce((sum, part) => sum + part.cells, 0);
      breakAt = 0;
      breakCells = 0;
    }
    row.push({ text: segment, cells });
    used += cells;
    if (/^\s+$/.test(segment)) {
      breakAt = row.length;
      breakCells = used;
    }
  }

  rows.push(text(row));
  return rows;
}

/** The text as rows to draw: escaped, split on its real newlines, each line hard-wrapped to `width` columns. */
export const wrappedRows = (text: string, width: number): string[] => escapedLines(text).flatMap((line) => wrapByWidth(line, width));
