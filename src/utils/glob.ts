/** Minimal glob matcher (`*` and `?` wildcards) used to filter document names client-side —
 * the Atelier API's own `filter` query param does not reliably match nested package names. */
export function matchesGlob(pattern: string, value: string): boolean {
  if (!pattern.trim()) return true;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value);
}

/** Matches `value` against a comma-separated list of glob patterns (e.g. "*.cls,*.int"). */
export function matchesAnyGlob(patterns: string, value: string): boolean {
  const list = patterns
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (list.length === 0) return true;
  return list.some((pattern) => matchesGlob(pattern, value));
}
