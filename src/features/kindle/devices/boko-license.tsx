import source from "../../../../vendor/boko/SOURCE.md?raw";
import license from "../../../../vendor/boko/LICENSE?raw";

/** Included in the rendered transfer page, so the shipped WASM always has an accessible notice. */
export function BokoLicense() {
  return <details class="kindle-license" id="boko-license"><summary>boko 0.5.0 · GPL-3.0-or-later · 许可证与对应源码</summary>
    <p>浏览器使用 boko 0.5.0 WASM 将 EPUB 转为 KFX。</p>
    <p><a href="https://crates.io/api/v1/crates/boko/0.5.0/download">下载 boko 0.5.0 对应源码</a> · <a href="https://github.com/zacharydenton/boko">上游仓库</a></p>
    <h3>SOURCE.md</h3><pre>{source}</pre><h3>LICENSE</h3><pre lang="en">{license}</pre>
  </details>;
}
