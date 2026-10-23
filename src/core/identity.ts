/** The upload duplicate rule: punctuation, case and spacing never make two titles different. */
export const normalizeIdentity = (s: string | null) => (s || "").trim().toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]+/g, "");
