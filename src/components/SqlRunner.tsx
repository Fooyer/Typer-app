import { useEffect, useState } from "react";
import type { ConnectionProfile, AtelierQueryResult } from "../platform/types";
import type { LogLevel } from "./OutputPanel";

interface SqlRunnerProps {
  onLog: (message: string, level?: LogLevel) => void;
}

const DEFAULT_SQL = "SELECT TOP 10 * FROM %Dictionary.ClassDefinition";

function SqlRunner({ onLog }: SqlRunnerProps) {
  const [connections, setConnections] = useState<ConnectionProfile[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespace, setNamespace] = useState("");
  const [sql, setSql] = useState(DEFAULT_SQL);
  const [result, setResult] = useState<AtelierQueryResult | null>(null);
  const [running, setRunning] = useState(false);

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
    } catch (error) {
      onLog(`Erro ao listar namespaces: ${(error as Error).message}`, "error");
    }
  }

  async function runQuery() {
    if (!connectionId || !namespace || !sql.trim()) return;
    setRunning(true);
    onLog(`Executando SQL em ${namespace}…`);
    try {
      const queryResult = await window.electronAPI.atelier.query(connectionId, namespace, sql, []);
      setResult(queryResult);
      onLog(`${queryResult.rows.length} linha(s) retornada(s).`, "success");
    } catch (error) {
      setResult(null);
      onLog(`Erro na consulta SQL: ${(error as Error).message}`, "error");
    } finally {
      setRunning(false);
    }
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
        <select value={connectionId} onChange={(event) => selectConnection(event.target.value)}>
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
        >
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
        <button type="button" onClick={runQuery} disabled={running || !connectionId || !namespace}>
          {running ? "Executando…" : "Executar (Ctrl+Enter)"}
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
      />
      <div className="sql-results">
        {!result && <p className="connection-status">Nenhum resultado ainda.</p>}
        {result && result.rows.length === 0 && (
          <p className="connection-status">Consulta executada, sem linhas retornadas.</p>
        )}
        {result && result.rows.length > 0 && (
          <table>
            <thead>
              <tr>
                {result.columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={index}>
                  {result.columns.map((column) => (
                    <td key={column}>{String(row[column] ?? "")}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default SqlRunner;
