import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}

const rules = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map(([, selector, body]) => ({ selector: selector.trim(), body }));

describe("shared page intro CSS ownership", () => {
  const featureCss = files("src/features").filter(path => path.endsWith(".css"));
  it("keeps intro layout, type and rhythm selectors out of feature stylesheets", () => {
    for (const path of featureCss) {
      const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css, path).not.toMatch(/\.ui-page-(?:intro(?:-[a-z-]+)?|eyebrow|actions|meta|status|note|visual)\b/);
      // Aliases and custom-property assignments bypassed the original selector-only test.
      expect(css, path).not.toMatch(/--intro-[\w-]+\s*:/);
      expect(css, path).not.toMatch(/(?:intro[\w-]*|kt-topbar|books-edit-heading|kindle-connect|settings-hub)[^{}]*\b(?:h1|ui-back-link)\b/);
      const aliases = /\.(?:library-intro|ingest-intro(?:-empty)?|tracker-intro|vocab-intro|device-connect-intro|device-intro-page|device-mobile-hero|security-intro|books-detail|books-edit-heading|kt-topbar|ingest-staged-actions|device-compact-header)(?:[:{]|\s*(?:,|$))/;
      for (const rule of rules(css)) if (aliases.test(rule.selector)) {
        expect(rule.body, `${path}: ${rule.selector}`).not.toMatch(/(?:^|;)\s*(?:(?:row-|column-)?gap|padding[\w-]*|margin[\w-]*|font[\w-]*|line-height|letter-spacing|display|align-[\w-]+|justify-[\w-]+|flex[\w-]*|grid[\w-]*|position|inset[\w-]*|top|right|bottom|left|(?:min-|max-)?(?:width|height))\s*:/);
      }
    }
  });
  it("keeps empty and staged ingest on the shared main intro", () => {
    const page = readFileSync("src/features/ingest/page.tsx", "utf8");
    expect(page).toContain('<PageIntro class="ingest-intro" variant="main"');
    expect(page).not.toContain('variant={files().length ? "main" : "empty"}');
  });
  it("keeps numeric rhythm values in tokens, including variants", () => {
    for (const rule of rules(readFileSync("src/ui/ui.css", "utf8"))) {
      if (!/\.ui-page-(?:intro|eyebrow|description|actions|meta|status|note|visual)/.test(rule.selector)) continue;
      expect(rule.body, rule.selector).not.toMatch(/--intro-[\w-]+:\s*(?!0(?:px)?[;\s])[-.\d]+(?:px|em|rem)/);
      expect(rule.body, rule.selector).not.toMatch(/(?:^|;)\s*(?:gap|column-gap|row-gap|padding(?:-[\w-]+)?|margin(?:-[\w-]+)?|font-size|line-height|letter-spacing):\s*[1-9][\d.]*(?:px|em|rem|\s*;)/);
    }
  });
  it("keeps preview controls in the title's wrap context and isolates the book layout", () => {
    const css = readFileSync("src/ui/ui.css", "utf8"), source = readFileSync("src/ui/primitives.tsx", "utf8");
    expect(css).toContain(".ui-page-intro-topbar .ui-page-actions { display: contents; }");
    expect(source).toContain('props.visualSize && props.variant !== "book"');
    expect(css).not.toMatch(/--intro-(?:subpage|guide|book)-stack\s*:/);
  });
  it("keeps one stack rhythm and one intro type scale across every variant", () => {
    const css = readFileSync("src/ui/ui.css", "utf8"), tokens = readFileSync("src/styles.css", "utf8");
    for (const name of ["stack-gap", "actions-offset", "action-gap", "status-offset", "title-size", "title-line", "title-tracking", "lead-size", "lead-line"]) {
      expect(css, name).not.toMatch(new RegExp(`--intro-${name}\\s*:`));
    }
    expect(css).not.toMatch(/--intro-(?:book|cover|editor)-(?:line|title|tracking)[a-z-]*\s*:/);
    expect(css).toContain(".ui-page-intro-controls > .ui-page-actions { margin-top: 0; }");
    const desktop = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf("@media (max-width: 767px)"));
    const phone = tokens.slice(tokens.indexOf("@media (max-width: 767px)"), tokens.indexOf("@layer base"));
    expect(desktop).toContain("--intro-stack-gap: 22px");
    expect(desktop).toContain("--intro-actions-offset: 6px");
    expect(phone).toContain("--intro-stack-gap: 16px");
    expect(phone).toContain("--intro-actions-offset: 0px");
  });
  it("routes feature page headings through the shared primitive and preserves adjacent heading order", () => {
    for (const path of readdirSync("src/features", { recursive: true }).filter(path => typeof path === "string" && path.endsWith(".tsx"))) {
      expect(readFileSync(`src/features/${path}`, "utf8"), String(path)).not.toMatch(/<h1\b/);
    }
    expect(readFileSync("src/features/devices/device-bar.tsx", "utf8")).toContain('<PageIntro variant="compact" title="设备字体"');
    expect(readFileSync("src/features/kindle/typeset/fonts-page.tsx", "utf8")).toContain('<h2 class="sr-only">字体管理</h2>');
    expect(readFileSync("src/features/devices/preview/preview-page.tsx", "utf8")).toContain('<h2 class="sr-only">设备阅读设置（只用于预览）</h2>');
  });
  it("does not turn desktop visual widths into phone heights or hide docking in feature aliases", () => {
    const css = readFileSync("src/ui/ui.css", "utf8");
    expect(css).toMatch(/\.ui-page-visual\s*\{\s*display: none;\s*flex: none;\s*flex-direction: column;\s*align-items: stretch;/);
    expect(css).toContain("bottom: calc(var(--intro-action-dock-inset) + env(safe-area-inset-bottom))");
    expect(readFileSync("src/features/ingest/page.tsx", "utf8")).toContain('mobileActions={files().length ? "dock" : undefined}');
  });
  it("allows only content-specific declarations on the shared lead", () => {
    const rhythm = /(?:^|;)\s*(?:margin(?:-[a-z-]+)?|padding(?:-[a-z-]+)?|font(?:-size|-weight)?|line-height|letter-spacing|max-width|gap)\s*:/;
    for (const path of featureCss) {
      for (const rule of rules(readFileSync(path, "utf8"))) {
        for (const selector of rule.selector.split(",").map(value => value.trim())) {
          if (/(?:^|[\s>+~])\.ui-page-description$/.test(selector)) expect(rule.body, `${path}: ${selector}`).not.toMatch(rhythm);
        }
      }
    }
  });
});
