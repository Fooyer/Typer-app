// InterSystems ships these (Ensemble/interoperability + generated CSP proxy classes, plus routines)
// mixed in with a namespace's own classes — IRIS's own "system files" flag on the server doesn't
// filter them out since they're not %-prefixed, so hide them client-side by default instead.
const IGNORED_PACKAGE_PREFIXES = ["ens.", "enslib.", "ensportal.", "cspx."];
const IGNORED_EXTENSIONS = new Set(["mac", "inc"]);

export function isNoiseDocument(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext && IGNORED_EXTENSIONS.has(ext)) return true;
  const lower = name.toLowerCase();
  return IGNORED_PACKAGE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}
