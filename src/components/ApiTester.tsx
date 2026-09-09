import { useEffect, useMemo, useState } from "react";
import type { RestCallResult } from "../platform/types";
import { extractUrlMapRoutes, joinApiPath, type ApiRoute } from "../utils/apiRoutes";
import type { LogLevel } from "./OutputPanel";

interface ApiTesterProps {
  connectionId: string;
  namespace: string;
  docName: string;
  sourceContent: string;
  onLog: (message: string, level?: LogLevel) => void;
}

function parseHeadersText(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;
    headers[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
  }
  return headers;
}

function tryPrettyJson(body: string): string | null {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return null;
  }
}

function ApiTester({ connectionId, namespace, docName, sourceContent, onLog }: ApiTesterProps) {
  const className = docName.replace(/\.cls$/i, "");
  const routes = useMemo(() => extractUrlMapRoutes(sourceContent.split("\n")), [sourceContent]);

  const [basePath, setBasePath] = useState("");
  const [basePathOptions, setBasePathOptions] = useState<string[]>([]);
  const [basePathStatus, setBasePathStatus] = useState("Resolvendo caminho da aplicação…");
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [method, setMethod] = useState("GET");
  const [urlPath, setUrlPath] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [sending, setSending] = useState(false);
  const [response, setResponse] = useState<RestCallResult | null>(null);
  const [responseError, setResponseError] = useState<string | null>(null);
  const [prettyJson, setPrettyJson] = useState(true);

  const hasElectronAPI = typeof window.electronAPI !== "undefined";

  useEffect(() => {
    if (!hasElectronAPI) return;
    let cancelled = false;
    setBasePathStatus("Resolvendo caminho da aplicação…");
    window.electronAPI.atelier
      .query(
        connectionId,
        "%SYS",
        "SELECT Name, NameSpace FROM Security.Applications WHERE DispatchClass = ?",
        [className],
      )
      .then((result) => {
        if (cancelled) return;
        // An app registered for this exact namespace is almost certainly the right one; other
        // namespaces sharing the same class name go after it as fallback options.
        const rows = [...result.rows].sort((a, b) => {
          const aMatch = String(a.NameSpace) === namespace ? 0 : 1;
          const bMatch = String(b.NameSpace) === namespace ? 0 : 1;
          return aMatch - bMatch;
        });
        const names = rows.map((row) => String(row.Name)).filter(Boolean);
        setBasePathOptions(names);
        if (names.length) {
          setBasePath(names[0]);
          setBasePathStatus(
            names.length > 1
              ? `${names.length} aplicações usam esta classe — confira o caminho selecionado.`
              : "",
          );
        } else {
          setBasePathStatus(
            "Não encontrado automaticamente — informe o caminho da aplicação manualmente.",
          );
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setBasePathStatus(
          "Não encontrado automaticamente — informe o caminho da aplicação manualmente.",
        );
        onLog(
          `Não foi possível resolver o caminho da aplicação: ${(error as Error).message}`,
          "error",
        );
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, namespace, className]);

  function selectRoute(route: ApiRoute, index: number) {
    setSelectedIndex(index);
    setMethod(route.method === "*" ? "GET" : route.method);
    setUrlPath(route.url);
    setResponse(null);
    setResponseError(null);
  }

  async function sendRequest() {
    if (!hasElectronAPI || !urlPath.trim()) return;
    const fullPath = joinApiPath(basePath, urlPath);
    setSending(true);
    setResponse(null);
    setResponseError(null);
    onLog(`Chamando ${method} ${fullPath}…`);
    try {
      const result = await window.electronAPI.atelier.callRoute(
        connectionId,
        fullPath,
        method,
        parseHeadersText(headersText),
        bodyText,
      );
      setResponse(result);
      const ok = result.status >= 200 && result.status < 300;
      onLog(
        `${method} ${fullPath} → ${result.status} ${result.statusText} (${result.durationMs} ms)`,
        ok ? "success" : "error",
      );
    } catch (error) {
      setResponseError((error as Error).message);
      onLog(`Erro ao chamar API: ${(error as Error).message}`, "error");
    } finally {
      setSending(false);
    }
  }

  if (!hasElectronAPI) {
    return (
      <div className="api-tester">
        <p className="connection-status">Disponível apenas rodando no app desktop.</p>
      </div>
    );
  }

  const fullUrlPreview = joinApiPath(basePath, urlPath || "/");
  // Computed regardless of the toggle so the checkbox itself doesn't disappear once unchecked.
  const jsonBody = response ? tryPrettyJson(response.body) : null;
  const displayBody = response ? (jsonBody && prettyJson ? jsonBody : response.body) : "";

  return (
    <div className="api-tester">
      <div className="api-tester-routes">
        <div className="api-tester-routes-header">{className}</div>
        <label className="api-tester-base-path">
          Caminho da aplicação
          {basePathOptions.length > 1 ? (
            <select value={basePath} onChange={(event) => setBasePath(event.target.value)}>
              {basePathOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={basePath}
              onChange={(event) => setBasePath(event.target.value)}
              placeholder="/csp/user/minhaapp/"
            />
          )}
        </label>
        {basePathStatus && <p className="connection-status">{basePathStatus}</p>}
        {routes.length === 0 ? (
          <p className="connection-status">Esta classe não tem uma XData UrlMap com rotas.</p>
        ) : (
          <ul className="api-route-list">
            {routes.map((route, index) => (
              <li
                key={`${route.method}:${route.url}:${index}`}
                className={index === selectedIndex ? "active" : ""}
                onClick={() => selectRoute(route, index)}
                title={route.call ? `Call: ${route.call}` : undefined}
              >
                <span className={`api-route-method api-route-method-${route.method.toLowerCase()}`}>
                  {route.method}
                </span>
                <span className="api-route-url">{route.url}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="api-tester-request">
        <div className="api-tester-toolbar">
          <select value={method} onChange={(event) => setMethod(event.target.value)}>
            {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input
            className="api-tester-url"
            value={urlPath}
            onChange={(event) => setUrlPath(event.target.value)}
            placeholder="/rota/:parametro"
          />
          <button type="button" onClick={sendRequest} disabled={sending || !urlPath.trim()}>
            {sending ? "Enviando…" : "Enviar"}
          </button>
        </div>
        <p className="api-tester-full-url">{fullUrlPreview}</p>
        <div className="api-tester-fields">
          <label>
            Headers (um por linha, Nome: Valor)
            <textarea
              className="api-tester-headers"
              value={headersText}
              onChange={(event) => setHeadersText(event.target.value)}
              placeholder={"Content-Type: application/json"}
              spellCheck={false}
            />
          </label>
          <label>
            Corpo da requisição
            <textarea
              className="api-tester-body"
              value={bodyText}
              onChange={(event) => setBodyText(event.target.value)}
              placeholder={
                method === "GET" || method === "HEAD" ? "(ignorado para " + method + ")" : "{}"
              }
              spellCheck={false}
            />
          </label>
        </div>
        <div className="api-tester-response">
          {responseError && <p className="output-line-error">{responseError}</p>}
          {response && (
            <>
              <div className="api-response-status">
                <span
                  className={
                    response.status >= 200 && response.status < 300
                      ? "output-line-success"
                      : "output-line-error"
                  }
                >
                  {response.status} {response.statusText}
                </span>
                <span className="api-response-duration">{response.durationMs} ms</span>
                {jsonBody && (
                  <label className="search-case-toggle">
                    <input
                      type="checkbox"
                      checked={prettyJson}
                      onChange={(event) => setPrettyJson(event.target.checked)}
                    />
                    JSON formatado
                  </label>
                )}
              </div>
              <pre className="api-response-body">{displayBody}</pre>
            </>
          )}
          {!response && !responseError && (
            <p className="connection-status">Nenhuma resposta ainda.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default ApiTester;
