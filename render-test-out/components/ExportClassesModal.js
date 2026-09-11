"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const react_dom_1 = require("react-dom");
const documentTree_1 = require("../utils/documentTree");
const documentFilters_1 = require("../utils/documentFilters");
const MAX_RESULTS = 500;
function toEntries(names) {
    return names.map((name) => ({ name, cat: "cls" }));
}
function rankMatches(query, names) {
    const q = query.trim().toLowerCase();
    if (!q)
        return names;
    const startsWith = [];
    const contains = [];
    for (const name of names) {
        const lower = name.toLowerCase();
        if (lower.startsWith(q))
            startsWith.push(name);
        else if (lower.includes(q))
            contains.push(name);
    }
    return [...startsWith, ...contains].slice(0, MAX_RESULTS);
}
function expandAllFolders(nodes) {
    const expanded = new Set();
    const walk = (children) => {
        for (const child of children) {
            if (child.type === "folder") {
                expanded.add(child.path);
                walk(child.children);
            }
        }
    };
    walk(nodes);
    return expanded;
}
function ExportClassesModal({ classNames, initialSelected, onExport, onClose }) {
    const [query, setQuery] = (0, react_1.useState)("");
    const [showSystem, setShowSystem] = (0, react_1.useState)(false);
    const [selected, setSelected] = (0, react_1.useState)(() => new Set(initialSelected));
    const [expanded, setExpanded] = (0, react_1.useState)(() => {
        const initialTree = (0, documentTree_1.buildDocumentTree)(toEntries(classNames.filter((name) => !(0, documentFilters_1.isNoiseDocument)(name))));
        return expandAllFolders(initialTree);
    });
    const inputRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => { inputRef.current?.focus(); }, []);
    const visibleNames = (0, react_1.useMemo)(() => {
        const filterable = showSystem ? classNames : classNames.filter((name) => !(0, documentFilters_1.isNoiseDocument)(name));
        return rankMatches(query, filterable);
    }, [classNames, showSystem, query]);
    const tree = (0, react_1.useMemo)(() => (0, documentTree_1.buildDocumentTree)(toEntries(visibleNames)), [visibleNames]);
    const folderClasses = (0, react_1.useMemo)(() => {
        const map = new Map();
        const visit = (folder) => {
            const under = [];
            for (const child of folder.children) {
                if (child.type === "folder") {
                    visit(child);
                    under.push(...(map.get(child.path) ?? []));
                }
                else
                    under.push(child.docName);
            }
            map.set(folder.path, under);
        };
        for (const node of tree)
            if (node.type === "folder")
                visit(node);
        return map;
    }, [tree]);
    const rows = (0, react_1.useMemo)(() => {
        const out = [];
        const walk = (children, depth) => {
            for (const child of children) {
                if (child.type === "folder") {
                    out.push({ kind: "folder", node: child, depth });
                    if (expanded.has(child.path))
                        walk(child.children, depth + 1);
                }
                else
                    out.push({ kind: "file", node: child, depth });
            }
        };
        walk(tree, 0);
        return out;
    }, [tree, expanded]);
    function folderState(folder) {
        const under = folderClasses.get(folder.path) ?? [];
        return { selected: under.filter((n) => selected.has(n)).length, total: under.length };
    }
    function toggleName(name) {
        setSelected((prev) => { const next = new Set(prev); if (next.has(name))
            next.delete(name);
        else
            next.add(name); return next; });
    }
    function toggleFolder(folder) {
        const under = folderClasses.get(folder.path) ?? [];
        const { selected: sel } = folderState(folder);
        setSelected((prev) => {
            const next = new Set(prev);
            if (sel === under.length && under.length > 0) {
                for (const n of under)
                    next.delete(n);
            }
            else {
                for (const n of under)
                    next.add(n);
            }
            return next;
        });
    }
    function toggleExpand(path) {
        setExpanded((prev) => { const next = new Set(prev); if (next.has(path))
            next.delete(path);
        else
            next.add(path); return next; });
    }
    function setAllExpanded(expand) {
        const next = new Set();
        const walk = (children) => { for (const child of children) {
            if (child.type === "folder") {
                if (expand)
                    next.add(child.path);
                walk(child.children);
            }
        } };
        walk(tree);
        setExpanded(next);
    }
    function handleKeyDown(event) {
        if (event.key === "Escape") {
            event.preventDefault();
            onClose();
        }
        else if (event.key === "Enter" && selected.size > 0) {
            event.preventDefault();
            onExport([...selected]);
        }
    }
    function checkboxRefFor(folder) {
        return (el) => {
            if (el) {
                const { selected: s, total: t } = folderState(folder);
                el.indeterminate = s > 0 && s < t;
            }
        };
    }
    return (0, react_dom_1.createPortal)((0, jsx_runtime_1.jsx)("div", { style: overlayStyle, onClick: onClose, children: (0, jsx_runtime_1.jsxs)("div", { style: modalStyle, onClick: (e) => e.stopPropagation(), onKeyDown: handleKeyDown, children: [(0, jsx_runtime_1.jsx)("h4", { style: { margin: "0 0 10px", color: "#ccc", fontSize: 13 }, children: "Exportar classes como XML" }), (0, jsx_runtime_1.jsx)("input", { ref: inputRef, style: inputStyle, value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Filtrar classes\u2026 (Enter exporta, Esc cancela)" }), (0, jsx_runtime_1.jsxs)("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "0 2px", marginTop: 6 }, children: [(0, jsx_runtime_1.jsxs)("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }, children: [(0, jsx_runtime_1.jsx)("button", { type: "button", style: btnStyle, onClick: () => setAllExpanded(true), children: "Expandir tudo" }), (0, jsx_runtime_1.jsx)("button", { type: "button", style: btnStyle, onClick: () => setAllExpanded(false), children: "Recolher tudo" }), (0, jsx_runtime_1.jsxs)("label", { style: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "#ccc", cursor: "pointer" }, children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: showSystem, onChange: (e) => setShowSystem(e.target.checked), style: { margin: 0 } }), "Classes do sistema"] })] }), (0, jsx_runtime_1.jsxs)("span", { style: { color: "#ccc", fontSize: 12, opacity: 0.8 }, children: [selected.size, " selecionada(s)"] })] }), (0, jsx_runtime_1.jsx)("div", { style: { padding: "0 2px", fontSize: 11, color: "#ccc", opacity: 0.65, marginTop: 4 }, children: "Marcar uma pasta seleciona todas as classes dentro dela." }), (0, jsx_runtime_1.jsxs)("ul", { style: listStyle, children: [rows.length === 0 && (0, jsx_runtime_1.jsx)("li", { style: { padding: "6px 10px", color: "#ccc", fontSize: 12, opacity: 0.7 }, children: "Nenhuma classe encontrada." }), rows.map(({ kind, node, depth }) => {
                            if (kind === "folder") {
                                const fs = folderState(node);
                                const allSel = fs.total > 0 && fs.selected === fs.total;
                                return ((0, jsx_runtime_1.jsxs)("li", { style: { ...rowStyle, paddingLeft: depth * 14 + 4, background: allSel ? "#04395e" : undefined }, children: [(0, jsx_runtime_1.jsx)("span", { style: { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 14, flexShrink: 0, cursor: "pointer", color: "#ccc", opacity: 0.8, fontSize: 11, userSelect: "none" }, onClick: () => toggleExpand(node.path), role: "button", tabIndex: 0, children: expanded.has(node.path) ? "\u25BE" : "\u25B8" }), (0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: allSel, ref: checkboxRefFor(node), readOnly: true, style: { margin: 0, flexShrink: 0 }, onClick: () => toggleFolder(node) }), (0, jsx_runtime_1.jsx)("span", { style: { color: "#ccc", cursor: "pointer", flex: 1, minWidth: 0 }, onClick: () => toggleFolder(node), children: node.name }), fs.total > 0 && ((0, jsx_runtime_1.jsxs)("span", { style: { marginLeft: "auto", flexShrink: 0, fontSize: 11, opacity: 0.6, color: "#ccc" }, children: [fs.selected, "/", fs.total] }))] }, `f:${node.path}`));
                            }
                            const docName = node.docName;
                            return ((0, jsx_runtime_1.jsxs)("li", { style: { ...rowStyle, paddingLeft: depth * 14 + 4, background: selected.has(docName) ? "#04395e" : undefined }, onClick: () => toggleName(docName), children: [(0, jsx_runtime_1.jsx)("input", { type: "checkbox", checked: selected.has(docName), readOnly: true, style: { margin: 0, flexShrink: 0 } }), (0, jsx_runtime_1.jsx)("span", { style: { color: "#ccc", flex: 1, minWidth: 0, whiteSpace: "nowrap" }, children: docName.replace(/\.cls$/i, "") })] }, `c:${docName}`));
                        })] }), (0, jsx_runtime_1.jsxs)("div", { style: { display: "flex", gap: 6, marginTop: 10 }, children: [(0, jsx_runtime_1.jsxs)("button", { type: "button", style: { ...btnStyle, flex: "1 1 auto" }, onClick: () => onExport([...selected]), disabled: selected.size === 0, children: ["Exportar ", selected.size > 0 ? `(${selected.size})` : "", "\u2026"] }), (0, jsx_runtime_1.jsx)("button", { type: "button", style: { ...btnStyle, flex: "1 1 auto" }, onClick: onClose, children: "Cancelar" })] })] }) }), document.body);
}
const overlayStyle = {
    position: "fixed",
    inset: 0,
    zIndex: 1001,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0,0,0,0.45)",
};
const modalStyle = {
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
const inputStyle = {
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
const btnStyle = {
    fontSize: 12,
    cursor: "pointer",
    color: "#fff",
    background: "#0e639c",
    border: "1px solid transparent",
    borderRadius: 4,
    padding: "4px 8px",
    fontFamily: "inherit",
};
const listStyle = {
    listStyle: "none",
    margin: 0,
    padding: 0,
    maxHeight: 380,
    overflowY: "auto",
    borderRadius: 4,
};
const rowStyle = {
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
exports.default = ExportClassesModal;
