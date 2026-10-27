import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
function declarations(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] || "";
}

describe("full-bleed desktop shell", () => {
  it("has no outer frame, max width, padding or rounded page shell", () => {
    const shell = read("src/shell/shell.css"), styles = read("src/styles.css");
    expect(shell).not.toContain(".app-frame");

    const page = declarations(shell, ".page-shell");
    expect(page).toContain("grid-template-columns: var(--nav-rail) minmax(0, 1fr)");
    expect(page).toContain("min-height: 100dvh");
    expect(page).toContain("background: var(--color-bg)");
    expect(page).not.toMatch(/max-width|margin|padding|border-radius/);

    const rail = declarations(shell, ".nav-rail");
    expect(rail).toContain("align-self: stretch");
    expect(rail).toContain("border-right: 1px solid var(--color-line-hair)");
    expect(rail).not.toContain("border-radius");

    const railContent = declarations(shell, ".nav-rail-content");
    expect(railContent).toContain("position: sticky");
    expect(railContent).toContain("top: 0");
    expect(railContent).toContain("height: 100dvh");

    const main = declarations(shell, ".app-main");
    expect(main).toContain("padding: 40px var(--space-page) 72px");
    expect(main).not.toContain("max-width");
    expect(main).not.toMatch(/(?:^|;)\s*width:/);

    expect(styles).not.toContain("--color-app-bg");
    expect(styles).toMatch(/html, body \{ background: var\(--color-bg\); \}/);
  });

  it("lets the tracker list gain columns instead of pinning three", () => {
    const tracker = read("src/features/catalog/tracker.css");
    expect(declarations(tracker, ".tracker-list")).toContain("repeat(auto-fill, minmax(min(100%, 320px), 1fr))");
  });
});
