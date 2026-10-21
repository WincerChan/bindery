import { closeSync, openSync, readSync } from "node:fs";
import { parseBookFromLines, parseBookEventsFromLines } from "../core/parsing";
import type { RuleSet } from "../core/parsing";
import { decodeGb18030 } from "../core/gb18030";
import { strip } from "../core/text";

type Encoding = "utf8" | "gb18030" | "replacement";
function* fileChunks(path: string): Generator<Uint8Array> {
  const fd = openSync(path, "r"),
    buffer = new Uint8Array(64 * 1024);
  try {
    for (let size = readSync(fd, buffer); size > 0; size = readSync(fd, buffer))
      yield buffer.slice(0, size);
  } finally {
    closeSync(fd);
  }
}
function* decodedChunks(path: string, encoding: Encoding): Generator<string> {
  if (encoding !== "gb18030") {
    const decoder = new TextDecoder("utf-8", {
      fatal: encoding === "utf8",
      ignoreBOM: encoding === "replacement",
    });
    for (const chunk of fileChunks(path))
      yield decoder.decode(chunk, { stream: true });
    yield decoder.decode();
    return;
  }
  let pending = new Uint8Array(0);
  for (const chunk of fileChunks(path)) {
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
  if (pending.length) yield decodeGb18030(pending); // Reject a truncated final multibyte sequence.
}
export function* decodedFileLines(
  path: string,
  encoding: Encoding,
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
  for (const text of decodedChunks(path, encoding)) {
    pending += text;
    yield* drain(false);
  }
  yield* drain(true);
  if (pending) yield pending;
}
function resolveEncoding(path: string): Encoding {
  for (const encoding of ["utf8", "gb18030"] as const) {
    try {
      for (const _ of decodedChunks(path, encoding)) {
        /* Validate the complete stream before yielding a header. */
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
export function* parseBookFileEvents(
  path: string,
  name: string,
  rules?: RuleSet,
) {
  yield* parseBookEventsFromLines(
    decodedFileLines(path, resolveEncoding(path)),
    name,
    rules,
  );
}
export function textFileHasContent(path: string): boolean {
  for (const line of decodedFileLines(path, resolveEncoding(path)))
    if (strip(line)) return true;
  return false;
}
