// Letters that draw nothing (fillers and the braille blank): a name or a command made of them reads as empty or as something else.
const BLANK_LETTERS = /[\u115f\u1160\u3164\uffa0\u2800]/g;
// A surrogate that is not half of a pair is not a character at all; terminals and fonts show it however they like.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
// Line and paragraph separators break a line in some displays and not in others.
const LINE_SEPARATORS = /[\u2028\u2029]/g;

/**
 * Text from a pack as it may reach the terminal: every control character (ESC sequences start with one) and every Unicode format
 * character (zero-width, bidi controls, word joiner, soft hyphen, tag characters...) is removed; those change how a line reads without showing.
 * So are the letters that draw nothing (U+115F, U+1160, U+3164, U+FFA0, U+2800), line and paragraph separators and lone surrogates.
 */
export const printable = (text: string) =>
  text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/\p{Cf}/gu, "")
    .replace(LINE_SEPARATORS, "")
    .replace(BLANK_LETTERS, "")
    .replace(LONE_SURROGATE, "");

/**
 * Whether `text` has anything that `printable` would remove, or a space that is not the ASCII one (no-break, ideographic... they pass
 * `printable`, which is for display, but a command or a file name must be exactly what the user read, spaces included).
 */
export const hidesText = (text: string) => printable(text) !== text || /(?! )\p{Z}/u.test(text);
