import { renderToString } from "@solidjs/web";
import { Editor, RulePreview } from "../../features/catalog/editors";
import type { EditorData, RulePreviewData } from "./templates";

const html = (body: string) => new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
export const editorResponse = (data: EditorData, kind: "rules" | "themes") => html(renderToString(() => <Editor data={data} kind={kind} />));
export const previewResponse = (data: RulePreviewData) => html(renderToString(() => <RulePreview preview={data} />));
