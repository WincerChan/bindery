import { createFileRoute, redirect } from "@tanstack/solid-router";
import { legacyKindleRedirect } from "../features/devices/redirects";
export const Route = createFileRoute("/_app/kindle/transfer")({ beforeLoad: ({ location }) => { throw redirect(legacyKindleRedirect(location.href)); } });
