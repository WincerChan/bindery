// --color-bg in src/styles.css; keep install/splash chrome consistent with the shell.
export const manifest = {
  id: "/",
  name: "Bindery",
  short_name: "Bindery",
  description: "个人 EPUB 书库与 Kindle USB 传书",
  lang: "zh-CN",
  start_url: "/",
  scope: "/",
  display: "standalone",
  theme_color: "#F5F6F3",
  background_color: "#F5F6F3",
  icons: [
    { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
};
