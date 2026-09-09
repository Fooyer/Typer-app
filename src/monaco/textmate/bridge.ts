import type * as Monaco from "monaco-editor";
import { INITIAL, type StateStack } from "vscode-textmate";
import { getTextmateRegistry } from "./registry";

const wiredLanguages = new Set<string>();

/**
 * Wires a TextMate grammar (see src/monaco/textmate/grammars.ts) into a Monaco language
 * as its tokens provider. Ported from InterSystems' vscode-objectscript grammars rather than
 * the bootstrap Monarch tokenizer, for accurate ObjectScript syntax highlighting.
 */
export async function wireTextmateGrammar(
  monaco: typeof Monaco,
  languageId: string,
  scopeName: string,
) {
  if (wiredLanguages.has(languageId)) return;
  wiredLanguages.add(languageId);

  const grammar = await getTextmateRegistry().loadGrammar(scopeName);
  if (!grammar) {
    wiredLanguages.delete(languageId);
    return;
  }

  monaco.languages.setTokensProvider(languageId, {
    getInitialState: () => new TextmateState(INITIAL),
    tokenize(line, state) {
      const { ruleStack, tokens } = grammar.tokenizeLine(line, (state as TextmateState).ruleStack);
      return {
        endState: new TextmateState(ruleStack),
        tokens: tokens.map((token) => ({
          startIndex: token.startIndex,
          scopes: token.scopes[token.scopes.length - 1] ?? scopeName,
        })),
      };
    },
  });
}

class TextmateState implements Monaco.languages.IState {
  readonly ruleStack: StateStack;

  constructor(ruleStack: StateStack) {
    this.ruleStack = ruleStack;
  }

  clone(): Monaco.languages.IState {
    return new TextmateState(this.ruleStack);
  }

  equals(other: Monaco.languages.IState): boolean {
    return other instanceof TextmateState && this.ruleStack.equals(other.ruleStack);
  }
}
