/** A caller-imposed preview budget was exhausted, not a malformed book. */
export class ReadLimitError extends Error {
  constructor() { super("文件过大，无法预览第一页"); this.name = "ReadLimitError"; }
}
