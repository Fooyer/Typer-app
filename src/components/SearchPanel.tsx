import { useEffect, useMemo, useRef, useState } from "react";

export interface SearchMatch {
  docName: string;
  line: number;
  text: string;
}

interface SearchPanelProps {
  query: string;
  onQueryChange: (value: string) => void;
  mask: string;
  onMaskChange: (value: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (value: boolean) => void;
  onSearch: () => void;
  onCancel: () => void;
  running: boolean;
  status: string;
  results: SearchMatch[];
  onOpenResult: (docName: string, line: number) => void;
  focusToken: number;
  active: boolean;
}

function SearchPanel({
  query,
  onQueryChange,
  mask,
  onMaskChange,
  caseSensitive,
  onCaseSensitiveChange,
  onSearch,
  onCancel,
  running,
  status,
  results,
  onOpenResult,
  focusToken,
  active,
}: SearchPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [classicMode, setClassicMode] = useState(false);
  const [collapsedDocs, setCollapsedDocs] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (focusToken === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  // A fresh search result set should start fully expanded, not carry over collapse state from
  // whatever the previous query happened to leave collapsed.
  useEffect(() => {
    setCollapsedDocs(new Set());
  }, [results]);

  const groups = useMemo(() => {
    const byDoc = new Map<string, SearchMatch[]>();
    for (const match of results) {
      const list = byDoc.get(match.docName);
      if (list) list.push(match);
      else byDoc.set(match.docName, [match]);
    }
    return Array.from(byDoc.entries()).map(([docName, matches]) => ({ docName, matches }));
  }, [results]);

  const allCollapsed =
    groups.length > 0 && groups.every((group) => collapsedDocs.has(group.docName));

  function toggleGroup(docName: string) {
    setCollapsedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(docName)) next.delete(docName);
      else next.add(docName);
      return next;
    });
  }

  function toggleAllGroups() {
    setCollapsedDocs(allCollapsed ? new Set() : new Set(groups.map((group) => group.docName)));
  }

  return (
    <div className="search-panel" style={{ display: active ? "flex" : "none" }}>
      <div className="search-panel-bar">
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && onSearch()}
          placeholder="Pesquisar em todos os arquivos do namespace atual…"
        />
        <input
          className="search-mask-input"
          value={mask}
          onChange={(event) => onMaskChange(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && onSearch()}
          placeholder="*.cls,*.int (padrão)"
          title="Onde pesquisar: máscaras separadas por vírgula, com * e ?. Ex.: *.cls  ou  Pkg.*.cls,*.int"
        />
        <label className="search-case-toggle" title="Diferenciar maiúsculas de minúsculas">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(event) => onCaseSensitiveChange(event.target.checked)}
          />
          Aa
        </label>
        <label
          className="search-case-toggle"
          title="Lista simples Rotina / Linha / Código, como no Studio"
        >
          <input
            type="checkbox"
            checked={classicMode}
            onChange={(event) => setClassicMode(event.target.checked)}
          />
          Modo clássico
        </label>
        {!classicMode && groups.length > 0 && (
          <button type="button" onClick={toggleAllGroups}>
            {allCollapsed ? "Expandir tudo" : "Recolher tudo"}
          </button>
        )}
        {running && (
          <button type="button" onClick={onCancel}>
            Cancelar
          </button>
        )}
        <button type="button" onClick={onSearch} disabled={running || !query.trim()}>
          {running ? "Buscando…" : "Buscar"}
        </button>
      </div>
      {status && <div className="search-panel-status">{status}</div>}
      {classicMode ? (
        <div className="search-panel-results search-classic-results">
          <table className="search-classic-table">
            <thead>
              <tr>
                <th>Rotina</th>
                <th>Linha</th>
                <th>Código</th>
              </tr>
            </thead>
            <tbody>
              {results.map((match, index) => (
                <tr
                  key={`${match.docName}:${match.line}:${index}`}
                  onClick={() => onOpenResult(match.docName, match.line)}
                >
                  <td className="search-classic-doc">{match.docName}</td>
                  <td className="search-classic-line">{match.line}</td>
                  <td className="search-classic-text">{match.text.trim()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="search-panel-results">
          {groups.map((group) => {
            const collapsed = collapsedDocs.has(group.docName);
            return (
              <div key={group.docName} className="search-result-group">
                <div className="search-result-file" onClick={() => toggleGroup(group.docName)}>
                  <span className="search-result-chevron">{collapsed ? "▸" : "▾"}</span>📄{" "}
                  {group.docName}{" "}
                  <span className="search-result-count">({group.matches.length})</span>
                </div>
                {!collapsed &&
                  group.matches.map((match) => (
                    <div
                      key={match.line}
                      className="search-result-line"
                      onClick={() => onOpenResult(match.docName, match.line)}
                    >
                      <span className="search-result-lineno">{match.line}</span>
                      <span className="search-result-text">{match.text.trim()}</span>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default SearchPanel;
