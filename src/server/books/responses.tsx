import stylesheet from "../../styles.css?url";
import bookStylesheet from "../../features/books/books.css?url";
import { renderToString } from "@solidjs/web";
import { BookEditor } from "../../features/books/book-editor";
import { BookDetail } from "../../features/books/book-detail";
import type { BookPage } from "./service";
import {
  HttpError,
  requireBook,
  redirectWithToast,
  setToastHeader,
} from "../http";
import { redirect } from "../auth-http";
import {
  saveBookEdit,
  fetchBookMetadata,
  setReadStatus,
  archiveBook,
  restoreBook,
  deleteBook,
  textField,
  loadBookPage,
} from "./service";
import {
  downloadCoverFromUrl,
  extractBookCover,
  replaceCover,
  uploadedCover,
  MAX_COVER_BYTES,
} from "./covers";
import { safeInternalTarget } from "../../features/books/navigation";
import type { ApiContext } from "../http";
import type { Fetch } from "./metadata-lookup";

type Context = ApiContext<{ book_id: string }>;
const jsonRequest = (request: Request) =>
  request.headers.get("Accept")?.includes("application/json");
function bookRedirect(target: string) {
  // Starlette RedirectResponse quotes Unicode/spaces while preserving URL escapes.
  return redirect(
    target.replace(/[^a-zA-Z0-9_\-.~/%#?=:;&@!$'()*+,\[\]]/gu, (char) =>
      encodeURIComponent(char),
    ),
  );
}
const htmx = (request: Request) => request.headers.get("HX-Request") === "true";
export async function bookForm(request: Request): Promise<FormData> {
  const max = MAX_COVER_BYTES + 2 * 1024 * 1024;
  if (Number(request.headers.get("Content-Length")) > max)
    throw new HttpError(413, "表单内容过大");
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) {
          await reader.cancel();
          throw new HttpError(413, "表单内容过大");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  try {
    return await new Response(Buffer.concat(chunks), {
      headers: {
        "Content-Type":
          request.headers.get("Content-Type") ||
          "application/x-www-form-urlencoded",
      },
    }).formData();
  } catch {
    throw new HttpError(400, "表单格式错误");
  }
}
function htmlPage(page: BookPage, edit: boolean, partial = false): Response {
  const body = renderToString(() =>
    edit ? <BookEditor page={page} /> : <BookDetail page={page} />,
  );
  return new Response(
    partial
      ? body
      : `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>编辑 · Bindery</title><link rel="stylesheet" href="${stylesheet}"><link rel="stylesheet" href="${bookStylesheet}"><body>${body}</body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}
export function editGetResponse({
  request,
  params,
  library,
}: Context): Response {
  return htmlPage(
    loadBookPage(
      params.book_id,
      new URL(request.url).searchParams.get("return_to"),
      library,
    ),
    true,
    true,
  );
}
export async function editResponse({
  request,
  params,
  library,
}: Context): Promise<Response> {
  requireBook(params.book_id, library);
  const result = await saveBookEdit(
    params.book_id,
    await bookForm(request),
    library,
  );
  if (!result.message)
    return jsonRequest(request)
      ? Response.json({ page: result.page })
      : htmlPage(result.page, true, htmx(request));
  const target = result.page.navigation.detail_url;
  if (jsonRequest(request)) return Response.json({ ...result, target });
  if (htmx(request)) {
    const response = htmlPage(result.page, false, true);
    setToastHeader(response, result.message, result.kind);
    return response;
  }
  return redirectWithToast(target, result.message, result.kind);
}
export async function metadataResponse(
  { request, params, library }: Context,
  fetcher: Fetch = fetch,
): Promise<Response> {
  requireBook(params.book_id, library);
  const page = await fetchBookMetadata(
    params.book_id,
    await bookForm(request),
    library,
    fetcher,
  );
  return jsonRequest(request)
    ? Response.json({ page })
    : htmlPage(page, true, htmx(request));
}
export async function readResponse({
  request,
  params,
  library,
}: Context): Promise<Response> {
  requireBook(params.book_id, library);
  const form = await bookForm(request);
  setReadStatus(params.book_id, textField(form, "read"), library);
  const target = safeInternalTarget(
    textField(form, "next"),
    `/book/${params.book_id}`,
  );
  if (htmx(request))
    return htmlPage(
      loadBookPage(
        params.book_id,
        new URL(target, "http://local").searchParams.get("return_to"),
        library,
      ),
      false,
      true,
    );
  return bookRedirect(target);
}
export async function archiveResponse({
  request,
  params,
  library,
}: Context): Promise<Response> {
  requireBook(params.book_id, library);
  const form = await bookForm(request);
  archiveBook(params.book_id, library);
  return bookRedirect(safeInternalTarget(textField(form, "next")));
}
export function restoreResponse({ params, library }: Context): Response {
  restoreBook(params.book_id, library);
  return redirect("/");
}
export async function deleteResponse({
  request,
  params,
  library,
}: Context): Promise<Response> {
  const form = await bookForm(request);
  deleteBook(params.book_id, library);
  return htmx(request)
    ? new Response("", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    : bookRedirect(safeInternalTarget(textField(form, "next")));
}
export async function uploadCoverResponse({
  request,
  params,
  library,
}: Context): Promise<Response> {
  requireBook(params.book_id, library);
  const form = await bookForm(request),
    file = form.get("cover");
  if (!(file instanceof File)) throw new HttpError(422, "缺少封面文件");
  replaceCover(params.book_id, await uploadedCover(file), file.name, library);
  return redirect(`/book/${params.book_id}`);
}
export async function urlCoverResponse(
  { request, params, library }: Context,
  fetcher: Fetch = fetch,
): Promise<Response> {
  requireBook(params.book_id, library);
  const form = await bookForm(request),
    { data, filename } = await downloadCoverFromUrl(
      textField(form, "cover_url"),
      fetcher,
    );
  replaceCover(params.book_id, data, filename, library);
  return redirect(`/book/${params.book_id}`);
}
export function extractCoverResponse({ params, library }: Context): Response {
  extractBookCover(params.book_id, library);
  return redirect(`/book/${params.book_id}`);
}
