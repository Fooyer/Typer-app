import type * as Monaco from "monaco-editor";
import { OBJECTSCRIPT_LANGUAGE_IDS } from "./objectscript-language";
import { parseCurrentClassName } from "./objectscriptTypeResolver";
import { escapeRegExp } from "./parameterHighlight";

const CLASS_REFERENCE_SCHEME = "objectscript-class";
const METHOD_QUERY_KEY = "method";

let openClassReference: ((className: string, methodName?: string) => void) | null = null;

/** App.tsx wires this to "fetch + open/focus a tab for this class" (and, when `methodName` is
 * given, scroll to that method's declaration once the tab's content is available), using the
 * active tab's connection/namespace as context — see registerObjectScriptDefinition below for the
 * trigger. */
export function setClassReferenceOpener(
  fn: ((className: string, methodName?: string) => void) | null,
): void {
  openClassReference = fn;
}

export function goToClassReference(className: string, methodName?: string): void {
  openClassReference?.(className, methodName);
}

/** Locates a method/classmethod declaration by name in a class's raw source, for scrolling F12 to
 * the actual method instead of just the top of the file. Same convention as parameterHighlight's
 * `METHOD_SIGNATURE`, but anchored to one specific name. Best-effort text search (not a parser) —
 * good enough since ObjectScript doesn't allow overloads, so the first match is the declaration. */
export function findMethodLine(content: string, methodName: string): number | null {
  const pattern = new RegExp(`^\\s*(?:Class)?Method\\s+${escapeRegExp(methodName)}\\s*\\(`, "i");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return null;
}

/** Finds the class-name-like token under the cursor. Since ObjectScript class names are dotted
 * (`Teste.Router`) or `%`-prefixed system names (`%Status`), Monaco's own word boundaries would
 * split on the dot, so this scans the line with a wider pattern instead of using getWordAtPosition. */
export function extractClassNameAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): string | null {
  const line = model.getLineContent(position.lineNumber);
  const pattern = /%?\w+(?:\.\w+)*/g;
  const column = position.column - 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (column < start || column > end) continue;

    const token = match[0];
    const looksLikeClassName = token.startsWith("%") || token.includes(".");
    const precededByClassRef = /##class\(\s*$/i.test(line.slice(0, start));
    return looksLikeClassName || precededByClassRef ? token : null;
  }
  return null;
}

/** Finds a `##class(ClassName).Method` or `..Method` call whose method name the cursor sits on —
 * the class-name-only case (cursor on `ClassName` itself) is handled separately by
 * `extractClassNameAt` and keeps just opening the class, per existing behavior. */
export function extractMethodReferenceAt(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): { className: string; methodName: string } | null {
  const line = model.getLineContent(position.lineNumber);
  const column = position.column - 1;
  const identifier = /[%\w]+/g;
  let token: { text: string; start: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = identifier.exec(line))) {
    const start = match.index;
    const end = start + match[0].length;
    if (column < start || column > end) continue;
    token = { text: match[0], start };
    break;
  }
  if (!token) return null;

  const before = line.slice(0, token.start);

  const classCallMatch = /##class\(\s*([%\w][\w.]*)\s*\)\s*\.\s*$/i.exec(before);
  if (classCallMatch) return { className: classCallMatch[1], methodName: token.text };

  if (/(?:^|[^.])\.\.\s*$/.test(before)) {
    const className = parseCurrentClassName(model);
    if (className) return { className, methodName: token.text };
  }

  return null;
}

let registered = false;

export function registerObjectScriptDefinition(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerDefinitionProvider(OBJECTSCRIPT_LANGUAGE_IDS, {
    provideDefinition(model, position) {
      const methodRef = extractMethodReferenceAt(model, position);
      const className = methodRef?.className ?? extractClassNameAt(model, position);
      if (!className) return null;
      const query = methodRef ? `${METHOD_QUERY_KEY}=${encodeURIComponent(methodRef.methodName)}` : undefined;
      return [
        {
          uri: monaco.Uri.from({
            scheme: CLASS_REFERENCE_SCHEME,
            path: `/${className}.cls`,
            query,
          }),
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        },
      ];
    },
  });

  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource) {
      if (resource.scheme !== CLASS_REFERENCE_SCHEME) return false;
      const className = decodeURIComponent(resource.path.replace(/^\//, "")).replace(/\.cls$/i, "");
      const methodName = new URLSearchParams(resource.query).get(METHOD_QUERY_KEY) ?? undefined;
      goToClassReference(className, methodName);
      return true;
    },
  });
}
