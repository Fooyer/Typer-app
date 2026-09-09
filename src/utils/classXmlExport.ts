/**
 * Converts a class's UDL source (the text you edit) into InterSystems' Studio "class export" XML
 * format (the same format produced by Studio's File > Export and consumed by $system.OBJ.Load).
 * There's no documented Atelier REST endpoint that does this server-side — the Atelier API only
 * ever hands back UDL text — so this reimplements the UDL grammar for the constructs that appear
 * in normal, hand-written classes (Parameter/Property/Method/ClassMethod/Index/XData/Query/Trigger/
 * ForeignKey/Relationship/Projection/Storage). It's best-effort: exotic or hand-edited UDL (unusual
 * formatting, nested quoting, member kinds not listed above) may not round-trip perfectly back
 * through Studio/IRIS import.
 */

const MEMBER_KIND_CANON: Record<string, string> = {
  parameter: "Parameter",
  property: "Property",
  relationship: "Relationship",
  index: "Index",
  method: "Method",
  classmethod: "ClassMethod",
  query: "Query",
  trigger: "Trigger",
  foreignkey: "ForeignKey",
  xdata: "XData",
  projection: "Projection",
  storage: "Storage",
};

const MEMBER_KEYWORDS = Object.keys(MEMBER_KIND_CANON).join("|");
const MEMBER_START_RE = new RegExp(`^(${MEMBER_KEYWORDS})\\s+("([^"]*)"|[^\\s(;[]+)`, "i");

interface ParsedMember {
  kind: string;
  name: string;
  header: string;
  body: string | null;
  description: string;
}

interface ParsedClass {
  className: string;
  description: string;
  superClasses: string[];
  classKeywords: [string, string][];
  members: ParsedMember[];
}

function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}

function cdata(value: string): string {
  return `<![CDATA[${value.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

function sanitizeTagName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "") || "Keyword";
}

/** Finds `target` at bracket/brace/paren depth 0, skipping over double-quoted strings ("" escapes a literal quote). */
function findTopLevelChar(text: string, target: string): number {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === target && depth === 0) return i;
  }
  return -1;
}

function splitTopLevelByComma(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let current = "";
  let inString = false;
  for (const ch of text) {
    if (inString) {
      current += ch;
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      result.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") result.push(current);
  return result.map((s) => s.trim()).filter((s) => s.length > 0);
}

function splitKeywords(text: string): [string, string][] {
  return splitTopLevelByComma(text).map((entry): [string, string] => {
    const eq = findTopLevelChar(entry, "=");
    if (eq === -1) return [sanitizeTagName(entry.trim()), "1"];
    const key = sanitizeTagName(entry.slice(0, eq).trim());
    let value = entry.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/""/g, '"');
    }
    return [key, value];
  });
}

/** Extracts a leading `(...)` from the start of `text`, honoring nested parens/brackets/strings. */
function extractLeadingParen(text: string): { content: string; after: string } | null {
  if (!text.startsWith("(")) return null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { content: text.slice(1, i), after: text.slice(i + 1) };
    }
  }
  return { content: text.slice(1), after: "" };
}

/** Extracts a trailing `[...]` from the end of (trimmed) `text`, honoring nested brackets. */
function extractTrailingBracket(text: string): { before: string; content: string } | null {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed.endsWith("]")) return null;
  let depth = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (ch === "]") depth++;
    else if (ch === "[") {
      depth--;
      if (depth === 0)
        return { before: trimmed.slice(0, i), content: trimmed.slice(i + 1, trimmed.length - 1) };
    }
  }
  return null;
}

/** Finds the index just after the `}` matching the `{` at `openIndex`, honoring quoted strings and
 * (when `honorComments`) ObjectScript `//` / `\/* *\/` comments so braces inside code aren't miscounted. */
function findMatchingBrace(text: string, openIndex: number, honorComments: boolean): number {
  let depth = 1;
  let i = openIndex + 1;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (honorComments && ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    if (honorComments && ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (ch === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}") {
      depth--;
      i++;
      if (depth === 0) return i - 1;
      continue;
    }
    i++;
  }
  return n;
}

function parseMembers(body: string): ParsedMember[] {
  const members: ParsedMember[] = [];
  const n = body.length;
  let i = 0;
  let pendingDescLines: string[] = [];

  while (i < n) {
    let lineEnd = body.indexOf("\n", i);
    if (lineEnd === -1) lineEnd = n;
    const rawLine = body.slice(i, lineEnd);
    const trimmed = rawLine.trim();

    if (trimmed === "") {
      i = lineEnd + 1;
      continue;
    }

    if (rawLine.startsWith("///")) {
      pendingDescLines.push(rawLine.replace(/^\/\/\/\s?/, ""));
      i = lineEnd + 1;
      continue;
    }

    const match = !/^\s/.test(rawLine) ? rawLine.match(MEMBER_START_RE) : null;
    if (!match) {
      pendingDescLines = [];
      i = lineEnd + 1;
      continue;
    }

    const kind = MEMBER_KIND_CANON[match[1].toLowerCase()];
    const name = match[3] ?? match[2];
    const memberStart = i + match[0].length;
    const honorComments = kind === "Method" || kind === "ClassMethod" || kind === "Trigger";

    let depth = 0;
    let j = memberStart;
    let inString = false;
    let headerEnd = -1;
    let bodyOpen = -1;
    while (j < n) {
      const ch = body[j];
      if (inString) {
        if (ch === '"') {
          if (body[j + 1] === '"') {
            j += 2;
            continue;
          }
          inString = false;
        }
        j++;
        continue;
      }
      if (ch === '"') {
        inString = true;
        j++;
        continue;
      }
      if (ch === "(" || ch === "[") {
        depth++;
        j++;
        continue;
      }
      if (ch === ")" || ch === "]") {
        depth--;
        j++;
        continue;
      }
      if (depth === 0 && ch === "{") {
        bodyOpen = j;
        break;
      }
      if (depth === 0 && ch === ";") {
        headerEnd = j;
        break;
      }
      j++;
    }

    let header: string;
    let bodyText: string | null = null;
    let afterIndex: number;

    if (bodyOpen !== -1) {
      header = body.slice(memberStart, bodyOpen);
      const closeIndex = findMatchingBrace(body, bodyOpen, honorComments);
      bodyText = body
        .slice(bodyOpen + 1, closeIndex)
        .replace(/^\n/, "")
        .replace(/\n[ \t]*$/, "");
      afterIndex = closeIndex + 1;
    } else if (headerEnd !== -1) {
      header = body.slice(memberStart, headerEnd);
      afterIndex = headerEnd + 1;
    } else {
      header = body.slice(memberStart);
      afterIndex = n;
    }

    members.push({
      kind,
      name,
      header: header.trim(),
      body: bodyText,
      description: pendingDescLines.join("\n"),
    });
    pendingDescLines = [];
    i = afterIndex;
  }

  return members;
}

function parseClass(sourceLines: string[]): ParsedClass {
  const lines = sourceLines;
  const declIndex = lines.findIndex((l) => /^Class\s+\S/i.test(l));
  if (declIndex === -1) {
    throw new Error('Não foi encontrada uma declaração "Class ..." no início do arquivo.');
  }

  const descLines: string[] = [];
  for (let i = declIndex - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("///")) descLines.unshift(line.replace(/^\/\/\/\s?/, ""));
    else break;
  }

  const headerParts: string[] = [];
  let bodyStart = declIndex;
  for (let i = declIndex; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "{") {
      bodyStart = i + 1;
      break;
    }
    if (trimmed.endsWith("{")) {
      headerParts.push(trimmed.slice(0, -1).trim());
      bodyStart = i + 1;
      break;
    }
    headerParts.push(trimmed);
    bodyStart = i + 1;
  }
  const headerText = headerParts.join(" ").replace(/\s+/g, " ").trim();

  let classCloseIndex = lines.length;
  for (let i = lines.length - 1; i >= bodyStart; i--) {
    if (lines[i].trim() === "}") {
      classCloseIndex = i;
      break;
    }
  }
  const bodyText = lines.slice(bodyStart, classCloseIndex).join("\n");

  const headerMatch = headerText.match(/^Class\s+(\S+)\s*([\s\S]*)$/i);
  if (!headerMatch) throw new Error("Não foi possível interpretar a declaração da classe.");
  const className = headerMatch[1];
  let rest = headerMatch[2].trim();

  const kwBlock = extractTrailingBracket(rest);
  const classKeywords = kwBlock ? splitKeywords(kwBlock.content) : [];
  rest = (kwBlock ? kwBlock.before : rest).trim();

  let superClasses: string[] = [];
  const extendsMatch = rest.match(/^Extends\s+([\s\S]*)$/i);
  if (extendsMatch) {
    let sup = extendsMatch[1].trim();
    if (sup.startsWith("(") && sup.endsWith(")")) sup = sup.slice(1, -1);
    superClasses = splitTopLevelByComma(sup);
  }

  return {
    className,
    description: descLines.join("\n"),
    superClasses,
    classKeywords,
    members: parseMembers(bodyText),
  };
}

function emitMember(member: ParsedMember): string {
  const parts: string[] = [`<${member.kind} name="${escapeXmlAttr(member.name)}">`];
  if (member.description)
    parts.push(`<Description>\n${escapeXmlText(member.description)}</Description>`);

  let header = member.header;
  const kwBlock = extractTrailingBracket(header);
  const keywordsText = kwBlock ? kwBlock.content : "";
  header = (kwBlock ? kwBlock.before : header).trim();

  switch (member.kind) {
    case "Parameter": {
      let rest = header;
      const asMatch = rest.match(/^As\s+([\w.%]+)/i);
      let type = "";
      if (asMatch) {
        type = asMatch[1];
        rest = rest.slice(asMatch[0].length).trim();
      }
      if (type) parts.push(`<Type>${escapeXmlText(type)}</Type>`);
      if (rest.startsWith("="))
        parts.push(`<Default>${escapeXmlText(rest.slice(1).trim())}</Default>`);
      break;
    }
    case "Property":
    case "Relationship":
    case "Projection": {
      const asMatch = header.match(/^As\s+([\s\S]*)$/i);
      const type = asMatch ? asMatch[1].trim() : "";
      if (type) parts.push(`<Type>${escapeXmlText(type)}</Type>`);
      break;
    }
    case "Index": {
      const onMatch = header.match(/^On\s+([\s\S]*)$/i);
      let props = (onMatch ? onMatch[1] : header).trim();
      if (props.startsWith("(") && props.endsWith(")")) props = props.slice(1, -1);
      props = props
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)
        .join(",");
      if (props) parts.push(`<Properties>${escapeXmlText(props)}</Properties>`);
      break;
    }
    case "ForeignKey": {
      let rest = header;
      let props = "";
      if (rest.startsWith("(")) {
        const p = extractLeadingParen(rest);
        if (p) {
          props = p.content;
          rest = p.after.trim();
        }
      }
      const refMatch = rest.match(/^References\s+([\w.%]+)\s*(?:\(([^)]*)\))?/i);
      if (props) parts.push(`<Properties>${escapeXmlText(props)}</Properties>`);
      if (refMatch) {
        parts.push(`<ReferencedClass>${escapeXmlText(refMatch[1])}</ReferencedClass>`);
        if (refMatch[2])
          parts.push(`<ReferencedKey>${escapeXmlText(refMatch[2].trim())}</ReferencedKey>`);
      }
      break;
    }
    case "Method":
    case "ClassMethod":
    case "Query": {
      let rest = header;
      let formalSpec = "";
      if (rest.startsWith("(")) {
        const p = extractLeadingParen(rest);
        if (p) {
          formalSpec = p.content;
          rest = p.after.trim();
        }
      }
      const asMatch = rest.match(/^As\s+([\s\S]*)$/i);
      const returnType = asMatch ? asMatch[1].trim() : "";
      if (formalSpec) parts.push(`<FormalSpec>${escapeXmlText(formalSpec)}</FormalSpec>`);
      const returnTag = member.kind === "Query" ? "Type" : "ReturnType";
      if (returnType) parts.push(`<${returnTag}>${escapeXmlText(returnType)}</${returnTag}>`);
      if (member.body !== null) {
        const tag =
          member.kind === "Query" && /sqlquery/i.test(returnType) ? "SqlQuery" : "Implementation";
        parts.push(`<${tag}>${cdata(`\n${member.body}\n`)}</${tag}>`);
      }
      break;
    }
    case "Trigger": {
      if (member.body !== null)
        parts.push(`<Implementation>${cdata(`\n${member.body}\n`)}</Implementation>`);
      break;
    }
    case "XData": {
      if (member.body !== null) parts.push(`<Data>${cdata(`\n${member.body}\n`)}</Data>`);
      break;
    }
    case "Storage": {
      if (member.body !== null) parts.push(member.body.trim());
      break;
    }
  }

  if (member.kind !== "Storage") {
    for (const [key, value] of splitKeywords(keywordsText)) {
      parts.push(`<${key}>${escapeXmlText(value)}</${key}>`);
    }
  }

  parts.push(`</${member.kind}>`);
  return parts.join("\n");
}

/** Finds a single named member (e.g. `XData UrlMap`) without doing the full XML export — used by
 * the API tester to pull out a class's route map without re-deriving the whole UDL grammar. */
export function findClassMember(
  sourceLines: string[],
  kind: string,
  name: string,
): { className: string; header: string; body: string | null } | null {
  const parsed = parseClass(sourceLines);
  const match = parsed.members.find(
    (m) =>
      m.kind.toLowerCase() === kind.toLowerCase() && m.name.toLowerCase() === name.toLowerCase(),
  );
  if (!match) return null;
  return { className: parsed.className, header: match.header, body: match.body };
}

/** Merges several single-class export XML documents (as produced by `classSourceToExportXml`) into
 * one `<Export>` document with multiple `<Class>` children, matching how Studio exports a
 * multi-selection to a single file. */
export function combineExportXml(classXmls: string[]): string {
  const bodies = classXmls
    .map((xml) => xml.match(/<Export[^>]*>([\s\S]*)<\/Export>/)?.[1]?.trim())
    .filter((body): body is string => Boolean(body));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Export generator="Cache" version="25">',
    ...bodies,
    "</Export>",
  ].join("\n");
}

export function classSourceToExportXml(sourceLines: string[]): { xml: string; className: string } {
  const parsed = parseClass(sourceLines);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<Export generator="Cache" version="25">`,
  ];
  lines.push(`<Class name="${escapeXmlAttr(parsed.className)}">`);
  if (parsed.description)
    lines.push(`<Description>\n${escapeXmlText(parsed.description)}</Description>`);
  if (parsed.superClasses.length)
    lines.push(`<Super>${escapeXmlText(parsed.superClasses.join(","))}</Super>`);
  for (const [key, value] of parsed.classKeywords)
    lines.push(`<${key}>${escapeXmlText(value)}</${key}>`);
  lines.push("");
  for (const member of parsed.members) {
    lines.push(emitMember(member));
    lines.push("");
  }
  lines.push(`</Class>`, `</Export>`);
  return { xml: lines.join("\n"), className: parsed.className };
}
