import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AtelierDocNameEntry } from "../platform/types";
import {
  buildDocumentTree,
  type TreeFile,
  type TreeFolder,
  type TreeNode,
} from "../utils/documentTree";
import { isNoiseDocument } from "../utils/documentFilters";

interface ExportClassesModalProps {
  classNames: string[];
  initialSelected: string[];
  onExport: (selectedNames: string[]) => void;
  onClose: () => void;
}

const MAX_RESULTS = 500;

function toEntries(names: string[]): AtelierDocNameEntry[] {
  return names.map((name) => ({ name, cat: "cls" }));
}

function rankMatches(query: string, names: string[]): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return names;
  const startsWith: string[] = [];
  const contains: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.startsWith(q)) startsWith.push(name);
    else if (lower.includes(q)) contains.push(name);
  }
  return [...startsWith, ...contains].slice(0, MAX_RESULTS);
}

function expandAllFolders(nodes: TreeNode[]): Set<string> {
  const expanded = new Set<string>();
  const walk = (children: TreeNode[]) => {
    for (const child of children) {
      if (child.type === "folder") { expanded.add(child.path); walk(child.children); }
    }
  };
  walk(nodes);
  return expanded;
}

function ExportClassesModal({ classNames, initialSelected, onExport, onClose }: ExportClassesModalProps) {
  const [query, setQuery] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(initialSelected));
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    const initialTree = buildDocumentTree(
      toEntries(classNames.filter((name) => !isNoiseDocument(name))),
    );
    return expandAllFolders(initialTree);
  });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const visibleNames = useMemo(() => {
    const filterable = showSystem ? classNames : classNames.filter((name) => !isNoiseDocument(name));
    return rankMatches(query, filterable);
  }, [classNames, showSystem, query]);

  const tree = useMemo(() => buildDocumentTree(toEntries(visibleNames)), [visibleNames]);

  const folderClasses = useMemo(() => {
    const map = new Map<string, string[]>();
    const visit = (folder: TreeFolder) => {
      const under: string[] = [];
      for (const child of folder.children) {
        if (child.type === "folder") { visit(child); under.push(...(map.get(child.path) ?? [])); }
        else under.push(child.docName);
      }
      map.set(folder.path, under);
    };
    for (const node of tree) if (node.type === "folder") visit(node);
    return map;
  }, [tree]);

  const rows = useMemo(() => {
    const out: { kind: "folder" | "file"; node: TreeNode; depth: number }[] = [];
    const walk = (children: TreeNode[], depth: number) => {
      for (const child of children) {
        if (child.type === "folder") { out.push({ kind: "folder", node: child, depth }); if (expanded.has(child.path)) walk(child.children, depth + 1); }
        else out.push({ kind: "file", node: child, depth });
      }
    };
    walk(tree, 0);
    return out;
  }, [tree, expanded]);

  function folderState(folder: TreeFolder): { selected: number; total: number } {
    const under = folderClasses.get(folder.path) ?? [];
    return { selected: under.filter((n) => selected.has(n)).length, total: under.length };
  }

  function toggleName(name: string) {
    setSelected((prev) => { const next = new Set(prev); if (next.has(name)) next.delete(name); else next.add(name); return next; });
  }

  function toggleFolder(folder: TreeFolder) {
    const under = folderClasses.get(folder.path) ?? [];
    const { selected: sel } = folderState(folder);
    setSelected((prev) => {
      const next = new Set(prev);
      if (sel === under.length && under.length > 0) { for (const n of under) next.delete(n); }
      else { for (const n of under) next.add(n); }
      return next;
    });
  }

  function toggleExpand(path: string) {
    setExpanded((prev) => { const next = new Set(prev); if (next.has(path)) next.delete(path); else next.add(path); return next; });
  }

  function setAllExpanded(expand: boolean) {
    const next = new Set<string>();
    const walk = (children: TreeNode[]) => { for (const child of children) { if (child.type === "folder") { if (expand) next.add(child.path); walk(child.children); } } };
    walk(tree);
    setExpanded(next);
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    else if (event.key === "Enter" && selected.size > 0) { event.preventDefault(); onExport([...selected]); }
  }

  function checkboxRefFor(folder: TreeFolder) {
    return (el: HTMLInputElement | null) => {
      if (el) { const { selected: s, total: t } = folderState(folder); el.indeterminate = s > 0 && s < t; }
    };
  }

  return createPortal(
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <h4 style={{ margin: "0 0 10px", color: "#ccc", fontSize: 13 }}>Exportar classes como XML</h4>
        <input
          ref={inputRef}
          style={inputStyle}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filtrar classes… (Enter exporta, Esc cancela)"
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "0 2px", marginTop: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <button type="button" style={btnStyle} onClick={() => setAllExpanded(true)}>Expandir tudo</button>
            <button type="button" style={btnStyle} onClick={() => setAllExpanded(false)}>Recolher tudo</button>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "#ccc", cursor: "pointer" }}>
              <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} style={{ margin: 0 }} />
              Classes do sistema
            </label>
          </div>
          <span style={{ color: "#ccc", fontSize: 12, opacity: 0.8 }}>{selected.size} selecionada(s)</span>
        </div>
        <div style={{ padding: "0 2px", fontSize: 11, color: "#ccc", opacity: 0.65, marginTop: 4 }}>Marcar uma pasta seleciona todas as classes dentro dela.</div>
        <ul style={listStyle}>
          {rows.length === 0 && <li style={{ padding: "6px 10px", color: "#ccc", fontSize: 12, opacity: 0.7 }}>Nenhuma classe encontrada.</li>}
          {rows.map(({ kind, node, depth }) => {
            if (kind === "folder") {
              const fs = folderState(node as TreeFolder);
              const allSel = fs.total > 0 && fs.selected === fs.total;
              return (
                <li
                  key={`f:${(node as TreeFolder).path}`}
                  style={{ ...rowStyle, paddingLeft: depth * 14 + 4, background: allSel ? "#04395e" : undefined }}
                >
                  <span
                    style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, flexShrink: 0, cursor: "pointer", color: "#ccc", opacity: 0.8, fontSize: 11, userSelect: "none" }}
                    onClick={() => toggleExpand((node as TreeFolder).path)}
                    role="button"
                    tabIndex={0}
                  >
                    {expanded.has((node as TreeFolder).path) ? "\u25BE" : "\u25B8"}
                  </span>
                  <input
                    type="checkbox"
                    checked={allSel}
                    ref={checkboxRefFor(node as TreeFolder)}
                    readOnly
                    style={{ margin: 0, flexShrink: 0 }}
                    onClick={() => toggleFolder(node as TreeFolder)}
                  />
                  <span
                    style={{ color: "#ccc", cursor: "pointer", flex: 1, minWidth: 0 }}
                    onClick={() => toggleFolder(node as TreeFolder)}
                  >
                    {(node as TreeFolder).name}
                  </span>
                  {fs.total > 0 && (
                    <span style={{ marginLeft: "auto", flexShrink: 0, fontSize: 11, opacity: 0.6, color: "#ccc" }}>
                      {fs.selected}/{fs.total}
                    </span>
                  )}
                </li>
              );
            }
            const docName = (node as TreeFile).docName;
            return (
              <li
                key={`c:${docName}`}
                style={{ ...rowStyle, paddingLeft: depth * 14 + 4, background: selected.has(docName) ? "#04395e" : undefined }}
                onClick={() => toggleName(docName)}
              >
                <input
                  type="checkbox"
                  checked={selected.has(docName)}
                  readOnly
                  style={{ margin: 0, flexShrink: 0 }}
                />
                <span style={{ color: "#ccc", flex: 1, minWidth: 0, whiteSpace: "nowrap" }}>
                  {docName.replace(/\.cls$/i, "")}
                </span>
              </li>
            );
          })}
        </ul>
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <button type="button" style={{ ...btnStyle, flex: "1 1 auto" }} onClick={() => onExport([...selected])} disabled={selected.size === 0}>
            Exportar {selected.size > 0 ? `(${selected.size})` : ""}…
          </button>
          <button type="button" style={{ ...btnStyle, flex: "1 1 auto" }} onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1001,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.45)",
};

const modalStyle: React.CSSProperties = {
  width: 520,
  maxWidth: "94vw",
  background: "#252526",
  border: "1px solid #454545",
  borderRadius: 8,
  padding: 16,
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
  fontFamily: "system-ui, sans-serif",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  fontSize: 13,
  padding: "8px 10px",
  color: "#d4d4d4",
  background: "#3c3c3c",
  border: "1px solid transparent",
  borderRadius: 4,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const btnStyle: React.CSSProperties = {
  fontSize: 12,
  cursor: "pointer",
  color: "#fff",
  background: "#0e639c",
  border: "1px solid transparent",
  borderRadius: 4,
  padding: "4px 8px",
  fontFamily: "inherit",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  maxHeight: 380,
  overflowY: "auto",
  borderRadius: 4,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 10px",
  borderRadius: 4,
  cursor: "pointer",
  color: "#ccc",
  fontSize: 12,
  fontFamily: "ui-monospace, Consolas, monospace",
};

export default ExportClassesModal;