import type * as Monaco from "monaco-editor";
import { getClassMembers } from "./classMembers";
import {
  METHOD_SIGNATURE,
  escapeRegExp,
  extractParamNames,
  findBodyEnd,
  findBodyStart,
  findMatchingParen,
  splitTopLevelCommas,
} from "./parameterHighlight";

const CLASS_DECLARATION = /^\s*Class\s+([%\p{L}_][\p{L}\p{N}_.]*)/u;

/** CSP's implicit context objects — always available inside %CSP.Page/%CSP.REST code without ever
 * being declared, so they need a hardcoded type mapping instead of a parsed declaration. */
const PREDEFINED_OBJECT_TYPES: Record<string, string> = {
  "%request": "%CSP.Request",
  "%response": "%CSP.Response",
  "%session": "%CSP.Session",
};

/** These always return an instance of the class they were called on (or a subclass), so
 * `Set x = ##class(Y).%New(...)`-style assignments can be resolved without asking the server. */
const INSTANCE_RETURNING_METHODS = new Set(["%new", "%open", "%openid", "%constructclone"]);

/** Value/data types aren't dot-navigable object instances in ObjectScript, so a method whose
 * ReturnType is one of these shouldn't be treated as "x is now an instance of this class". */
const PRIMITIVE_RETURN_TYPES = new Set([
  "%string",
  "%integer",
  "%boolean",
  "%status",
  "%numeric",
  "%double",
  "%float",
  "%bigint",
  "%smallint",
  "%tinyint",
  "%decimal",
  "%currency",
  "%date",
  "%time",
  "%timestamp",
  "%posixtime",
  "%binary",
  "%char",
  "%varstring",
  "%list",
]);

/** The current document's own class name, from its `Class Package.Name Extends ...` line — used
 * to resolve `..Property`/`..Method` self-references to that class's own members. */
export function parseCurrentClassName(model: Monaco.editor.ITextModel): string | null {
  const lineCount = model.getLineCount();
  for (let line = 1; line <= lineCount; line++) {
    const match = CLASS_DECLARATION.exec(model.getLineContent(line));
    if (match) return match[1];
  }
  return null;
}

/**
 * Best-effort lookup of a variable's declared ObjectScript class, so `variable.` completion can
 * offer that class's members. ObjectScript has no static typing at the language level, so beyond a
 * written-down declaration (a formal parameter or a Property) the only other thing this can safely
 * infer is a `Set x = ##class(Y).SomeMethod(...)` assignment — safe because either SomeMethod is one
 * of the well-known instance constructors (%New/%Open/%OpenId/%ConstructClone), which always return
 * Y, or its compiled ReturnType (asked of the server, same as member completion) says so directly.
 * Anything else — `Set x = someExpression`, arithmetic, string building — genuinely can't be typed
 * without a real type checker.
 */
export async function resolveVariableType(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
  varName: string,
): Promise<string | null> {
  const predefined = PREDEFINED_OBJECT_TYPES[varName.toLowerCase()];
  if (predefined) return predefined;

  const typePattern = new RegExp(
    `\\b${escapeRegExp(varName)}\\s+As\\s+([%\\p{L}_][\\p{L}\\p{N}_.]*)`,
    "iu",
  );
  let methodBodyStart: { line: number; col: number } | null = null;

  // Nearest enclosing method's formal parameters, searching upward from the cursor.
  for (let line = position.lineNumber; line >= 1; line--) {
    const text = model.getLineContent(line);
    if (!METHOD_SIGNATURE.test(text)) continue;
    const openParen = text.indexOf("(");
    const closeParen = openParen >= 0 ? findMatchingParen(text, openParen) : -1;
    if (closeParen < 0) break;
    for (const chunk of splitTopLevelCommas(text.slice(openParen + 1, closeParen))) {
      const match = typePattern.exec(chunk);
      if (match) return match[1];
    }
    methodBodyStart = findBodyStart(model.getLinesContent(), line - 1, closeParen + 1);
    break; // stop at the nearest method boundary either way — don't leak into an outer/earlier one
  }

  // Set x = ##class(Y).Method(...) / Set x = { ... } / Set x = [ ... ] within that same method, up
  // to the cursor — last one wins, so reassigning x partway through resolves to the newer type.
  // `{...}`/`[...]` are ObjectScript's literal syntax for %DynamicObject/%DynamicArray, so those two
  // are inferable outright without asking the server.
  if (methodBodyStart) {
    const lines = model.getLinesContent();
    const classAssignPattern = new RegExp(
      `\\bSet\\s+${escapeRegExp(varName)}\\s*=\\s*##class\\(\\s*([%\\w][\\w.]*)\\s*\\)\\s*\\.\\s*([%\\w]+)\\s*\\(`,
      "i",
    );
    const dynamicObjectPattern = new RegExp(`\\bSet\\s+${escapeRegExp(varName)}\\s*=\\s*\\{`, "i");
    const dynamicArrayPattern = new RegExp(`\\bSet\\s+${escapeRegExp(varName)}\\s*=\\s*\\[`, "i");

    let found: { className: string; methodName?: string } | null = null;
    for (
      let line = methodBodyStart.line;
      line <= position.lineNumber - 1 && line < lines.length;
      line++
    ) {
      const text = lines[line];
      const classMatch = classAssignPattern.exec(text);
      if (classMatch) {
        found = { className: classMatch[1], methodName: classMatch[2] };
      } else if (dynamicObjectPattern.test(text)) {
        found = { className: "%Library.DynamicObject" };
      } else if (dynamicArrayPattern.test(text)) {
        found = { className: "%Library.DynamicArray" };
      }
    }
    if (found?.methodName) {
      if (INSTANCE_RETURNING_METHODS.has(found.methodName.toLowerCase())) return found.className;
      const members = await getClassMembers(found.className);
      const method = members.find(
        (m) => m.kind === "method" && m.name.toLowerCase() === found!.methodName!.toLowerCase(),
      );
      if (method?.returnType && !PRIMITIVE_RETURN_TYPES.has(method.returnType.toLowerCase()))
        return method.returnType;
    } else if (found) {
      return found.className;
    }
  }

  // Fall back to a class-level Property declaration with the same name, anywhere in the document.
  const propertyPattern = new RegExp(
    `^\\s*Property\\s+${escapeRegExp(varName)}\\s+As\\s+([%\\p{L}_][\\p{L}\\p{N}_.]*)`,
    "imu",
  );
  const match = propertyPattern.exec(model.getValue());
  return match ? match[1] : null;
}

const DECLARATION_PATTERN = /\b(?:Set|New|For|Catch)\s+([%\p{L}_][\p{L}\p{N}_]*)/giu;

/**
 * Local variable names in scope at `position`: the enclosing method's own formal parameters, plus
 * anything assigned via `Set`/`New`/`For`/`Catch` within its body — for plain identifier completion
 * (typing a partial name suggests other variables already used in the same method), not member
 * completion. Heuristic like the rest of this scanner: only catches the first target of a
 * comma-chained `Set a=1,b=2`, and can't see across a literal `{`/`}` inside a string.
 */
export function collectLocalIdentifiers(
  model: Monaco.editor.ITextModel,
  position: Monaco.Position,
): string[] {
  const lines = model.getLinesContent();
  const names = new Set<string>();

  for (let i = position.lineNumber - 1; i >= 0; i--) {
    if (!METHOD_SIGNATURE.test(lines[i])) continue;

    const openParen = lines[i].indexOf("(");
    const closeParen = openParen >= 0 ? findMatchingParen(lines[i], openParen) : -1;
    if (closeParen < 0) break;
    for (const name of extractParamNames(lines[i].slice(openParen + 1, closeParen)))
      names.add(name);

    const bodyStart = findBodyStart(lines, i, closeParen + 1);
    if (!bodyStart) break;
    const bodyEnd = findBodyEnd(lines, bodyStart.line, bodyStart.col) ?? {
      line: lines.length - 1,
      col: Infinity,
    };

    for (let line = bodyStart.line; line <= bodyEnd.line && line < lines.length; line++) {
      DECLARATION_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = DECLARATION_PATTERN.exec(lines[line]))) names.add(match[1]);
    }
    break;
  }

  return [...names];
}
