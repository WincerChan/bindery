import type { KindleDirectory, KindleFile } from "../../src/client/kindle/fs";

interface Node { name: string; kind: "file" | "directory"; data: Uint8Array<ArrayBuffer>; modified: number; children: Map<string, Node>; removed: boolean }
const node = (name: string, kind: Node["kind"]): Node => ({ name, kind, data: new Uint8Array(), modified: Date.now(), children: new Map(), removed: false });
function fail(name: string, message = name): never { throw new DOMException(message, name); }
function validName(name: string) { if (!name || name === "." || name === ".." || /[/\\\0]/.test(name)) throw new TypeError("Invalid entry name"); }
export interface FakeOperation { operation: string; path: string }
/** Windows/Chrome semantics: case-insensitive names, immutable File snapshots, atomic close,
 * permission gates, recursive deletion, same handle usable after unplug/replug. */
export class FakeFileSystem {
  readonly root: FakeDirectory;
  connected = true;
  permission: PermissionState = "granted";
  requestResult: PermissionState = "granted";
  operations: FakeOperation[] = [];
  beforeOperation?: (operation: FakeOperation) => void;
  readonly failures = new Map<string, string>();
  windowsPathLimit: number | null = null;
  writeLatencyMs: number | ((path: string) => number) = 0;
  injectFailure(operation: "getFile" | "remove" | "values" | "createWritable" | "write" | "close", path: string, error = "NotFoundError") {
    this.failures.set(`${operation}:${path.replace(/^\/?/, "/").toLowerCase()}`, error);
  }
  constructor() { this.root = new FakeDirectory(this, node("Kindle", "directory"), ""); }
  unplug() { this.connected = false; }
  plug() { this.connected = true; }
  check(operation: string, path: string, entry: Node) {
    const record = { operation, path }; this.operations.push(record); this.beforeOperation?.(record);
    if (!this.connected || entry.removed) fail("NotFoundError");
    if (this.permission !== "granted") fail("NotAllowedError");
    const injected = this.failures.get(`${operation}:${path.toLowerCase()}`); if (injected) fail(injected);
    // Chrome can enumerate Linux-created long names even when getFile/remove fail on Windows.
    if (this.windowsPathLimit !== null && ["getFile", "remove", "get:file:create", "get:directory:create", "createWritable", "write", "close"].includes(operation) && `X:${path.replaceAll("/", "\\")}`.length >= this.windowsPathLimit) fail("NotFoundError", "Windows MAX_PATH");
  }
  async mkdir(path: string) { let dir: KindleDirectory = this.root; for (const part of path.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(part, { create: true }); return dir; }
  async write(path: string, data: string | Uint8Array = "") {
    const parts = path.split("/"), name = parts.pop()!, dir = await this.mkdir(parts.join("/")), stream = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await stream.write(typeof data === "string" ? data : new Uint8Array(data)); await stream.close();
  }
  async bytes(path: string) { const parts = path.split("/"), name = parts.pop()!; let dir: KindleDirectory = this.root; for (const part of parts) dir = await dir.getDirectoryHandle(part); return new Uint8Array(await (await (await dir.getFileHandle(name)).getFile()).arrayBuffer()); }
  async text(path: string) { return new TextDecoder().decode(await this.bytes(path)); }
}
export class FakeDirectory implements KindleDirectory {
  readonly kind = "directory" as const;
  get name() { return this.entry.name; }
  constructor(private fs: FakeFileSystem, private entry: Node, private path: string) {}
  queryPermission(_options: { mode: "readwrite" }) { return Promise.resolve(this.fs.permission); }
  requestPermission(_options: { mode: "readwrite" }) { this.fs.permission = this.fs.requestResult; return Promise.resolve(this.fs.permission); }
  private get(name: string, kind: Node["kind"], create: boolean) {
    validName(name); const path = `${this.path}/${name}`; this.fs.check(`get:${kind}${create ? ":create" : ""}`, path, this.entry);
    let value = this.entry.children.get(name.toLowerCase());
    if (!value) { if (!create) fail("NotFoundError"); value = node(name, kind); this.entry.children.set(name.toLowerCase(), value); }
    if (value.kind !== kind) fail("TypeMismatchError");
    return { value, path: `${this.path}/${value.name}` };
  }
  async getDirectoryHandle(name: string, options?: { create?: boolean }) { const { value, path } = this.get(name, "directory", options?.create ?? false); return new FakeDirectory(this.fs, value, path); }
  async getFileHandle(name: string, options?: { create?: boolean }) { const { value, path } = this.get(name, "file", options?.create ?? false); return new FakeFile(this.fs, value, path); }
  async removeEntry(name: string, options?: { recursive?: boolean }) {
    validName(name); this.fs.check("remove", `${this.path}/${name}`, this.entry);
    const entry = this.entry.children.get(name.toLowerCase()); if (!entry) fail("NotFoundError");
    if (entry.kind === "directory" && entry.children.size && !options?.recursive) fail("InvalidModificationError");
    const remove = (n: Node, path: string) => {
      for (const [key, child] of [...n.children]) {
        const full = `${path}/${child.name}`; this.fs.check("remove", full, child); remove(child, full); n.children.delete(key);
      }
      n.removed = true;
    };
    remove(entry, `${this.path}/${name}`);
    this.entry.children.delete(name.toLowerCase());
  }
  async *values(): AsyncIterableIterator<KindleDirectory | KindleFile> {
    this.fs.check("values", this.path, this.entry);
    for (const entry of [...this.entry.children.values()]) {
      this.fs.check("iterate", `${this.path}/${entry.name}`, this.entry);
      if (entry.removed) continue;
      yield entry.kind === "directory" ? new FakeDirectory(this.fs, entry, `${this.path}/${entry.name}`) : new FakeFile(this.fs, entry, `${this.path}/${entry.name}`);
    }
  }
}
export class FakeFile implements KindleFile {
  readonly kind = "file" as const;
  get name() { return this.entry.name; }
  constructor(private fs: FakeFileSystem, private entry: Node, private path: string) {}
  async getFile() { this.fs.check("getFile", this.path, this.entry); return new File([this.entry.data.slice()], this.name, { lastModified: this.entry.modified }); }
  async createWritable() {
    this.fs.check("createWritable", this.path, this.entry);
    let staged: Uint8Array<ArrayBuffer>[] = [], closed = false;
    const check = (operation: string) => { if (closed) fail("InvalidStateError"); this.fs.check(operation, this.path, this.entry); };
    return {
      write: async (data: string | Blob | Uint8Array<ArrayBuffer>) => {
        const latency = typeof this.fs.writeLatencyMs === "function" ? this.fs.writeLatencyMs(this.path) : this.fs.writeLatencyMs;
        if (latency > 0) await new Promise(resolve => setTimeout(resolve, latency));
        check("write"); staged.push(typeof data === "string" ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data));
      },
      close: async () => {
        check("close"); const bytes = new Uint8Array(staged.reduce((sum, chunk) => sum + chunk.byteLength, 0));
        let offset = 0; for (const chunk of staged) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        this.entry.data = bytes; this.entry.modified = Date.now(); closed = true;
      },
      abort: async () => { this.fs.operations.push({ operation: "abort", path: this.path }); closed = true; staged = []; },
    };
  }
}
export async function fakeKindle() {
  const fs = new FakeFileSystem(); await fs.mkdir("documents"); await fs.mkdir("system/thumbnails"); await fs.mkdir("fonts"); await fs.write("system/version.txt", "Kindle 5.16.2.1.1"); fs.operations = []; return fs;
}

/** Kobo root with `.kobo/version`; the last comma field is the product ID. */
export async function fakeKobo(productId = "N418") {
  const fs = new FakeFileSystem(); await fs.mkdir(".kobo"); await fs.mkdir("fonts");
  await fs.write(".kobo/version", `4.38.23171,4.38.23171,4.38.23171,4.38.23171,${productId}`);
  fs.operations = []; return fs;
}
