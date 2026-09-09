import { findClassMember } from "./classXmlExport";

export interface ApiRoute {
  method: string;
  url: string;
  call: string;
}

function unescapeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrText))) {
    attrs[match[1]] = unescapeXmlEntities(match[2]);
  }
  return attrs;
}

/** Pulls `<Route Url="..." Method="..." Call="..."/>` entries out of a class's `XData UrlMap`
 * block (the standard %CSP.REST dispatch mechanism) — returns an empty list if the class has no
 * UrlMap at all (not every class is a REST dispatch class). */
export function extractUrlMapRoutes(sourceLines: string[]): ApiRoute[] {
  const member = findClassMember(sourceLines, "XData", "UrlMap");
  if (!member || member.body === null) return [];
  const routes: ApiRoute[] = [];
  const routeRe = /<Route\b([^>]*?)\/?>/gi;
  let match: RegExpExecArray | null;
  while ((match = routeRe.exec(member.body))) {
    const attrs = parseAttributes(match[1]);
    if (!attrs.Url || !attrs.Method) continue;
    routes.push({ method: attrs.Method.toUpperCase(), url: attrs.Url, call: attrs.Call ?? "" });
  }
  return routes;
}

/** Joins an application base path (e.g. "/csp/user/myapp/") with a route path (e.g. "/items/:id"). */
export function joinApiPath(basePath: string, routePath: string): string {
  const base = basePath.replace(/\/+$/, "");
  const path = routePath.startsWith("/") ? routePath : `/${routePath}`;
  return `${base}${path}`;
}
