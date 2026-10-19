export const missingDetails = { book: "书籍不存在", rule: "规则不存在", theme: "主题不存在", job: "任务不存在", wish: "追踪条目不存在" } as const;
export type MissingEntity = keyof typeof missingDetails;
