import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { ReadLimitError } from "./read-limits";
import { parseBookFromLines, parseBookEventsFromLines } from "../core/parsing";
import type { RuleSet } from "../core/parsing";
import { decodeGb18030 } from "../core/gb18030";
import { strip } from "../core/text";

type Encoding = "utf8" | "gb18030" | "replacement";
function* fileChunks(path: string, maxBytes = Infinity, failOnLimit = false): Generator<Uint8Array> {
  const fd = openSync(path, "r"),
    buffer = new Uint8Array(64 * 1024);
  try {
    let remaining = maxBytes;
    while (remaining > 0) {
      const size = readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
      if (!size) break;
      remaining -= size;
      yield buffer.slice(0, size);
    }
    if (failOnLimit && remaining === 0 && fstatSync(fd).size > maxBytes) throw new ReadLimitError();
  } finally {
    closeSync(fd);
  }
}
function* decodedChunks(path: string, encoding: Encoding, maxBytes = Infinity, failOnLimit = false): Generator<string> {
  if (encoding !== "gb18030") {
    const decoder = new TextDecoder("utf-8", {
      fatal: encoding === "utf8",
      ignoreBOM: encoding === "replacement",
    });
    for (const chunk of fileChunks(path, maxBytes, failOnLimit))
      yield decoder.decode(chunk, { stream: true });
    // Encoding probes can end inside a codepoint. Strict bounded parsing either
    // reaches the real EOF (flush/validate) or throws at the input ceiling above.
    if (maxBytes === Infinity || failOnLimit) yield decoder.decode();
    return;
  }
  let pending = new Uint8Array(0);
  for (const chunk of fileChunks(path, maxBytes, failOnLimit)) {
    const data = new Uint8Array(pending.length + chunk.length);
    data.set(pending);
    data.set(chunk, pending.length);
    let end = 0;
    while (end < data.length) {
      const lead = data[end],
        size =
          lead < 0x80
            ? 1
            : data[end + 1] >= 0x30 && data[end + 1] <= 0x39
              ? 4
              : 2;
      if (end + size > data.length) break;
      end += size;
    }
    yield decodeGb18030(data.subarray(0, end));
    pending = data.slice(end);
  }
  if (pending.length && (maxBytes === Infinity || failOnLimit)) yield decodeGb18030(pending); // Reject a truncated final multibyte sequence.
}
export function* decodedFileLines(
  path: string,
  encoding: Encoding,
  maxBytes = Infinity,
  failOnLimit = false,
): Generator<string> {
  let pending = "";
  function* drain(final: boolean) {
    let start = 0;
    for (let i = 0; i < pending.length; i++) {
      const c = pending[i];
      if (c !== "\r" && c !== "\n") continue;
      if (!final && c === "\r" && i + 1 === pending.length) break;
      yield pending.slice(start, i);
      if (c === "\r" && pending[i + 1] === "\n") i++;
      start = i + 1;
    }
    pending = pending.slice(start);
  }
  for (const text of decodedChunks(path, encoding, maxBytes, failOnLimit)) {
    pending += text;
    yield* drain(false);
  }
  yield* drain(true);
  if (pending) yield pending;
}
function resolveEncoding(path: string, maxBytes = Infinity): Encoding {
  for (const encoding of ["utf8", "gb18030"] as const) {
    try {
      for (const _ of decodedChunks(path, encoding, maxBytes)) {
        /* Ingest validates the complete stream; previews opt into a bounded probe. */
      }
      return encoding;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  return "replacement";
}
export function parseBookFile(path: string, name: string, rules?: RuleSet) {
  return parseBookFromLines(
    decodedFileLines(path, resolveEncoding(path)),
    name,
    rules,
  );
}
/** maxBytes is preview-only: throw ReadLimitError instead of emitting a partial chapter at the ceiling. */
export function* parseBookFileEvents(
  path: string,
  name: string,
  rules?: RuleSet,
  options: { maxBytes?: number } = {},
) {
  const limit = options.maxBytes ?? Infinity;
  const probeLimit = options.maxBytes === undefined ? Infinity : Math.min(limit, 64 * 1024);
  const lines = decodedFileLines(path, resolveEncoding(path, probeLimit), limit, true);
  try { yield* parseBookEventsFromLines(lines, name, rules); }
  finally { lines.return(undefined); } // prepare/contextual hold manual iterators; close even on early return.
}
export function textFileHasContent(path: string): boolean {
  for (const line of decodedFileLines(path, resolveEncoding(path)))
    if (strip(line)) return true;
  return false;
}
