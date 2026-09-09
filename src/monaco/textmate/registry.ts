import { Registry } from "vscode-textmate";
import { getOnigLib } from "./oniguruma";
import { getRawGrammar } from "./grammars";

let registry: Registry | null = null;

export function getTextmateRegistry(): Registry {
  registry ??= new Registry({
    onigLib: getOnigLib(),
    loadGrammar: async (scopeName) => getRawGrammar(scopeName) ?? null,
  });
  return registry;
}
