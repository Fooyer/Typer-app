import type * as Monaco from "monaco-editor";
import { wireTextmateGrammar } from "./textmate/bridge";

/** Routines: .mac, .int — plain ObjectScript code, no Class/Method wrapper. */
export const OBJECTSCRIPT_LANGUAGE_ID = "objectscript";
/** Classes: .cls — Class/Method/Property/... declarations. */
export const OBJECTSCRIPT_CLASS_LANGUAGE_ID = "objectscript-class";
/** Include files: .inc — #define/#include macro preprocessor directives. */
export const OBJECTSCRIPT_MACROS_LANGUAGE_ID = "objectscript-macros";
/** Every ObjectScript-family language id, for providers (completion/hover/definition) that apply
 * equally regardless of which of the three grammars is tokenizing the file. */
export const OBJECTSCRIPT_LANGUAGE_IDS = [
  OBJECTSCRIPT_LANGUAGE_ID,
  OBJECTSCRIPT_CLASS_LANGUAGE_ID,
  OBJECTSCRIPT_MACROS_LANGUAGE_ID,
];

const LANGUAGE_ID_BY_EXTENSION: Record<string, string> = {
  ".cls": OBJECTSCRIPT_CLASS_LANGUAGE_ID,
  ".inc": OBJECTSCRIPT_MACROS_LANGUAGE_ID,
  ".mac": OBJECTSCRIPT_LANGUAGE_ID,
  ".int": OBJECTSCRIPT_LANGUAGE_ID,
  // Non-ObjectScript file kinds this editor also opens (Specs tab notes, etc.) — Monaco ships
  // tokenizers for these out of the box (see editor.main.js's language registrations), so there's
  // no reason to let them fall through to the ObjectScript grammar below like an unknown extension
  // would.
  ".md": "markdown",
  ".json": "json",
  ".txt": "plaintext",
};

/** Picks the Monaco language id for a file name by extension — each ObjectScript extension maps to
 * a differently-scoped TextMate grammar (see textmate/grammars.ts) since a .cls class body and a
 * .mac/.int routine body have different top-level syntax. Unrecognized extensions fall back to the
 * routine grammar, which is the more permissive of the two (a bare code body, no Class/Method
 * wrapper required). */
export function getObjectScriptLanguageId(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const extension = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  return LANGUAGE_ID_BY_EXTENSION[extension] ?? OBJECTSCRIPT_LANGUAGE_ID;
}

export const COMMANDS = [
  "break",
  "catch",
  "close",
  "continue",
  "do",
  "d",
  "else",
  "e",
  "for",
  "f",
  "goto",
  "g",
  "halt",
  "h",
  "hang",
  "if",
  "i",
  "job",
  "j",
  "kill",
  "k",
  "lock",
  "l",
  "merge",
  "m",
  "new",
  "n",
  "open",
  "o",
  "quit",
  "q",
  "read",
  "r",
  "return",
  "set",
  "s",
  "throw",
  "try",
  "tstart",
  "tcommit",
  "trollback",
  "use",
  "u",
  "view",
  "while",
  "w",
  "write",
  "xecute",
  "x",
  "zkill",
  "znspace",
  "ztrap",
  "zwrite",
];

export const CLASS_KEYWORDS = [
  "Class",
  "Extends",
  "Method",
  "ClassMethod",
  "Property",
  "Parameter",
  "Index",
  "Trigger",
  "XData",
  "Storage",
  "Query",
  "Relationship",
  "ForeignKey",
  "Projection",
  "Import",
  "Include",
];

let readyPromise: Promise<void> | null = null;

const LANGUAGE_CONFIG: Monaco.languages.LanguageConfiguration = {
  // Default word boundaries treat $ and % as separators, splitting "$Get"/"%RegisteredObject"/"$$$Macro"
  // into pieces — this keeps them as one word for hover, double-click-select, etc.
  wordPattern: /[$%]{0,3}[A-Za-z_]\w*/,
  comments: { lineComment: "//", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
  ],
};

/** Resolves once the ported TextMate grammars are wired in, so callers can wait to avoid an initial Monarch-highlighted flash. */
export function registerObjectScriptLanguage(monaco: typeof Monaco): Promise<void> {
  if (readyPromise) return readyPromise;

  monaco.languages.register({
    id: OBJECTSCRIPT_CLASS_LANGUAGE_ID,
    extensions: [".cls"],
    aliases: ["ObjectScript Class"],
  });
  monaco.languages.register({
    id: OBJECTSCRIPT_LANGUAGE_ID,
    extensions: [".mac", ".int"],
    aliases: ["ObjectScript", "objectscript"],
  });
  monaco.languages.register({
    id: OBJECTSCRIPT_MACROS_LANGUAGE_ID,
    extensions: [".inc"],
    aliases: ["ObjectScript Include"],
  });

  for (const languageId of OBJECTSCRIPT_LANGUAGE_IDS) {
    monaco.languages.setLanguageConfiguration(languageId, LANGUAGE_CONFIG);
  }

  // Instant fallback tokenizer shown while the ported TextMate grammars (below) load asynchronously
  // — same bootstrap Monarch definition for all three, since it's a rough approximation either way.
  const monarchTokenizer: Monaco.languages.IMonarchLanguage = {
    ignoreCase: true,
    defaultToken: "",
    commands: COMMANDS,
    classKeywords: CLASS_KEYWORDS,
    tokenizer: {
      root: [
        [/^Class\s/, { token: "keyword.class", next: "@classHeader" }],
        [/^(Method|ClassMethod|Property|Parameter|Index|Trigger|Query|XData)\b/, "keyword.class"],
        { include: "@code" },
      ],
      classHeader: [[/$/, { token: "", next: "@root" }], { include: "@code" }],
      code: [
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@blockComment"],
        [/##class\s*\(/, { token: "annotation", next: "@classRef" }],
        [/##(super|method|this)\b/, "annotation"],
        [/\$\$\$\w+/, "macro"],
        [/\$\$?\w+/, "variable.predefined"],
        [
          /\b\w+\b/,
          {
            cases: {
              "@commands": "keyword",
              "@classKeywords": "keyword.class",
              "@default": "identifier",
            },
          },
        ],
        [/""/, "string.escape"],
        [/"/, "string", "@string"],
        [/\d+(\.\d+)?/, "number"],
        [/[{}()[\]]/, "@brackets"],
        [/[<>=+\-*/_'&!]/, "operator"],
      ],
      classRef: [
        [/[^)]+/, "type"],
        [/\)/, { token: "annotation", next: "@pop" }],
      ],
      string: [
        [/""/, "string.escape"],
        [/[^"]+/, "string"],
        [/"/, "string", "@pop"],
      ],
      blockComment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  };
  for (const languageId of OBJECTSCRIPT_LANGUAGE_IDS) {
    monaco.languages.setMonarchTokensProvider(languageId, monarchTokenizer);
  }

  readyPromise = Promise.all([
    wireTextmateGrammar(monaco, OBJECTSCRIPT_CLASS_LANGUAGE_ID, "source.objectscript_class"),
    wireTextmateGrammar(monaco, OBJECTSCRIPT_LANGUAGE_ID, "source.objectscript"),
    wireTextmateGrammar(monaco, OBJECTSCRIPT_MACROS_LANGUAGE_ID, "source.objectscript_macros"),
  ]).then(() => {});
  return readyPromise;
}
