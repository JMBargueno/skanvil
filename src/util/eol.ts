/**
 * Line-ending helpers. Content is handled internally with LF and converted back to the file's
 * original line ending when written, so CRLF files are never left with mixed endings.
 *
 * @module
 */

/** A line ending. */
export type Eol = "\n" | "\r\n";

/**
 * @param text - File content.
 * @returns `"\r\n"` when the text contains any CRLF, otherwise `"\n"`.
 */
export function detectEol(text: string): Eol {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * @param text - Text with any line ending.
 * @returns The text with every CRLF converted to LF.
 */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/**
 * @param text - Text with LF line endings.
 * @param eol - Line ending to use.
 * @returns The text with every LF converted to `eol`.
 */
export function fromLf(text: string, eol: Eol): string {
  return eol === "\n" ? text : text.replace(/\n/g, "\r\n");
}

/**
 * Normalises text to LF and remembers its original line ending.
 *
 * @param text - File content.
 * @returns The LF text and the detected line ending, to pass back to {@link fromLf}.
 */
export function splitEol(text: string): { text: string; eol: Eol } {
  return { text: toLf(text), eol: detectEol(text) };
}
