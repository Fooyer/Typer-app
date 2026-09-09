import type { IRawGrammar } from "vscode-textmate";
import objectscriptGrammar from "../grammars/vscode-objectscript/objectscript.tmLanguage.json";
import objectscriptClassGrammar from "../grammars/vscode-objectscript/objectscript-class.tmLanguage.json";
import objectscriptMacrosGrammar from "../grammars/vscode-objectscript/objectscript-macros.tmLanguage.json";
import xmlGrammar from "../grammars/vscode-xml/xml.tmLanguage.json";

/**
 * Grammars ported from InterSystems' MIT-licensed vscode-objectscript extension,
 * see src/monaco/grammars/vscode-objectscript/LICENSE.
 */
const RAW_GRAMMARS: Record<string, IRawGrammar> = {
  "source.objectscript": objectscriptGrammar as unknown as IRawGrammar,
  "source.objectscript_class": objectscriptClassGrammar as unknown as IRawGrammar,
  "source.objectscript_macros": objectscriptMacrosGrammar as unknown as IRawGrammar,
  // The class grammar's XData bodies (e.g. UrlMap) delegate to this external "text.xml" scope
  // (see objectscript-class.tmLanguage.json's "xdata"/"xml" rules) — without it registered here,
  // vscode-textmate can't resolve that include and XData content falls back to plain, unhighlighted
  // ObjectScript tokenizing. Ported from VS Code's own built-in XML grammar (MIT), see
  // src/monaco/grammars/vscode-xml/LICENSE.txt.
  "text.xml": xmlGrammar as unknown as IRawGrammar,
};

export function getRawGrammar(scopeName: string): IRawGrammar | undefined {
  return RAW_GRAMMARS[scopeName];
}
