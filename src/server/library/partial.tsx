import { renderToString } from "@solidjs/web";
import { LibrarySection } from "../../features/library/library-page";
import { loadLibraryPage } from "./queries";
import { libraryQueryInput } from "../../features/library/search";
import type { LibraryStorage } from "../storage";

export function libraryPartial(request: Request, library: LibraryStorage): Response {
  const search = Object.fromEntries(new URL(request.url).searchParams);
  const data = loadLibraryPage(library, libraryQueryInput(search));
  return new Response(renderToString(() => <LibrarySection data={data} />), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
