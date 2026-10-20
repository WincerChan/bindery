import { createFileRoute } from "@tanstack/solid-router";
import { authenticatedRoute, HttpError } from "../server/http";
import { jobsPayload } from "../server/ingest/queries";
export const Route = createFileRoute("/jobs/partial")({ server: { handlers: { GET: authenticatedRoute(async ({ request, library }) => {
  const query = new URL(request.url).searchParams, raw = query.get("page") || "1";
  if (!/^[+-]?\d+(?:\.0+)?$/.test(raw.trim())) throw new HttpError(422, "Input should be a valid integer");
  const data = jobsPayload(library, query.get("tab") || "all", Number(raw));
  if (request.headers.get("Accept")?.includes("application/json")) return Response.json(data);
  return new Response((await import("../server/ingest/render")).renderJobs(data), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}) } } });
