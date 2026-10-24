import { nowIso, type VocabularyRow } from "../db";
import { HttpError } from "../http";
import type { LibraryStorage } from "../storage";
import { vocabularyId } from "./id";
import { vocabularyInput as parseVocabularyInput, type VocabularyInput, type VocabularyWord } from "./input";

export type { VocabularyDevice, VocabularyInput, VocabularyWord } from "./input";
export interface VocabularySyncResult {
  synced: number;
  unchanged: number;
  skipped: number;
  context_found: number;
  context_not_found: number;
  context_pending: number;
}

export function vocabularyInput(value: unknown): VocabularyInput {
  try { return parseVocabularyInput(value); }
  catch { throw new HttpError(422, "生词同步数据无效"); }
}

function storedContext(word: VocabularyWord): { json: string | null; state: string } {
  if (!word.context) return { json: null, state: "pending" };
  return { json: JSON.stringify(word.context), state: word.context.sentence.trim() ? "found" : "not_found" };
}

export function syncVocabulary(library: LibraryStorage, value: unknown): VocabularySyncResult {
  const { device, words } = vocabularyInput(value), now = nowIso();
  const result: VocabularySyncResult = { synced: 0, unchanged: 0, skipped: 0, context_found: 0, context_not_found: 0, context_pending: 0 };
  for (const word of words) {
    try {
      const id = vocabularyId(device.id, word.raw_word, word.looked_up_at, word.lookup_id), existing = library.db.getVocabulary(id);
      const context = storedContext(word);
      const row: VocabularyRow = {
        id,
        device_id: device.id,
        device_kind: device.kind,
        device_name: device.name,
        word: word.word,
        raw_word: word.raw_word,
        lang: word.lang,
        book_id: word.book_id,
        source_title: word.source_title,
        looked_up_at: word.looked_up_at,
        device_context_json: word.context ? context.json : null,
        context_json: existing?.context_json ?? context.json,
        context_state: existing?.context_json ? existing.context_state : context.state,
        push_state: existing?.push_state ?? "pending",
        push_status_json: existing?.push_status_json ?? null,
        pushed_at: existing?.pushed_at ?? null,
        created_at: existing?.created_at ?? now,
        updated_at: now,
      };
      library.db.upsertVocabulary(row);
      if (existing) result.unchanged++; else result.synced++;
      const state = library.db.getVocabulary(id)?.context_state ?? context.state;
      if (state === "found") result.context_found++;
      else if (state === "not_found") result.context_not_found++;
      else result.context_pending++;
    } catch {
      result.skipped++;
    }
  }
  return result;
}
