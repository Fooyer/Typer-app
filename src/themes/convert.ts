import type * as Monaco from "monaco-editor";

export interface VSCodeThemeSetting {
  scope?: string | string[];
  settings: {
    foreground?: string;
    background?: string;
    fontStyle?: string;
  };
}

export interface VSCodeTheme {
  name?: string;
  colors: Record<string, string>;
  tokenColors: VSCodeThemeSetting[];
}

function stripHash(color: string | undefined): string | undefined {
  return color?.replace(/^#/, "");
}

/**
 * Fallback pairs for scopes our grammars emit that many themes never style directly, because they
 * either (a) split a delimiter from its content into its own `punctuation.definition.*` scope —
 * real VS Code falls back through the scope stack to the content's color, which Monaco's
 * single-scope-per-token model can't do on its own — or (b) use an ObjectScript-specific concept
 * (the `$$$macro` preprocessor sigil) most themes were never written with in mind. Each pair maps
 * the unstyled scope to the closest-matching scope the theme *does* style, so it inherits that
 * color instead of falling through to the plain default foreground.
 */
const SCOPE_FALLBACKS: [unstyled: string, inheritFrom: string][] = [
  ["punctuation.definition.string", "string"],
  ["punctuation.definition.comment", "comment"],
  // $$$macro references are compile-time constant expansions, closest in spirit to "constant".
  ["meta.preprocessor.objectscript", "constant"],
];

/** Converts a VS Code color theme (colors + TextMate tokenColors) into a Monaco theme definition. */
export function vscodeThemeToMonaco(
  theme: VSCodeTheme,
  base: Monaco.editor.BuiltinTheme = "vs-dark",
): Monaco.editor.IStandaloneThemeData {
  const rules: Monaco.editor.ITokenThemeRule[] = [];

  for (const entry of theme.tokenColors) {
    if (!entry.scope) continue;
    const scopes = Array.isArray(entry.scope)
      ? entry.scope
      : entry.scope.split(",").map((scope) => scope.trim());

    for (const scope of scopes) {
      if (!scope) continue;
      rules.push({
        token: scope,
        foreground: stripHash(entry.settings.foreground),
        background: stripHash(entry.settings.background),
        fontStyle: entry.settings.fontStyle,
      });
    }
  }

  for (const [unstyledScope, inheritFromScope] of SCOPE_FALLBACKS) {
    const alreadyStyled = rules.some(
      (rule) => rule.token === unstyledScope || unstyledScope.startsWith(rule.token),
    );
    if (alreadyStyled) continue;
    const sourceRule = rules.find((rule) => rule.token === inheritFromScope);
    if (sourceRule)
      rules.push({
        token: unstyledScope,
        foreground: sourceRule.foreground,
        fontStyle: sourceRule.fontStyle,
      });
  }

  return {
    base,
    inherit: true,
    rules,
    colors: theme.colors,
  };
}
