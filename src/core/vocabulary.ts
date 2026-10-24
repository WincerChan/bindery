// Selection punctuation (quotes, brackets, commas, CJK punctuation) is not part of a word.
// Internal punctuation such as an apostrophe or hyphen stays intact.
const EDGE = /^[\p{P}\p{Z}\s\u200b-\u200d\ufeff]+|[\p{P}\p{Z}\s\u200b-\u200d\ufeff]+$/gu;

export function cleanVocabularyWord(value: string): string {
  return value.replace(EDGE, "").trim();
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
export const isCjkWord = (word: string): boolean => CJK.test(word);

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive Latin matching; CJK has no reliable word boundaries. */
export function vocabularyPattern(word: string): RegExp {
  const escaped = escapeRegExp(word);
  return isCjkWord(word)
    ? new RegExp(escaped, "giu")
    : new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
}
