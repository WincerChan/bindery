import { BinderyDatabase } from "./db";
import { LibraryStorage } from "./storage";
import { libraryPath } from "./paths";
import { writableDatabasePath } from "./database";
const runtimes = new Map<string, LibraryStorage>();
// Lazy: importing server modules and building the app must never touch a library.
export function getLibrary(): LibraryStorage {
  const base = libraryPath(),
    path = writableDatabasePath(),
    key = JSON.stringify([base, path]);
  let library = runtimes.get(key);
  if (!library) {
    library = new LibraryStorage(base, new BinderyDatabase(path));
    library.ensure();
    runtimes.set(key, library);
  }
  return library;
}
