/**
 * Text from a pack as it may reach the terminal: every control character (ESC sequences start with one) and every Unicode format
 * character (zero-width, bidi controls, word joiner, soft hyphen, tag characters...) is removed; those change how a line reads without showing.
 */
export const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").replace(/\p{Cf}/gu, "");
