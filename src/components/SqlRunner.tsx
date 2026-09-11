import { useEffect, useMemo, useState } from "react";
import type { ConnectionProfile, AtelierQueryResult } from "../platform/types";
import type { LogLevel } from "./OutputPanel";

interface SqlRunnerProps {
  onLog: (message: string, level?: LogLevel) => void;
}

const DEFAULT_SQL = "SELECT TOP 10 * FROM %Dictionary.ClassDefinition";

type SortDirection = "asc" | "desc";

/** SQL tab: pick a connection+namespace, type a query (Ctrl+Enter runs it) and browse the result
 *  grid. Columns are click-to-sort as a small usability net for result sets with many rows, and the
 *  status bar reports row/column counts and how long the query took. */
function SqlRunner({ onLog }: SqlRunnerProps) {
  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("");
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [result, setResult] = useState<AtelierQueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [sortColumn, setSortColumn] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  const hasElectronAPI = typeof window.electronAPI !== "undefined";

  useEffect(() => {
    if (!hasElectronAPI) return;
    window.electronAPI.connections.list().then(setConnections);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectConnection(id: string) {
    setConnectionId(id);
    setNamespaces([]);
    setNamespace("");
    if (!id) return;
    try {
      const available = await window.electronAPI.atelier.listNamespaces(id);
      setNamespaces(available);
      const profile = connections.find((connection) => connection.id === id);
      setNamespace(
        profile && available.includes(profile.namespace) ? profile.namespace : (available[0] ?? ""),
      );
    } catch (listError) {
      onLog(`Erro ao listar namespaces: ${(listError as Error).message}`, "error");
    }
  }

  function toggleSort(column: string) {
    if (sortColumn === column) {
      setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
    } else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  const sortedRows = useMemo(() => {
    if (!result || !sortColumn) return result?.rows ?? [];
    const column = sortColumn;
    const direction = sortDirection;
    const rows = [...result.rows];
    rows.sort((a, b) => {
      const av = a[column];
      const bv = b[column];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const comparison =
        typeof av === "number" && typeof bv === "number"
          ? av - bv
          : String(av).localeCompare(String(bv), undefined, {
              numeric: true,
              sensitivity: "base",
            });
      return direction === "asc" ? comparison : -comparison;
    });
    return rows;
  }, [result, sortColumn, sortDirection]);

  /** IRIS/Caché's internal identity column is called "ID" — pin it to the first position so the
   *  primary key is always the leftmost column, whatever order the server returns. */
  const displayColumns = useMemo(() => {
    const columns = result?.columns ?? [];
    if (!columns.includes("ID")) return columns;
    return ["ID", ...columns.filter((column) => column !== "ID")];
  }, [result]);

  async function runQuery() {
    if (!connectionId || !namespace || !sql.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setElapsedMs(null);
    const started = performance.now();
    onLog(`Executando SQL em ${namespace}…`);
    try {
      const queryResult = await window.electronAPI.atelier.query(connectionId, namespace, sql, []);
      const ms = Math.round(performance.now() - started);
      setElapsedMs(ms);
      setResult(queryResult);
      onLog(`${queryResult.rows.length} linha(s) retornada(s) em ${ms} ms.`, "success");
    } catch (queryError) {
      const ms = Math.round(performance.now() - started);
      setElapsedMs(ms);
      setError((queryError as Error).message);
      onLog(`Erro na consulta SQL: ${(queryError as Error).message}`, "error");
    } finally {
      setRunning(false);
    }
  }

  function clearResult() {
    setResult(null);
    setError(null);
    setElapsedMs(null);
    setSortColumn(null);
  }

  if (!hasElectronAPI) {
    return (
      <div className="sql-runner">
        <p className="connection-status">Disponível apenas rodando no app desktop.</p>
      </div>
    );
  }

  return (
    <div className="sql-runner">
      <div className="sql-runner-toolbar">
        <select
          value={connectionId}
          onChange={(event) => selectConnection(event.target.value)}
          title="Conexão"
        >
          <option value="">Conexão…</option>
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name || `${connection.host}:${connection.port}`}
            </option>
          ))}
        </select>
        <select
          value={namespace}
          onChange={(event) => setNamespace(event.target.value)}
          disabled={!namespaces.length}
          title="Namespace"
        >
          <option value="">Namespace…</option>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="sql-run-button"
          onClick={runQuery}
          disabled={running || !connectionId || !namespace}
        >
          {running && <span className="sql-run-spinner" aria-hidden="true" />}
          {running ? "Executando…" : "▶ Executar (Ctrl+Enter)"}
        </button>
      </div>
      <textarea
        className="sql-editor"
        value={sql}
        onChange={(event) => setSql(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") runQuery();
        }}
        spellCheck={false}
        aria-label="Consulta SQL"
      />
      <div className="sql-editor-hint">
        <kbd>Ctrl</kbd> + <kbd>Enter</kbd> executa a consulta
      </div>
      <div className="sql-results">
        {result ? (
          <>
            <div className="sql-results-bar">
              <span className="sql-results-count">
                {result.rows.length} linha(s) · {result.columns.length} coluna(s)
                {elapsedMs !== null ? ` · ${elapsedMs} ms` : ""}
              </span>
              <button type="button" onClick={clearResult}>
                Limpar
              </button>
            </div>
            <div className="sql-results-body">
              {sortedRows.length === 0 ? (
                <p className="sql-results-status">Consulta executada: nenhuma linha retornada.</p>
              ) : (
                <table>
                  <thead>
                    <tr>
                      {displayColumns.map((column) => (
                        <th key={column} onClick={() => toggleSort(column)} title={`Ordenar por ${column}`}>
                          {column}
                          {sortColumn === column && (
                            <span className="sql-sort-indicator" aria-hidden="true">
                              {sortDirection === "asc" ? "▲" : "▼"}
                            </span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row, index) => (
                      <tr key={index}>
                        {displayColumns.map((column) => {
                          const value = String(row[column] ?? "");
                          return (
                            <td key={column} title={value}>
                              {value}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : (
          <p className={`sql-results-status${error ? " error" : ""}`}>
            {error ? `Erro: ${error}` : "Nenhum resultado ainda. Digite uma consulta e pressione Ctrl+Enter."}
          </p>
        )}
      </div>
    </div>
  );
}

export default SqlRunner;