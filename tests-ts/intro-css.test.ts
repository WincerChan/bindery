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
      expect(css, path).not.toMatch(/\.ui-page-(?:intro(?:-[a-z-]+)?|eyebrow|actions|meta)\b/);
    }
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
