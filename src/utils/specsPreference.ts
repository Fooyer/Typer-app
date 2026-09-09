// Remembers a custom Specs directory per connection+namespace (mirrors themePreference.ts's
// localStorage pattern) — absent means "use the automatic default" (see electron/specs.ts's
// defaultSpecsDir), so there's nothing to save until the user actually picks a folder.
function storageKey(connectionId: string, namespace: string): string {
  return `typer.specs-dir::${connectionId}::${namespace}`;
}

export function loadSpecsDirOverride(connectionId: string, namespace: string): string | null {
  try {
    return localStorage.getItem(storageKey(connectionId, namespace));
  } catch {
    return null;
  }
}

export function saveSpecsDirOverride(
  connectionId: string,
  namespace: string,
  dir: string | null,
): void {
  try {
    const key = storageKey(connectionId, namespace);
    if (dir) localStorage.setItem(key, dir);
    else localStorage.removeItem(key);
  } catch {
    // Storage full/unavailable — losing the override just means it falls back to the default dir.
  }
}
