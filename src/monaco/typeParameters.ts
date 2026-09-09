export interface TypeParameter {
  name: string;
  default?: string;
  doc?: string;
}

/**
 * Curated fallback for the most commonly used %Library data types, used before a connection is
 * available or while the server's answer for a given type is still pending — same trade-off as
 * classMembers.ts's STATIC_OBJECT_MEMBERS. Not exhaustive (every data type has its own parameter
 * set); when a connection is available, the server's own %Dictionary.CompiledParameter answer
 * (accurate per type, real Default/Description) is layered on top and takes precedence.
 */
const OFFLINE_FALLBACKS: Record<string, TypeParameter[]> = {
  "%string": [
    { name: "MAXLEN", doc: "Tamanho máximo em caracteres." },
    { name: "MINLEN", doc: "Tamanho mínimo em caracteres." },
    { name: "PATTERN", doc: "Padrão de validação (pattern match ObjectScript)." },
    { name: "VALUELIST", doc: "Lista de valores válidos, separados por vírgula." },
    { name: "DISPLAYLIST", doc: "Rótulos exibidos para cada valor de VALUELIST, na mesma ordem." },
    { name: "TRUNCATE", doc: "Trunca o valor em vez de rejeitar quando excede MAXLEN." },
  ],
  "%integer": [
    { name: "MAXVAL", doc: "Valor máximo permitido." },
    { name: "MINVAL", doc: "Valor mínimo permitido." },
  ],
  "%smallint": [
    { name: "MAXVAL", doc: "Valor máximo permitido." },
    { name: "MINVAL", doc: "Valor mínimo permitido." },
  ],
  "%bigint": [
    { name: "MAXVAL", doc: "Valor máximo permitido." },
    { name: "MINVAL", doc: "Valor mínimo permitido." },
  ],
  "%numeric": [
    { name: "MAXVAL", doc: "Valor máximo permitido." },
    { name: "MINVAL", doc: "Valor mínimo permitido." },
    { name: "SCALE", doc: "Número de casas decimais." },
  ],
  "%decimal": [
    { name: "MAXVAL", doc: "Valor máximo permitido." },
    { name: "MINVAL", doc: "Valor mínimo permitido." },
    { name: "SCALE", doc: "Número de casas decimais." },
  ],
  "%date": [
    { name: "FORMAT", doc: "Formato de exibição/entrada da data ($ZDate)." },
    { name: "MAXVAL", doc: "Data máxima permitida ($Horolog)." },
    { name: "MINVAL", doc: "Data mínima permitida ($Horolog)." },
  ],
  "%time": [{ name: "FORMAT", doc: "Formato de exibição/entrada da hora ($ZTime)." }],
  "%timestamp": [{ name: "PRECISION", doc: "Casas decimais de precisão dos segundos." }],
};
// %Library.* is the same class as the bare %-name (e.g. %Library.String === %String) — alias both
// spellings to the same entries so the lookup doesn't miss just because of how the type was written.
for (const [key, value] of Object.entries(OFFLINE_FALLBACKS)) {
  OFFLINE_FALLBACKS[`%library.${key.slice(1)}`] = value;
}

let typeParameterProvider: ((typeName: string) => Promise<TypeParameter[]>) | null = null;

/** App.tsx wires this to query the active tab's connection/namespace for a data type's compiled
 * class parameters — see registerObjectScriptCompletion's `As Type(...)` completion. */
export function setTypeParameterProvider(
  fn: ((typeName: string) => Promise<TypeParameter[]>) | null,
): void {
  typeParameterProvider = fn;
  cache.clear();
}

const cache = new Map<string, Promise<TypeParameter[]>>();

/** Merges the server's real class parameters (if a connection is available) with the curated
 * fallback, caching per type name so repeated keystrokes while typing don't re-query the server. */
export async function getTypeParameters(typeName: string): Promise<TypeParameter[]> {
  const key = typeName.toLowerCase();
  const offlineFallback = OFFLINE_FALLBACKS[key] ?? [];
  if (!typeParameterProvider) return offlineFallback;

  let pending = cache.get(key);
  if (!pending) {
    pending = typeParameterProvider(typeName).catch(() => []);
    cache.set(key, pending);
  }
  const serverParams = await pending;
  if (serverParams.length === 0) return offlineFallback;

  const byName = new Map(serverParams.map((param) => [param.name.toLowerCase(), param]));
  for (const fallback of offlineFallback) {
    if (!byName.has(fallback.name.toLowerCase())) byName.set(fallback.name.toLowerCase(), fallback);
  }
  return [...byName.values()];
}
