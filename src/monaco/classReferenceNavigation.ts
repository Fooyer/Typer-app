import type * as Monaco from "monaco-editor";
import { OBJECTSCRIPT_LANGUAGE_IDS } from "./objectscript-language";

const CLASS_REFERENCE_SCHEME = "objectscript-class";

let openClassReference: ((className: string) => void) | null = null;

/** App.tsx wires this to "fetch + open/focus a tab for this class", using the active tab's
 * connection/namespace as context — see registerObjectScriptDefinition below for the trigger. */
export function setClassReferenceOpener(fn: ((className: string) => void) | null): void {
  openClassReference = fn;
}

export function goToClassReference(className: string): void {
  openClassReference?.(className);
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

let registered = false;

export function registerObjectScriptDefinition(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerDefinitionProvider(OBJECTSCRIPT_LANGUAGE_IDS, {
    provideDefinition(model, position) {
      const className = extractClassNameAt(model, position);
      if (!className) return null;
      return [
        {
          uri: monaco.Uri.parse(
            `${CLASS_REFERENCE_SCHEME}:///${encodeURIComponent(className)}.cls`,
          ),
          range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
        },
      ];
    },
  });

  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource) {
      if (resource.scheme !== CLASS_REFERENCE_SCHEME) return false;
      const className = decodeURIComponent(resource.path.replace(/^\//, "")).replace(/\.cls$/i, "");
      goToClassReference(className);
      return true;
    },
  });
}
