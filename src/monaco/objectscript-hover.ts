import type * as Monaco from "monaco-editor";
import { OBJECTSCRIPT_LANGUAGE_IDS } from "./objectscript-language";

interface WordDoc {
  name: string;
  kind: string;
  syntax: string;
  doc: string;
}

/** Command docs keyed by every accepted spelling (full name and standard abbreviation), lowercased. */
const COMMAND_DOCS: Record<string, WordDoc> = {};
function addCommand(names: string[], canonical: string, syntax: string, doc: string) {
  for (const name of names)
    COMMAND_DOCS[name.toLowerCase()] = { name: canonical, kind: "comando", syntax, doc };
}

addCommand(
  ["break", "b"],
  "Break",
  "BREAK",
  "Suspende a execução e entra no modo de depuração/Programmer's Mode.",
);
addCommand(
  ["catch"],
  "Catch",
  "CATCH var { ... }",
  "Captura uma exceção lançada dentro de um bloco Try.",
);
addCommand(
  ["close", "c"],
  "Close",
  "CLOSE device",
  "Fecha um dispositivo de I/O previamente aberto com Open.",
);
addCommand(
  ["continue"],
  "Continue",
  "CONTINUE",
  "Pula para a próxima iteração do loop mais interno (For/While).",
);
addCommand(
  ["do", "d"],
  "Do",
  "DO label^routine  |  DO obj.Method()",
  "Executa uma rotina, método ou bloco { ... }, retornando ao ponto de chamada ao terminar.",
);
addCommand(
  ["else", "e"],
  "Else",
  "ELSE { ... }",
  "Executa um bloco quando a condição do If anterior foi falsa.",
);
addCommand(
  ["for", "f"],
  "For",
  "FOR i=start:incr:end { ... }",
  "Loop numérico, ou iteração sobre os nós de um array/global.",
);
addCommand(
  ["goto", "g"],
  "Goto",
  "GOTO label",
  "Transfere o controle da execução para um rótulo (label).",
);
addCommand(["halt"], "Halt", "HALT", "Encerra o processo atual.");
addCommand(
  ["hang", "h"],
  "Hang",
  "HANG seconds",
  "Pausa a execução pelo número de segundos especificado.",
);
addCommand(["if", "i"], "If", "IF condition { ... }", "Executa um bloco condicionalmente.");
addCommand(
  ["job", "j"],
  "Job",
  "JOB label^routine",
  "Inicia um novo processo em segundo plano executando uma rotina.",
);
addCommand(
  ["kill", "k"],
  "Kill",
  "KILL var",
  "Remove uma variável, nó de array, ou global — e todos os seus descendentes.",
);
addCommand(
  ["lock", "l"],
  "Lock",
  "LOCK +resource",
  "Adquire ou libera um lock cooperativo sobre um recurso nomeado.",
);
addCommand(
  ["merge", "m"],
  "Merge",
  "MERGE dest = source",
  "Copia uma árvore inteira de subscritos de um array/global para outro.",
);
addCommand(
  ["new", "n"],
  "New",
  "NEW var",
  "Cria um novo escopo para uma variável, salvando e restaurando seu valor anterior ao sair.",
);
addCommand(
  ["open", "o"],
  "Open",
  "OPEN device",
  "Abre um dispositivo de I/O (arquivo, socket, impressora, etc.).",
);
addCommand(
  ["quit", "q"],
  "Quit",
  "QUIT [expr]",
  "Sai do bloco/rotina/método atual, opcionalmente retornando um valor.",
);
addCommand(
  ["read", "r"],
  "Read",
  "READ var",
  "Lê uma entrada de um dispositivo (por padrão, o terminal).",
);
addCommand(
  ["return"],
  "Return",
  "RETURN [expr]",
  "Sai do método atual, opcionalmente retornando um valor.",
);
addCommand(
  ["set", "s"],
  "Set",
  "SET var = expr",
  "Atribui um valor a uma variável, propriedade, ou nó de array/global.",
);
addCommand(
  ["throw"],
  "Throw",
  "THROW exception",
  "Lança uma exceção, capturável por um bloco Catch.",
);
addCommand(
  ["try"],
  "Try",
  "TRY { ... } CATCH var { ... }",
  "Delimita um bloco de código protegido contra exceções.",
);
addCommand(["tstart"], "TStart", "TSTART", "Inicia uma transação.");
addCommand(["tcommit"], "TCommit", "TCOMMIT", "Confirma (commit) a transação atual.");
addCommand(["trollback"], "TRollback", "TROLLBACK", "Desfaz (rollback) a transação atual.");
addCommand(
  ["use", "u"],
  "Use",
  "USE device",
  "Torna um dispositivo o alvo padrão de leitura/escrita subsequente.",
);
addCommand(
  ["view"],
  "View",
  "VIEW expr",
  "Acessa memória diretamente por endereço (uso avançado, raro em código de aplicação).",
);
addCommand(
  ["while"],
  "While",
  "WHILE condition { ... }",
  "Loop que repete enquanto a condição permanecer verdadeira.",
);
addCommand(
  ["write", "w"],
  "Write",
  "WRITE expr",
  "Escreve um valor no dispositivo de saída atual (por padrão, o terminal).",
);
addCommand(
  ["xecute", "x"],
  "Xecute",
  "XECUTE code",
  "Executa dinamicamente uma string contendo código ObjectScript.",
);
addCommand(
  ["zkill"],
  "ZKill",
  "ZKILL var",
  "Remove uma variável/nó sem afetar seus descendentes (ao contrário de Kill).",
);
addCommand(["znspace"], "ZNspace", "ZNSPACE namespace", "Muda o namespace atual do processo.");
addCommand(
  ["ztrap"],
  "ZTrap",
  "ZTRAP [label]",
  "Define um tratador de erro no estilo legado (prefira Try/Catch em código novo).",
);
addCommand(
  ["zwrite"],
  "ZWrite",
  "ZWRITE var",
  "Escreve o valor de uma variável no formato ObjectScript, incluindo seus subscritos.",
);

const CLASS_KEYWORD_DOCS: Record<string, WordDoc> = {
  class: {
    name: "Class",
    kind: "definição de classe",
    syntax: "Class Package.Name Extends Superclass { ... }",
    doc: "Inicia a definição de uma classe.",
  },
  extends: {
    name: "Extends",
    kind: "definição de classe",
    syntax: "Extends Superclass1, Superclass2",
    doc: "Declara de quais superclasses esta classe herda.",
  },
  method: {
    name: "Method",
    kind: "definição de classe",
    syntax: "Method Name(args) As ReturnType { ... }",
    doc: "Define um método de instância.",
  },
  classmethod: {
    name: "ClassMethod",
    kind: "definição de classe",
    syntax: "ClassMethod Name(args) As ReturnType { ... }",
    doc: "Define um método de classe (chamável sem uma instância).",
  },
  property: {
    name: "Property",
    kind: "definição de classe",
    syntax: "Property Name As Type;",
    doc: "Declara uma propriedade da classe.",
  },
  parameter: {
    name: "Parameter",
    kind: "definição de classe",
    syntax: "Parameter Name = value;",
    doc: "Declara um parâmetro de classe (constante em tempo de compilação).",
  },
  index: {
    name: "Index",
    kind: "definição de classe",
    syntax: "Index Name On Property;",
    doc: "Declara um índice para uma classe persistente.",
  },
  trigger: {
    name: "Trigger",
    kind: "definição de classe",
    syntax: "Trigger Name [ Event = INSERT ] { ... }",
    doc: "Define um trigger de banco de dados.",
  },
  xdata: {
    name: "XData",
    kind: "definição de classe",
    syntax: "XData Name { ... }",
    doc: "Bloco de dados XML embutido na classe (ex: definições de web service, UI, etc.).",
  },
  storage: {
    name: "Storage",
    kind: "definição de classe",
    syntax: "Storage Default { ... }",
    doc: "Define o mapeamento de armazenamento (globals) de uma classe persistente.",
  },
  query: {
    name: "Query",
    kind: "definição de classe",
    syntax: "Query Name(args) As %Query { ... }",
    doc: "Define uma query de classe.",
  },
};

let registered = false;

export function registerObjectScriptHover(monaco: typeof Monaco): void {
  if (registered) return;
  registered = true;

  monaco.languages.registerHoverProvider(OBJECTSCRIPT_LANGUAGE_IDS, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;

      const key = word.word.toLowerCase();
      const entry = COMMAND_DOCS[key] ?? CLASS_KEYWORD_DOCS[key];
      if (!entry) return null;

      return {
        range: {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        },
        contents: [
          { value: `**${entry.name}** — ${entry.kind} ObjectScript` },
          { value: "```objectscript\n" + entry.syntax + "\n```" },
          { value: entry.doc },
        ],
      };
    },
  });
}
