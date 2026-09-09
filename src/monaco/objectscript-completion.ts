import type * as Monaco from "monaco-editor";
import { CLASS_KEYWORDS, COMMANDS, OBJECTSCRIPT_LANGUAGE_IDS } from "./objectscript-language";
import { getKnownClasses } from "./classIndex";
import { getClassMembers, type ClassMember } from "./classMembers";
import {
  collectLocalIdentifiers,
  parseCurrentClassName,
  resolveVariableType,
} from "./objectscriptTypeResolver";
import { DATA_TYPES, SYSTEM_CLASSES } from "./objectscriptDataTypes";
import { getTypeParameters } from "./typeParameters";

interface IntrinsicFunction {
  name: string;
  snippet: string;
  doc: string;
}

/** A curated starter set of the most commonly used ObjectScript intrinsic ($) functions — not exhaustive. */
const INTRINSIC_FUNCTIONS: IntrinsicFunction[] = [
  {
    name: "$Get",
    snippet: "$Get(${1:expr}${2:,default})",
    doc: "Retorna o valor de uma variável/nó, ou um default se indefinido.",
  },
  {
    name: "$Piece",
    snippet: "$Piece(${1:string},${2:delim}${3:,piece})",
    doc: "Extrai uma peça delimitada de uma string.",
  },
  {
    name: "$Order",
    snippet: "$Order(${1:subscript})",
    doc: "Percorre os subscritos de um array/global em ordem.",
  },
  {
    name: "$Data",
    snippet: "$Data(${1:var})",
    doc: "Verifica se uma variável está definida (e se tem descendentes).",
  },
  {
    name: "$Select",
    snippet: "$Select(${1:cond}:${2:value})",
    doc: "Avalia condições em sequência, retorna o valor da primeira verdadeira.",
  },
  {
    name: "$Case",
    snippet: "$Case(${1:expr},${2:val}:${3:result},:${4:default})",
    doc: "Compara uma expressão contra vários valores possíveis.",
  },
  {
    name: "$ListBuild",
    snippet: "$ListBuild(${1:val1})",
    doc: "Constrói uma $list a partir de valores.",
  },
  {
    name: "$ListGet",
    snippet: "$ListGet(${1:list}${2:,position})",
    doc: "Extrai um elemento de uma $list pela posição.",
  },
  {
    name: "$ListLength",
    snippet: "$ListLength(${1:list})",
    doc: "Número de elementos de uma $list.",
  },
  {
    name: "$Increment",
    snippet: "$Increment(${1:var})",
    doc: "Incrementa atomicamente um contador/global.",
  },
  {
    name: "$Extract",
    snippet: "$Extract(${1:string}${2:,start${3:,end}})",
    doc: "Extrai uma substring por posição de caractere.",
  },
  {
    name: "$Length",
    snippet: "$Length(${1:string}${2:,delim})",
    doc: "Tamanho de uma string, ou número de peças se delim informado.",
  },
  {
    name: "$Find",
    snippet: "$Find(${1:string},${2:substring})",
    doc: "Posição de uma substring dentro de uma string.",
  },
  {
    name: "$Translate",
    snippet: "$Translate(${1:string},${2:from}${3:,to})",
    doc: "Substitui/remove caracteres de uma string.",
  },
  {
    name: "$ZDateTime",
    snippet: "$ZDateTime(${1:$Horolog})",
    doc: "Formata um valor $Horolog como data/hora.",
  },
  { name: "$ZDate", snippet: "$ZDate(${1:$Horolog})", doc: "Formata um valor $Horolog como data." },
  {
    name: "$ClassName",
    snippet: "$ClassName(${1:oref})",
    doc: "Nome da classe de uma referência de objeto.",
  },
  {
    name: "$IsObject",
    snippet: "$IsObject(${1:expr})",
    doc: "Verifica se um valor é uma referência de objeto válida.",
  },
  {
    name: "$This",
    snippet: "$This",
    doc: "Referência ao objeto atual (dentro de um método de instância).",
  },
  { name: "$Random", snippet: "$Random(${1:n})", doc: "Número aleatório entre 0 e n-1." },
  {
    name: "$Justify",
    snippet: "$Justify(${1:expr},${2:width})",
    doc: "Formata um valor justificado numa largura fixa.",
  },
  {
    name: "$System",
    snippet: "$System.${1:Util}",
    doc: "Acesso às classes utilitárias do sistema (%SYSTEM.*) — continue digitando após o ponto.",
  },
  {
    name: "$ZConvert",
    snippet: "$ZConvert(${1:string},${2:code})",
    doc: "Converte uma string (maiúsculas/minúsculas, codificação, etc).",
  },
  {
    name: "$ZStrip",
    snippet: "$ZStrip(${1:string},${2:code})",
    doc: "Remove espaços/caracteres de controle de uma string.",
  },
  {
    name: "$Horolog",
    snippet: "$Horolog",
    doc: "Data e hora atuais do sistema, no formato interno (dias,segundos).",
  },
  { name: "$Job", snippet: "$Job", doc: "Número do processo atual." },
  {
    name: "$Username",
    snippet: "$Username",
    doc: "Nome do usuário autenticado no processo atual.",
  },
  { name: "$Namespace", snippet: "$Namespace", doc: "Namespace atual do processo." },
  {
    name: "$Test",
    snippet: "$Test",
    doc: "Resultado (0/1) do último comando condicional (If/Lock com timeout, etc).",
  },
];

interface MemberKeyword {
  name: string;
  doc: string;
  /** Snippet body for keywords that take a value (e.g. "InitialExpression = ${1:value}"); plain
   * flag keywords (Required, Private, ...) omit this and insert just their name. */
  snippet?: string;
}

/** The `[ Required, Private, ... ]` attribute list after a member declaration. These are fixed
 * ObjectScript-language keywords — not server data — so, like CLASS_KEYWORDS/COMMANDS, they're a
 * hardcoded (curated, not exhaustive) list here rather than fetched; Studio/vscode-objectscript do
 * the same, since there's no Atelier endpoint that hands these out. */
const PROPERTY_KEYWORDS: MemberKeyword[] = [
  {
    name: "Required",
    doc: "Propriedade obrigatória — não pode ficar indefinida ao salvar o objeto.",
  },
  { name: "Private", doc: "Só pode ser lida/definida a partir de métodos da própria classe." },
  { name: "ReadOnly", doc: "Não tem setter público; só pode ser definida internamente na classe." },
  { name: "Calculated", doc: "Valor calculado — não ocupa armazenamento próprio no objeto." },
  {
    name: "SqlComputed",
    doc: "Coluna calculada no SQL (normalmente combinada com SqlComputeCode).",
  },
  {
    name: "SqlComputeCode",
    doc: "Código ObjectScript que calcula o valor da coluna SQL.",
    snippet: "SqlComputeCode = { ${1} }",
  },
  { name: "Transient", doc: "Não é persistida — não vai para o banco de dados." },
  {
    name: "InitialExpression",
    doc: "Valor padrão atribuído quando o objeto é criado.",
    snippet: "InitialExpression = ${1:value}",
  },
  {
    name: "MultiDimensional",
    doc: "Propriedade é um array multidimensional, não um valor escalar.",
  },
  { name: "Internal", doc: "Oculta a propriedade de ferramentas/telas voltadas ao usuário final." },
  { name: "Final", doc: "Não pode ser redefinida em subclasses." },
  { name: "Identity", doc: "Usada como identidade única do objeto (no máximo uma por classe)." },
  {
    name: "Collection",
    doc: "Torna a propriedade uma coleção.",
    snippet: "Collection = ${1:list}",
  },
  {
    name: "Cardinality",
    doc: "Cardinalidade de um relacionamento.",
    snippet: "Cardinality = ${1:one}",
  },
  {
    name: "SqlFieldName",
    doc: "Nome alternativo da coluna projetada no SQL.",
    snippet: "SqlFieldName = ${1:Name}",
  },
  {
    name: "SqlColumnNumber",
    doc: "Número de coluna SQL fixo para esta propriedade.",
    snippet: "SqlColumnNumber = ${1:1}",
  },
  {
    name: "Aliases",
    doc: "Nomes alternativos aceitos para esta propriedade.",
    snippet: "Aliases = ${1:Name}",
  },
  { name: "Deprecated", doc: "Marca a propriedade como obsoleta (aviso de compilação ao usá-la)." },
];

const PARAMETER_KEYWORDS: MemberKeyword[] = [
  { name: "Abstract", doc: "Deve ser redefinido com um valor em subclasses concretas." },
  { name: "Final", doc: "Não pode ser redefinido em subclasses." },
  { name: "Internal", doc: "Oculta o parâmetro de ferramentas voltadas ao usuário final." },
  { name: "Deprecated", doc: "Marca o parâmetro como obsoleto." },
  {
    name: "Flags",
    doc: "Flags especiais do parâmetro (ex.: ENUM para lista de valores válidos).",
    snippet: "Flags = ${1:ENUM}",
  },
  { name: "Type", doc: "Tipo de dado do valor do parâmetro.", snippet: "Type = ${1:%String}" },
  {
    name: "Constraint",
    doc: "Restringe os valores aceitos pelo parâmetro.",
    snippet: "Constraint = ${1:value}",
  },
];

const METHOD_KEYWORDS: MemberKeyword[] = [
  { name: "Abstract", doc: "Deve ser implementado em subclasses concretas." },
  { name: "Final", doc: "Não pode ser sobrescrito em subclasses." },
  { name: "Private", doc: "Só pode ser chamado a partir de métodos da própria classe." },
  {
    name: "PublicList",
    doc: "Variáveis que continuam visíveis para quem chama o método.",
    snippet: "PublicList = ${1:var}",
  },
  {
    name: "ProcedureBlock",
    doc: "Força escopo de variáveis isolado (bloco de procedimento) neste método.",
  },
  {
    name: "CodeMode",
    doc: "Como o corpo do método é interpretado.",
    snippet: "CodeMode = ${1:code}",
  },
  { name: "ServerOnly", doc: "Método só pode rodar no servidor.", snippet: "ServerOnly = ${1:1}" },
  { name: "SqlProc", doc: "Expõe o método como stored procedure SQL." },
  { name: "SqlName", doc: "Nome alternativo exposto no SQL/SOAP.", snippet: "SqlName = ${1:Name}" },
  { name: "WebMethod", doc: "Expõe o método como operação de web service SOAP." },
  {
    name: "SoapAction",
    doc: "Nome da SOAP action usada para expor este método.",
    snippet: "SoapAction = ${1:Name}",
  },
  {
    name: "Language",
    doc: "Linguagem do corpo do método.",
    snippet: "Language = ${1:objectscript}",
  },
  { name: "ReturnResultsets", doc: "Método retorna um ou mais result sets." },
  { name: "Internal", doc: "Oculta o método de ferramentas voltadas ao usuário final." },
  { name: "Deprecated", doc: "Marca o método como obsoleto." },
];

const INDEX_KEYWORDS: MemberKeyword[] = [
  { name: "Unique", doc: "Não permite valores duplicados no índice." },
  { name: "PrimaryKey", doc: "Define este índice como chave primária da tabela." },
  { name: "IdKey", doc: "Índice usado para gerar/validar o ID do objeto." },
  {
    name: "Type",
    doc: "Tipo de implementação do índice (key/bitmap/bitslice/...).",
    snippet: "Type = ${1:key}",
  },
  {
    name: "Data",
    doc: "Propriedades adicionais armazenadas junto ao índice.",
    snippet: "Data = ${1:Property}",
  },
  {
    name: "Condition",
    doc: "Indexa só as linhas que satisfazem esta condição.",
    snippet: "Condition = ${1:expression}",
  },
  { name: "Extent", doc: "Índice cobre todos os objetos da extensão." },
  { name: "ShardKey", doc: "Define este índice como a chave de sharding da tabela." },
  { name: "Internal", doc: "Oculta o índice de ferramentas voltadas ao usuário final." },
];

const TRIGGER_KEYWORDS: MemberKeyword[] = [
  {
    name: "Event",
    doc: "Evento(s) que disparam o trigger (INSERT/UPDATE/DELETE).",
    snippet: "Event = ${1:INSERT}",
  },
  {
    name: "Time",
    doc: "Quando o trigger roda em relação à operação.",
    snippet: "Time = ${1:AFTER}",
  },
  {
    name: "Foreach",
    doc: "Se o trigger dispara por linha ou por statement.",
    snippet: "Foreach = ${1:row}",
  },
  {
    name: "Order",
    doc: "Ordem de execução entre triggers do mesmo evento.",
    snippet: "Order = ${1:1}",
  },
  { name: "SqlName", doc: "Nome alternativo do trigger no SQL.", snippet: "SqlName = ${1:Name}" },
  {
    name: "UpdateColumnList",
    doc: "Limita um trigger de UPDATE a disparar só quando estas colunas mudam.",
    snippet: "UpdateColumnList = ${1:Column}",
  },
  {
    name: "Language",
    doc: "Linguagem do corpo do trigger.",
    snippet: "Language = ${1:objectscript}",
  },
];

const CLASS_HEADER_KEYWORDS: MemberKeyword[] = [
  { name: "Abstract", doc: "Classe abstrata — não pode ser instanciada diretamente." },
  { name: "Final", doc: "Classe não pode ser estendida por subclasses." },
  { name: "NoExtent", doc: "Classe não é persistida em uma extensão própria." },
  {
    name: "ProcedureBlock",
    doc: "Força escopo de variáveis isolado por padrão em todos os métodos da classe.",
  },
  {
    name: "System",
    doc: "Marca a classe como parte do sistema (nível 1-4).",
    snippet: "System = ${1:1}",
  },
  {
    name: "Inheritance",
    doc: "Ordem de resolução de herança múltipla.",
    snippet: "Inheritance = ${1:left}",
  },
  { name: "ClassType", doc: "Tipo da classe.", snippet: "ClassType = ${1:persistent}" },
  { name: "DdlAllowed", doc: "Permite alterar a classe via DDL (CREATE/ALTER TABLE)." },
  { name: "Deprecated", doc: "Marca a classe como obsoleta." },
  { name: "Hidden", doc: "Esconde a classe de ferramentas de navegação." },
  { name: "Internal", doc: "Oculta a classe de ferramentas voltadas ao usuário final." },
  {
    name: "GeneratedBy",
    doc: "Classe/ferramenta que gerou esta classe automaticamente.",
    snippet: "GeneratedBy = ${1:Name}",
  },
  {
    name: "CompileAfter",
    doc: "Força esta classe a compilar depois da(s) classe(s) listada(s).",
    snippet: "CompileAfter = ${1:Package.Class}",
  },
  {
    name: "DependsOn",
    doc: "Classe(s) das quais esta depende para compilar.",
    snippet: "DependsOn = ${1:Package.Class}",
  },
  {
    name: "Owner",
    doc: "Papel/role dono da classe (segurança).",
    snippet: "Owner = ${1:%Manager}",
  },
];

const MEMBER_KEYWORDS_BY_DECLARATION: Record<string, MemberKeyword[]> = {
  class: CLASS_HEADER_KEYWORDS,
  property: PROPERTY_KEYWORDS,
  parameter: PARAMETER_KEYWORDS,
  method: METHOD_KEYWORDS,
  classmethod: METHOD_KEYWORDS,
  index: INDEX_KEYWORDS,
  trigger: TRIGGER_KEYWORDS,
};

interface Snippet {
  label: string;
  doc: string;
  body: string;
}

const SNIPPETS: Snippet[] = [
  {
    label: "Class",
    doc: "Esqueleto de definição de classe",
    body: "Class ${1:Package.ClassName} Extends ${2:%RegisteredObject}\n{\n\n$0\n}\n",
  },
  {
    label: "ClassMethod",
    doc: "Esqueleto de ClassMethod",
    body: "ClassMethod ${1:MethodName}(${2:}) As ${3:%Status}\n{\n\t$0\n}",
  },
  {
    label: "Method",
    doc: "Esqueleto de Method (instância)",
    body: "Method ${1:MethodName}(${2:}) As ${3:%Status}\n{\n\t$0\n}",
  },
  {
    label: "Property",
    doc: "Declaração de propriedade",
    body: "Property ${1:Name} As ${2:%String};",
  },
  {
    label: "Parameter",
    doc: "Declaração de parâmetro de classe",
    body: 'Parameter ${1:Name} = ${2:"value"};',
  },
  {
    label: "Index",
    doc: "Declaração de índice",
    body: "Index ${1:Name} On ${2:Property};",
  },
  {
    label: "Trigger",
    doc: "Esqueleto de Trigger",
    body: "Trigger ${1:Name} [ Event = ${2:INSERT} ]\n{\n\t$0\n}",
  },
  {
    label: "Query",
    doc: "Esqueleto de Query",
    body: "Query ${1:Name}(${2:}) As %SQLQuery(CONTAINID = 1)\n{\n\tSELECT $0\n}",
  },
  {
    label: "XData",
    doc: "Bloco de dados XData (ex: UrlMap)",
    body: "XData ${1:UrlMap}\n{\n$0\n}",
  },
  {
    label: "trycatch",
    doc: "Bloco Try/Catch",
    body: "Try {\n\t$1\n}\nCatch ${2:ex} {\n\t$0\n}",
  },
  {
    label: "for",
    doc: "Loop For numérico",
    body: "For ${1:i}=${2:1}:${3:1}:${4:10} {\n\t$0\n}",
  },
  {
    label: "ifelse",
    doc: "If / Else",
    body: "If ${1:condition} {\n\t$2\n} Else {\n\t$0\n}",
  },
];

let registered = false;

function memberSuggestions(
  monaco: typeof Monaco,
  members: ClassMember[],
  range: Monaco.IRange,
): Monaco.languages.CompletionItem[] {
  return members.map((member) => ({
    label: member.name,
    kind:
      member.kind === "property"
        ? monaco.languages.CompletionItemKind.Property
        : monaco.languages.CompletionItemKind.Method,
    insertText: member.name,
    detail:
      member.detail ??
      (member.kind === "property" ? "property" : member.classMethod ? "class method" : "method"),
    range,
  }));
}

/**
 * Class names for any "type a class name here" context: `##class(`, `Extends`, `As`. Merges two
 * sources — getKnownClasses() (the *actual* classes in the currently browsed namespace, kept lean by
 * excluding system classes, per ConnectionsPanel/documentTree's own "keep the explorer light" design)
 * with DATA_TYPES (a curated, hand-picked list of the framework/system base classes people actually
 * type — %CSP.REST, %Persistent, %SOAP.WebService, ...). A live fetch of IRIS's full system-class
 * list (tens of thousands of classes) would defeat the point of keeping the namespace load light, so
 * this is the same "not exhaustive, covers what's typed by hand" trade-off DATA_TYPES already makes.
 */
function classNameSuggestions(
  monaco: typeof Monaco,
  range: Monaco.IRange,
): Monaco.languages.CompletionItem[] {
  const seen = new Set<string>();
  const suggestions: Monaco.languages.CompletionItem[] = [];
  for (const name of getKnownClasses()) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    suggestions.push({
      label: name,
      kind: monaco.languages.CompletionItemKind.Class,
      insertText: name,
      range,
    });
  }
  for (const entry of DATA_TYPES) {
    if (seen.has(entry.name.toLowerCase())) continue;
    seen.add(entry.name.toLowerCase());
    suggestions.push({
      label: entry.name,
      kind: monaco.languages.CompletionItemKind.Class,
      insertText: entry.name,
      detail: entry.detail,
      range,
    });
  }
  return suggestions;
}

/**
 * Class names can contain dots ("%CSP.REST"), but the language's wordPattern deliberately doesn't
 * treat "." as part of a word (so "..Property" self-reference and member-completion-after-a-dot see
 * a clean word boundary right after the dot). That means the generic word-based range only ever
 * covers the last dotted segment — e.g. typing "%CSP." and accepting "%CSP.REST" replaced just the
 * (empty) text after the trailing dot, leaving the already-typed "%CSP." in place and producing
 * "%CSP.%CSP.REST". This instead walks back from the cursor over the *whole* dotted name so accepting
 * a suggestion replaces all of what was already typed.
 */
function classNamePrefixRange(textUntilPosition: string, position: Monaco.Position): Monaco.IRange {
  const prefixLength = /[%\w.]*$/.exec(textUntilPosition)?.[0].length ?? 0;
  return {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: position.column - prefixLength,
    endColumn: position.column,
  };
}

/** Registers keyword/intrinsic-function/snippet completions, plus `##class(...)` class-name
 * completion sourced from whatever namespace ConnectionsPanel last listed (see classIndex.ts), and
 * member completion after a dot — `##class(X).`, `..` (self-reference), or `variable.` where
 * `variable`'s type could be resolved from a formal parameter or property declaration (see
 * classMembers.ts / objectscriptTypeResolver.ts). */
export function registerObjectScriptCompletion(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerCompletionItemProvider(OBJECTSCRIPT_LANGUAGE_IDS, {
    triggerCharacters: ["$", "#", "."],
    async provideCompletionItems(model, position) {
      const textUntilPosition = model.getValueInRange({
        startLineNumber: position.lineNumber,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const wordInfo = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: wordInfo.startColumn,
        endColumn: wordInfo.endColumn,
      };

      if (/##class\(\s*[%\w.]*$/i.test(textUntilPosition)) {
        return {
          suggestions: classNameSuggestions(
            monaco,
            classNamePrefixRange(textUntilPosition, position),
          ),
        };
      }

      // Extends X  /  Extends (X, Y, ... — the class header's superclass list, single or multiple.
      if (/\bExtends\s*\(?\s*(?:[%\w.]+\s*,\s*)*[%\w.]*$/i.test(textUntilPosition)) {
        return {
          suggestions: classNameSuggestions(
            monaco,
            classNamePrefixRange(textUntilPosition, position),
          ),
        };
      }

      // ##class(Some.Class). — only class methods (incl. %New/%Open/...) are callable this way.
      const classMemberMatch = /##class\(\s*([%\w][\w.]*)\s*\)\s*\.\s*[%\w]*$/i.exec(
        textUntilPosition,
      );
      if (classMemberMatch) {
        const members = await getClassMembers(classMemberMatch[1]);
        return {
          suggestions: memberSuggestions(
            monaco,
            members.filter((m) => m.classMethod),
            range,
          ),
        };
      }

      // ..Property / ..Method() — self-reference to the current class's own members.
      if (/(?:^|[^.])\.\.\s*[%\w]*$/.test(textUntilPosition)) {
        const className = parseCurrentClassName(model);
        if (className) {
          const members = await getClassMembers(className);
          return { suggestions: memberSuggestions(monaco, members, range) };
        }
      }

      // variable. — resolvable when the variable's type is written down (a formal parameter or a
      // Property declaration) or inferable from a `Set x = ##class(Y).Method(...)` assignment.
      const varMatch = /([%\p{L}_][\p{L}\p{N}_]*)\.\s*[%\w]*$/u.exec(textUntilPosition);
      if (varMatch) {
        const className = await resolveVariableType(model, position, varMatch[1]);
        if (className) {
          const members = await getClassMembers(className);
          return { suggestions: memberSuggestions(monaco, members, range) };
        }
      }

      // $System.Util. — member completion for a $SYSTEM.* utility class (a real class under the
      // hood, so this reuses the normal class-member lookup once resolved to its %SYSTEM.X name).
      const systemMemberMatch = /\$system\.(\w+)\.\s*[%\w]*$/i.exec(textUntilPosition);
      if (systemMemberMatch) {
        const members = await getClassMembers(`%SYSTEM.${systemMemberMatch[1]}`);
        return {
          suggestions: memberSuggestions(
            monaco,
            members.filter((m) => m.classMethod),
            range,
          ),
        };
      }

      // $System. — which %SYSTEM.* utility class.
      if (/\$system\.\w*$/i.test(textUntilPosition)) {
        return {
          suggestions: SYSTEM_CLASSES.map((entry) => ({
            label: entry.name,
            kind: monaco.languages.CompletionItemKind.Module,
            insertText: entry.name,
            detail: entry.detail,
            range,
          })),
        };
      }

      // As Type(...) / As Type [ Keywords ] (...) — the type's own class-parameter list (e.g.
      // %String's MAXLEN/PATTERN/VALUELIST). COS allows this parenthesized list either right after
      // the type name or after the `[ ... ]` keyword list (both compile), so both are matched here.
      // Queried live per type from %Dictionary.CompiledParameter (see typeParameters.ts) — same
      // "real server data over a hardcoded, type-agnostic guess" approach as ##class(X). member
      // completion, since a hardcoded list would be actively wrong for most types (MAXLEN doesn't
      // apply to %Integer, MAXVAL doesn't apply to %String, etc).
      const typeParamMatch = /\bAs\s+([%\w.]+)\s*(?:\[[^\]]*\]\s*)?\([^)]*$/i.exec(
        textUntilPosition,
      );
      if (typeParamMatch) {
        const params = await getTypeParameters(typeParamMatch[1]);
        return {
          suggestions: params.map((param) => ({
            label: param.name,
            kind: monaco.languages.CompletionItemKind.Property,
            insertText: `${param.name} = \${1}`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            detail: param.default ? `padrão: ${param.default}` : "parâmetro de tipo",
            documentation: param.doc,
            range,
          })),
        };
      }

      // As Type — Property/Parameter/method-return type position.
      if (/\bAs\s+[%\w.]*$/i.test(textUntilPosition)) {
        return {
          suggestions: classNameSuggestions(
            monaco,
            classNamePrefixRange(textUntilPosition, position),
          ),
        };
      }

      // [ Required, Private, ... ] — member-attribute keywords. Only looks at the current line (like
      // every other branch here), so it covers the common single-line `Property X As %String [ ... ]`
      // case but not a keyword list whose opening "[" was itself wrapped onto its own line.
      const bracketMatch =
        /^\s*(Class|Property|Parameter|Method|ClassMethod|Index|Trigger)\b[^[\n]*\[[^\]]*$/i.exec(
          textUntilPosition,
        );
      if (bracketMatch) {
        const keywords = MEMBER_KEYWORDS_BY_DECLARATION[bracketMatch[1].toLowerCase()];
        if (keywords) {
          return {
            suggestions: keywords.map((keyword) => ({
              label: keyword.name,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: keyword.snippet ?? keyword.name,
              insertTextRules: keyword.snippet
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
              documentation: keyword.doc,
              detail: "atributo de declaração",
              range,
            })),
          };
        }
      }

      if (/\$[\w]*$/.test(textUntilPosition)) {
        return {
          suggestions: INTRINSIC_FUNCTIONS.map((fn) => ({
            label: fn.name,
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: fn.snippet,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: fn.doc,
            detail: "ObjectScript intrinsic",
            range,
          })),
        };
      }

      const suggestions: Monaco.languages.CompletionItem[] = [
        ...collectLocalIdentifiers(model, position).map((name) => ({
          label: name,
          kind: monaco.languages.CompletionItemKind.Variable,
          insertText: name,
          detail: "variável local",
          range,
        })),
        ...COMMANDS.map((command) => ({
          label: command,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: command,
          detail: "comando",
          range,
        })),
        ...CLASS_KEYWORDS.map((keyword) => ({
          label: keyword,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: keyword,
          detail: "palavra-chave de classe",
          range,
        })),
        ...SNIPPETS.map((snippet) => ({
          label: snippet.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: snippet.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: snippet.doc,
          detail: "snippet",
          range,
        })),
      ];
      return { suggestions };
    },
  });
}
