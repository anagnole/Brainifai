/** Strip ANSI escape codes from text. */
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b\[\??\d*[hlm]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}
