import { createFileRoute, redirect } from "@tanstack/solid-router";
import { legacyKindleRedirect } from "../features/devices/redirects";
export const Route = createFileRoute("/_app/kindle/connect")({ beforeLoad: ({ location }) => { throw redirect(legacyKindleRedirect(location.href)); } });
