import type * as Monaco from "monaco-editor";

/**
 * Highlights every use of a method/classmethod's formal parameters inside its own body with the
 * same color as the parameter's declaration. The TextMate grammar can only color the declaration
 * itself (it has no notion of "this identifier refers to that earlier parameter") — this fills the
 * gap with a lightweight, heuristic scan instead of a real semantic model: it finds method
 * signatures and their `{ ... }` body by brace counting, so it can be fooled by a literal `{`/`}`
 * inside a string, and it doesn't handle multi-line parameter lists. Good enough for highlighting,
 * not a substitute for the compiler.
 */
export const METHOD_SIGNATURE = /^\s*(?:Class)?Method\s+[%\p{L}_][\p{L}\p{N}_]*\s*\(/u;

export const PARAMETER_USAGE_CLASS = "cm-param-usage";

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);
  return parts;
}

export function extractParamNames(paramList: string): string[] {
  const names: string[] = [];
  for (const rawChunk of splitTopLevelCommas(paramList)) {
    const match = rawChunk.trim().match(/^(?:Output\s+|ByRef\s+)?([%\p{L}_][\p{L}\p{N}_]*)/u);
    if (match) names.push(match[1]);
  }
  return names;
}

export function findMatchingParen(line: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < line.length; i++) {
    if (line[i] === "(") depth++;
    else if (line[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Scans forward from `fromLine`/`fromCol` for the first `{`, returning its position (depth becomes 1 there). */
export function findBodyStart(
  lines: string[],
  fromLine: number,
  fromCol: number,
): { line: number; col: number } | null {
  for (let line = fromLine; line < lines.length; line++) {
    const text = line === fromLine ? lines[line].slice(fromCol) : lines[line];
    const offset = line === fromLine ? fromCol : 0;
    const index = text.indexOf("{");
    if (index >= 0) return { line, col: offset + index + 1 };
  }
  return null;
}

/** Scans forward from the body start for the matching `}` at depth 0, tracking nested `{ }`. */
export function findBodyEnd(
  lines: string[],
  fromLine: number,
  fromCol: number,
): { line: number; col: number } | null {
  let depth = 1;
  for (let line = fromLine; line < lines.length; line++) {
    const text = line === fromLine ? lines[line].slice(fromCol) : lines[line];
    const offset = line === fromLine ? fromCol : 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) return { line, col: offset + i };
      }
    }
  }
  return null;
}

export function computeParameterUsageDecorations(
  model: Monaco.editor.ITextModel,
): Monaco.editor.IModelDeltaDecoration[] {
  const lines = model.getLinesContent();
  const decorations: Monaco.editor.IModelDeltaDecoration[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!METHOD_SIGNATURE.test(line)) continue;

    const openParen = line.indexOf("(");
    const closeParen = openParen >= 0 ? findMatchingParen(line, openParen) : -1;
    if (closeParen < 0) continue;

    const paramNames = extractParamNames(line.slice(openParen + 1, closeParen));
    if (paramNames.length === 0) continue;

    const bodyStart = findBodyStart(lines, i, closeParen + 1);
    if (!bodyStart) continue;
    const bodyEnd = findBodyEnd(lines, bodyStart.line, bodyStart.col);
    if (!bodyEnd) continue;

    // `_` is ObjectScript's string-concatenation operator, not an identifier character, but JS
    // regex treats it as a \w char, so `\b` fails to break at `_name_`. Use explicit
    // letter/digit lookarounds instead so concatenation-adjacent usages still get highlighted.
    const idChar = "\\p{L}\\p{N}";
    const wordPattern = new RegExp(
      `(?<![${idChar}])(?:${paramNames.map(escapeRegExp).join("|")})(?![${idChar}])`,
      "gu",
    );
    for (let line2 = bodyStart.line; line2 <= bodyEnd.line; line2++) {
      const text = lines[line2];
      const from = line2 === bodyStart.line ? bodyStart.col : 0;
      const to = line2 === bodyEnd.line ? bodyEnd.col : text.length;
      wordPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = wordPattern.exec(text))) {
        if (match.index < from || match.index >= to) continue;
        decorations.push({
          range: {
            startLineNumber: line2 + 1,
            startColumn: match.index + 1,
            endLineNumber: line2 + 1,
            endColumn: match.index + 1 + match[0].length,
          },
          options: { inlineClassName: PARAMETER_USAGE_CLASS },
        });
      }
    }

    i = bodyEnd.line; // resume scanning after this method's body
  }

  return decorations;
}
