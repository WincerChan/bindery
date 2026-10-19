import type { ApiContext } from "../http";
import { archiveBooks, deleteArchivedBooks, downloadBooks, formBookIds } from "./actions";

export async function archivePost({ request, library }: ApiContext<unknown>) {
  archiveBooks(await formBookIds(request), library);
  return new Response(null, { status: 303, headers: { Location: "/" } });
}
export async function deletePost({ request, library }: ApiContext<unknown>) {
  deleteArchivedBooks(await formBookIds(request), library);
  return new Response(null, { status: 303, headers: { Location: "/archive" } });
}
export async function downloadPost({ request, library }: ApiContext<unknown>) {
  return downloadBooks(await formBookIds(request), library);
}
