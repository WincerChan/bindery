import { createServerFn } from "@tanstack/solid-start";
import { authenticated } from "../../server/functions";
import { bookFormInput } from "../../shared/mutation-input";
import { safeInternalTarget } from "./navigation";

export const saveBook = createServerFn({ method: "POST" }).middleware([authenticated]).validator(bookFormInput)
  .handler(async ({ context, data }) => (await import("../../server/books/service")).saveBookEdit(String(data.get("book_id")), data, context.library));
export const lookupBook = createServerFn({ method: "POST" }).middleware([authenticated]).validator(bookFormInput)
  .handler(async ({ context, data }) => (await import("../../server/books/service")).fetchBookMetadata(String(data.get("book_id")), data, context.library));
export const mutateBook = createServerFn({ method: "POST" }).middleware([authenticated])
  .validator((data: FormData) => {
    const form = bookFormInput(data);
    if (!["read", "archive", "delete", "regenerate", "url", "extract", "upload"].includes(String(form.get("action")))) throw new Error("操作类型错误");
    return form;
  })
  .handler(async ({ context, data: form }) => {
    const service = await import("../../server/books/service"), action = form.get("action"), id = String(form.get("book_id")), library = context.library;
    const { requireBook, HttpError } = await import("../../server/http");
    requireBook(id, library);
    if (action === "read") service.setReadStatus(id, service.textField(form, "read"), library);
    else if (action === "archive") service.archiveBook(id, library);
    else if (action === "delete") service.deleteBook(id, library);
    else if (action === "regenerate") {
      const response = (await import("../../server/ingest/actions")).regenerateBook(library, id, form);
      return { target: response.headers.get("Location")! };
    } else {
      const covers = await import("../../server/books/covers");
      if (action === "extract") covers.extractBookCover(id, library);
      else if (action === "url") {
        const cover = await covers.downloadCoverFromUrl(service.textField(form, "cover_url"));
        covers.replaceCover(id, cover.data, cover.filename, library);
      } else {
        const file = form.get("cover");
        if (!(file instanceof File)) throw new HttpError(422, "缺少封面文件");
        covers.replaceCover(id, await covers.uploadedCover(file), file.name, library);
      }
    }
    return { target: action === "archive" || action === "delete" ? safeInternalTarget(form.get("next")) : null };
  });
