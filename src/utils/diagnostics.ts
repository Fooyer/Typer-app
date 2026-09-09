export interface Diagnostic {
  line: number;
  message: string;
  severity: "error" | "warning";
}

/**
 * Best-effort parse of IRIS compiler console output into per-line diagnostics.
 * The exact text format of compiler messages isn't formally documented, so this only
 * attaches a marker when it can confidently spot a line number; every message is still
 * shown verbatim in the Output panel regardless of whether a line was found.
 */
export function parseCompileDiagnostics(consoleLines: string[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const line of consoleLines) {
    const isError = /\berror\b/i.test(line) || /#\d/.test(line);
    const isWarning = !isError && /\bwarning\b/i.test(line);
    if (!isError && !isWarning) continue;

    const lineMatch = line.match(/\bline\s+(\d+)/i) ?? line.match(/\((\d+)[,)]/i);
    if (!lineMatch) continue;

    const lineNumber = Number(lineMatch[1]);
    if (!Number.isFinite(lineNumber) || lineNumber < 1) continue;

    diagnostics.push({
      line: lineNumber,
      message: line.trim(),
      severity: isError ? "error" : "warning",
    });
  }
  return diagnostics;
}
