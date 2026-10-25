import { createRootRoute, HeadContent, Scripts } from "@tanstack/solid-router";
import { Loading } from "solid-js";
import type { JSX } from "@solidjs/web";
import stylesheet from "../styles.css?url";
import { ToastRegion } from "../shell/toast-region";
import { PwaRegistration } from "../client/pwa/registration";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { name: "theme-color", content: "#F2F0E9" },
      { title: "Bindery" },
    ],
    links: [
      { rel: "stylesheet", href: stylesheet },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "manifest", type: "application/json", href: "/manifest.json" },
      { rel: "apple-touch-icon", href: "/icons/icon-192.png" },
    ],
  }),
  shellComponent: RootDocument,
});
function RootDocument(props: { children: JSX.Element }) {
  return (
    <html lang="zh-CN">
      <head>
        <HeadContent />
      </head>
      <body>
        <Loading>{props.children}</Loading>
        <ToastRegion />
        <PwaRegistration />
        <Scripts />
      </body>
    </html>
  );
}
