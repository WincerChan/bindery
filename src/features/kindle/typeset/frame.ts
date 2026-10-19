import { loadPreviewFont, type FontFamily } from "../../../client/kindle/fonts";
import type { PairedDevice } from "../../../client/kindle/identity";

/** A font registration belongs to exactly one isolated document. Late loads cannot resurrect it. */
export class DocumentFonts {
  private generation = 0;
  private faces: FontFace[] = [];
  constructor(private document: Document) {}
  clear() {
    this.generation++;
    for (const face of this.faces) this.document.fonts.delete(face);
    this.faces = [];
  }
  async load(device: PairedDevice, family: FontFamily, alias = family.name) {
    this.clear();
    const generation = this.generation;
    // All styles are loaded together, so bold/italic samples and EPUB emphasis use the real files.
    const faces = await Promise.all(family.fonts.map(font => loadPreviewFont(device, font, alias)));
    if (generation !== this.generation) return;
    for (const face of faces) { this.document.fonts.add(face); this.faces.push(face); }
  }
}

export class PreviewDocument {
  private style: HTMLStyleElement;
  private base: HTMLStyleElement;
  private fonts: DocumentFonts;
  private fontKey = "";
  private stopLinks = (event: Event) => {
    if ((event.target as Element | null)?.closest("a")) event.preventDefault();
  };
  constructor(private document: Document) {
    this.fonts = new DocumentFonts(document);
    this.base = document.createElement("style");
    // 40 CSS pixels at the device pixel dimensions approximates a 9.6pt baseline at 300ppi.
    this.base.textContent = "html { font-size: 40px; } body { overflow-wrap: anywhere; } img, svg { max-width: 100%; }";
    this.style = document.createElement("style");
    this.style.setAttribute("data-bindery-profile", "");
    document.head.append(this.base, this.style);
    document.addEventListener("click", this.stopLinks);
  }
  async update(css: string | null, device: PairedDevice | null, family?: FontFamily) {
    if (css !== null) this.style.textContent = css;
    const key = device && family ? `${device.identity.id}:${family.name}:${family.fonts.map(font => `${font.filename}:${font.size}`).join("|")}` : "";
    if (key === this.fontKey) return;
    this.fontKey = key;
    this.fonts.clear();
    if (device && family) {
      try { await this.fonts.load(device, family); }
      catch (error) { if (this.fontKey === key) { this.fontKey = ""; throw error; } }
    }
  }
  destroy() { this.fonts.clear(); this.style.remove(); this.base.remove(); this.document.removeEventListener("click", this.stopLinks); }
}
