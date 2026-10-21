# Local-library parity cache

The phase-5 cutover removed the Python oracle, but two checks still depend on
the user's real library:

1. the "read-only backup of the existing database" data-layer check;
2. the two smallest local EPUBs used by the core EPUB patch/inspection checks.

Their Python reference output cannot be committed: it depends on private book
files and on the current library database. It lives in a gitignored cache
instead.

## Location and behavior

- Default cache: `./.parity-local` (relative to the worktree).
- Override: `BINDERY_LOCAL_PARITY_DIR=/absolute/path`.
- `.parity-local/` is ignored by Git and Docker. The cache contains only Python
  reference output and SHA-256 fingerprints; it does not need copies of books or
  databases.
- Tests select the same two smallest `library/**/*.epub` files as the baseline
  oracle, sorted by size and then relative path.
- If `library/` does not exist, the local checks are not created (same as the
  pre-cutover behavior when no library was present).
- If `library/` exists but the cache is missing, unreadable, or its
  `bindery.db`/two-EPUB fingerprints do not match the current files, the local
  cases are **skipped with a reason**; the rest of the test file still runs.
- If fingerprints match, the full baseline assertions run, including all 20
  local EPUB variants per selected book (inspection + `metadata`, `css`,
  `clear-overlay`, `strip-css`, `replace-css`, `cover`, `combined`,
  `repeat-css`, `strip-webp`, `normalize`).

## Generating the core cache

Run this against the pre-cutover commit `e38de41` (the baseline worktree
`/workspaces/bindery-p5-base`). The Python code is the real oracle; the source
library is mounted read-only through a temporary view. Nothing is written to
`/workspaces/bindery/library`.

```bash
BASE=/workspaces/bindery-p5-base
VIEW=$(mktemp -d)
OUT=$(mktemp -d)
CACHE=${BINDERY_LOCAL_PARITY_DIR:-.parity-local}

mkdir -p "$VIEW/scripts/parity" "$OUT" "$CACHE/core"
ln -s "$BASE/bindery" "$VIEW/bindery"
ln -s "$BASE/tests" "$VIEW/tests"
ln -s "$BASE/tests-ts" "$VIEW/tests-ts"
ln -s "$BASE/bindery-templates" "$VIEW/bindery-templates"
ln -s /workspaces/bindery/library "$VIEW/library"
cp "$BASE/scripts/parity/reference.py" "$VIEW/scripts/parity/reference.py"

(cd "$VIEW" && /workspaces/bindery/.venv/bin/python \
  scripts/parity/reference.py "$OUT")

# Extract only the local-library patches and compact them (this is the same
# transformation used for the committed core fixture).
export OUT CACHE
node <<'JS'
const fs = require("fs"), path = require("path"), crypto = require("crypto"), zlib = require("zlib");
const out = process.env.OUT, libraryRoot = "/workspaces/bindery/library";
const cacheRoot = path.join(process.env.CACHE, "core");
const ref = JSON.parse(fs.readFileSync(path.join(out, "reference.json"), "utf8"));
const patches = ref.patches.filter(p => p.input.startsWith("input-library-"));
function walk(base) {
  const result = [];
  const rec = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) rec(file); else if (entry.name.endsWith(".epub")) result.push(file);
  } };
  rec(base); return result;
}
const books = walk(libraryRoot).map(file => ({
  path: path.relative(libraryRoot, file).split(path.sep).join("/"),
  size: fs.statSync(file).size,
  sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
})).sort((a, b) => a.size - b.size || a.path.localeCompare(b.path)).slice(0, patches.length);
const blobs = new Map();
const blob = value => {
  const digest = crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
  blobs.set(digest, value); return { $blob: digest };
};
const compact = inspection => {
  for (const loaded of inspection.loaded) {
    loaded.content_sha256 = crypto.createHash("sha256").update(Buffer.from(loaded.content, "base64")).digest("hex");
    delete loaded.content;
  }
  inspection.sections = blob(inspection.sections);
  inspection.documents = blob(inspection.documents);
  if (inspection.cover) inspection.cover = blob(inspection.cover);
};
for (const patch of patches) {
  compact(patch.inspection);
  for (const variant of patch.variants) compact(variant.inspection);
}
const epubs = {};
for (const patch of patches) for (const variant of patch.variants) {
  const members = ref.epubs[variant.file];
  epubs[variant.file] = { names: blob(members.map(member => member.name)), sha256: members.map(member => member.sha256) };
}
const cache = {
  version: 1,
  source_commit: "e38de41d9d80ba1c32fe22236053bad3f49d8c14",
  source: {
    bindery_db_sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(libraryRoot, "bindery.db"))).digest("hex"),
    books,
  },
  library_copies: ref.library_copies,
  patches, epubs, blobs: Object.fromEntries(blobs),
};
fs.writeFileSync(path.join(cacheRoot, "reference.json.gz"), zlib.gzipSync(JSON.stringify(cache), { level: 9 }));
console.log({ patches: patches.length, books: books.map(book => book.path), bytes: fs.statSync(path.join(cacheRoot, "reference.json.gz")).size });
JS
```

The extraction step above needs `OUT` (the Python output directory) and
`CACHE` (the local cache root), exported as shown.

## Generating the existing-database cache

This needs one Python initialization and one current-TS initialization of the
same database. Use a temporary Vitest harness (removed after generation):

```ts
// tests-ts/fixtures/parity/generate-existing.test.ts
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "vitest";
import { BinderyDatabase } from "../../../src/server/db";
import { databaseState, fileState } from "../../support/legacy-state";

const PY = "/workspaces/bindery/.venv/bin/python";
const SCRIPT = "/workspaces/bindery-p5-base/scripts/parity/data-reference.py";
const SOURCE = "/workspaces/bindery/library/bindery.db";

it("record existing database replay", () => {
  const sourceHash = createHash("sha256").update(readFileSync(SOURCE)).digest("hex");
  const record = (initAfterTs: boolean) => {
    const root = mkdtempSync(join(tmpdir(), "bindery-existing-"));
    const dbPath = join(root, "data.db");
    const state = () => ({ sql: databaseState(dbPath), files: fileState(join(root, "library")) });
    try {
      copyFileSync(SOURCE, dbPath);
      if (initAfterTs) new BinderyDatabase(dbPath).init();
      const before = state();
      const value = JSON.parse(execFileSync(PY, [SCRIPT, "init", root], {
        cwd: "/workspaces/bindery-p5-base", encoding: "utf8", maxBuffer: 32 * 1024 * 1024,
      }));
      return { before, after: state(), value };
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const cache = resolve(process.env.BINDERY_LOCAL_PARITY_DIR || ".parity-local", "data");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "existing-backup.json"), JSON.stringify({
    version: 1,
    source_commit: "e38de41d9d80ba1c32fe22236053bad3f49d8c14",
    source: { bindery_db_sha256: sourceHash },
    init_raw: record(false),
    init_after_ts: record(true),
  }));
});
```

Run it once:

```bash
BINDERY_LOCAL_PARITY_DIR=/workspaces/bindery/.parity-local \
  pnpm vitest run tests-ts/fixtures/parity/generate-existing.test.ts

rm tests-ts/fixtures/parity/generate-existing.test.ts
```

The resulting file stores the raw Python SQL dump before/after each init,
the same for the TS-initialized copy, and the Python `init` snapshot value. It
does not copy the library database. The test recomputes the source SHA-256 and
copies `library/bindery.db` into its own temporary fixture tree.

## Generating `alternating-replay.json`

The committed `tests-ts/fixtures/parity/data/alternating-replay.json` was
produced from the baseline with the same three original Python calls:

1. `python scripts/parity/data-reference.py init ROOT` (record pre/post state);
2. TS `saveMetadata({ book_id: "a", title: "TS", tags: ["中","文"], created_at })`;
3. `python scripts/parity/data-reference.py run ROOT steps.json` with the
   original `load_metadata` + `save_metadata(title="Python")` steps (record
   input, pre/post state, result);
4. TS `BinderyDatabase.init()`;
5. `python scripts/parity/data-reference.py snapshot ROOT` (record pre/post
   state and result).

Use a temporary Vitest harness for the TS steps and `databaseState` /
`fileState`; the exact harness was the same pattern as the existing-backup
generator above. The test replays each state, verifies the current TS state is
the recorded Python pre-state, restores the Python post-state, and then runs
the original TS assertions.

## Verification

```bash
# no library/ -> no local cases
pnpm test

# real library + cache -> 22 local EPUB cases and the database backup run
ln -s /workspaces/bindery/library library
BINDERY_LOCAL_PARITY_DIR=/workspaces/bindery/.parity-local pnpm test
rm library

# different library copy (different bindery.db) -> skip, not fail
ln -s /tmp/.../lib-probe2 library
BINDERY_LOCAL_PARITY_DIR=/workspaces/bindery/.parity-local pnpm test
rm library
```

The local cache is intentionally absent from Git. Removing it only makes these
local checks skip; it must never make the suite fail.
