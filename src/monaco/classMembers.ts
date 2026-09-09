export interface ClassMember {
  name: string;
  kind: "method" | "property";
  classMethod: boolean;
  detail?: string;
  /** The method's declared return class, if any (from %Dictionary.CompiledMethod.ReturnType) — lets
   * `Set x = ##class(Y).SomeFactoryMethod()` infer x's type beyond just %New/%Open/%OpenId. */
  returnType?: string;
}

/**
 * A curated set of the %RegisteredObject/%Persistent lifecycle methods every ObjectScript object
 * class effectively has, used whenever there's no live connection to ask the server (or before the
 * server's answer comes back) — so `##class(X).` completion is still useful offline. When a
 * connection *is* available, the server's own compiled-member list (which already reflects
 * inheritance) is layered on top and takes precedence for anything it also defines.
 */
export const STATIC_OBJECT_MEMBERS: ClassMember[] = [
  {
    name: "%New",
    kind: "method",
    classMethod: true,
    detail: "(...) As %ObjectHandle — cria uma nova instância.",
  },
  {
    name: "%Open",
    kind: "method",
    classMethod: true,
    detail: "(id) As %ObjectHandle — abre uma instância existente por ID.",
  },
  {
    name: "%OpenId",
    kind: "method",
    classMethod: true,
    detail: "(id, concurrency, status) As %ObjectHandle",
  },
  {
    name: "%Save",
    kind: "method",
    classMethod: false,
    detail: "() As %Status — salva a instância.",
  },
  {
    name: "%Delete",
    kind: "method",
    classMethod: false,
    detail: "() As %Status — remove esta instância.",
  },
  {
    name: "%DeleteId",
    kind: "method",
    classMethod: true,
    detail: "(id) As %Status — remove uma instância por ID.",
  },
  { name: "%Exists", kind: "method", classMethod: false, detail: "() As %Boolean" },
  { name: "%ExistsId", kind: "method", classMethod: true, detail: "(id) As %Boolean" },
  {
    name: "%Id",
    kind: "method",
    classMethod: false,
    detail: "() As %String — o ID desta instância.",
  },
  { name: "%Oid", kind: "method", classMethod: false, detail: "() As %ObjectIdentity" },
  { name: "%ClassName", kind: "method", classMethod: false, detail: "(fullyQualified) As %String" },
  { name: "%IsA", kind: "method", classMethod: false, detail: "(className) As %Boolean" },
  { name: "%Extends", kind: "method", classMethod: true, detail: "(className) As %Boolean" },
  {
    name: "%ConstructClone",
    kind: "method",
    classMethod: false,
    detail: "(deep) As %ObjectHandle",
  },
  {
    name: "%GetParameter",
    kind: "method",
    classMethod: true,
    detail: "(name) — valor de um Parameter da classe.",
  },
  { name: "%ValidateObject", kind: "method", classMethod: false, detail: "() As %Status" },
  { name: "%DeepCompare", kind: "method", classMethod: false, detail: "(oref) As %Boolean" },
];

/** %DynamicObject/%DynamicArray (the `{...}`/`[...]` literal syntax) share this core API — %New/
 * %Save/%Open etc from STATIC_OBJECT_MEMBERS don't apply to them and would be actively misleading. */
const DYNAMIC_OBJECT_MEMBERS: ClassMember[] = [
  {
    name: "%Get",
    kind: "method",
    classMethod: false,
    detail: "(key, default, type) — lê uma propriedade/elemento.",
  },
  {
    name: "%Set",
    kind: "method",
    classMethod: false,
    detail: "(key, value, type) — define uma propriedade/elemento.",
  },
  {
    name: "%Remove",
    kind: "method",
    classMethod: false,
    detail: "(key) — remove uma propriedade/elemento.",
  },
  {
    name: "%GetIterator",
    kind: "method",
    classMethod: false,
    detail: "() — iterador para percorrer chaves/valores.",
  },
  {
    name: "%Size",
    kind: "method",
    classMethod: false,
    detail: "() As %Integer — número de elementos (array).",
  },
  { name: "%IsDefined", kind: "method", classMethod: false, detail: "(key) As %Boolean" },
  {
    name: "%ToJSON",
    kind: "method",
    classMethod: false,
    detail: "(target, options) As %Status — serializa como JSON.",
  },
  {
    name: "%Push",
    kind: "method",
    classMethod: false,
    detail: "(value, type) — adiciona ao fim (array).",
  },
  {
    name: "%Pop",
    kind: "method",
    classMethod: false,
    detail: "(type) — remove e retorna o último elemento (array).",
  },
  {
    name: "%FromJSON",
    kind: "method",
    classMethod: true,
    detail: "(stream/string) — cria a partir de texto JSON.",
  },
  {
    name: "%Count",
    kind: "method",
    classMethod: false,
    detail: "() As %Integer — número de elementos (array).",
  },
];

const OFFLINE_FALLBACKS: Record<string, ClassMember[]> = {
  "%library.dynamicobject": DYNAMIC_OBJECT_MEMBERS,
  "%dynamicobject": DYNAMIC_OBJECT_MEMBERS,
  "%library.dynamicarray": DYNAMIC_OBJECT_MEMBERS,
  "%dynamicarray": DYNAMIC_OBJECT_MEMBERS,
};

let memberProvider: ((className: string) => Promise<ClassMember[]>) | null = null;

/** App.tsx wires this to query the active tab's connection/namespace for a class's compiled
 * methods/properties — see registerObjectScriptCompletion's dot-completion for the trigger. */
export function setClassMemberProvider(
  fn: ((className: string) => Promise<ClassMember[]>) | null,
): void {
  memberProvider = fn;
  cache.clear();
}

const cache = new Map<string, Promise<ClassMember[]>>();

/** Merges the server's compiled members (if a connection is available) with a static fallback
 * (class-specific when we have one, otherwise the generic %RegisteredObject-ish set), caching per
 * class name so repeated keystrokes while typing don't re-query the server. */
export async function getClassMembers(className: string): Promise<ClassMember[]> {
  const key = className.toLowerCase();
  const offlineFallback = OFFLINE_FALLBACKS[key] ?? STATIC_OBJECT_MEMBERS;
  if (!memberProvider) return offlineFallback;

  let pending = cache.get(key);
  if (!pending) {
    pending = memberProvider(className).catch(() => []);
    cache.set(key, pending);
  }
  const serverMembers = await pending;
  if (serverMembers.length === 0) return offlineFallback;

  const byName = new Map(serverMembers.map((member) => [member.name.toLowerCase(), member]));
  for (const fallback of offlineFallback) {
    if (!byName.has(fallback.name.toLowerCase())) byName.set(fallback.name.toLowerCase(), fallback);
  }
  return [...byName.values()];
}
