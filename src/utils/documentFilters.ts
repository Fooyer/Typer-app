// InterSystems ships these (Ensemble/interoperability + generated CSP proxy classes, plus routines)
// mixed in with a namespace's own classes — IRIS's own "system files" flag on the server doesn't
// filter them out since they're not %-prefixed, so hide them client-side by default instead.
const IGNORED_PACKAGE_PREFIXES = ["ens.", "ens-", "enslib.", "ensportal.", "cspx.", "%", "/csp/"];
// .DFI (Ens Analytics dashboard definitions) and .X12 (bundled HIPAA/EDI schema lookup tables) are
// interoperability framework assets that ship by default wherever Ensemble/Interoperability is
// enabled — never something written by hand in Studio/Atelier. .INT is the compiled intermediate
// code IRIS generates for every .cls/.mac routine — one per source document, never authored by
// hand, so it'd otherwise double every real entry in the tree.
const IGNORED_EXTENSIONS = new Set(["mac", "inc", "dfi", "x12", "int"]);

export function isNoiseDocument(name: string): boolean {
  const lower = name.toLowerCase();
  if (IGNORED_PACKAGE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  // Every document a user actually creates (class/routine/CSP page) has a real extension in its
  // Name — a bare name with no "." at all is a system utility/lookup-table entry the Studio dialog
  // surfaces alongside real documents, not something to browse or edit.
  if (!lower.includes(".")) return true;
  const ext = name.split(".").pop()?.toLowerCase();
  return ext !== undefined && IGNORED_EXTENSIONS.has(ext);
}
