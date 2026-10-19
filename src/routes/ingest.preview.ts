import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute, HttpError } from "../server/http";
import { formFiles, formText } from "../server/ingest/actions";
import { uploadForm } from "../server/ingest/multipart";
import { previewUploads } from "../server/ingest/preview";
export const Route = createFileRoute("/ingest/preview")({ server: { handlers: { POST: authenticatedRoute(async ({ request, library }) => {
  const parsed = await uploadForm(request, library);
  try {
  const form = parsed.form, files = formFiles(form, "files");
  if (!files.length) throw new HttpError(422, "Field required");
  const previews = await previewUploads(library, files, formText(form, "rule_template", "default"));
  if (request.headers.get("Accept")?.includes("application/json")) return Response.json(previews);
  return new Response((await import("../server/ingest/render")).renderPreviews(previews), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } finally { parsed.cleanup(); }
}) } } });
