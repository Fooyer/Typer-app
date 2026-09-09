import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { TreeFolder, TreeNode } from "../utils/documentTree";
import { canReparent } from "../utils/documentTree";

interface FileExplorerProps {
  nodes: TreeNode[];
  onOpenFile: (docName: string) => void;
  /** `selectedNodes` includes every node currently multi-selected (may just be `[node]`). */
  onNodeContextMenu?: (node: TreeNode, x: number, y: number, selectedNodes: TreeNode[]) => void;
  onRename?: (node: TreeNode, newName: string) => void;
  onMove?: (source: TreeNode, target: TreeFolder | null) => void;
}

export interface FileExplorerHandle {
  /** Enters inline rename mode for a node — used by the right-click "Renomear" menu item so it
   * edits the name in place instead of opening a separate dialog. */
  startRename: (node: TreeNode) => void;
}

const FILE_ICONS: Record<string, string> = {
  cls: "🧩",
  mac: "⚙️",
  int: "⚙️",
  inc: "🔖",
  csp: "🌐",
  csr: "🌐",
  bas: "📜",
  md: "📝",
  txt: "📄",
  json: "🧾",
};

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  return (ext && FILE_ICONS[ext]) || "📄";
}

function nodeKey(node: TreeNode): string {
  return node.type === "file" ? `f:${node.docName}` : `d:${node.path}`;
}

// Fixed row height (not measured) so absolute-positioned rows always line up exactly — see the
// `height` set on each row below. Matches the old .file-tree-file/.file-tree-folder-label padding
// (2px top/bottom) plus a 12px line box at the sidebar's 12px font-size.
const ROW_HEIGHT = 22;
const INDENT_PX = 14;
// Extra rows rendered above/below the viewport so a fast scroll or key-repeat doesn't flash blank
// rows before the next paint catches up.
const OVERSCAN = 12;

interface Row {
  key: string;
  depth: number;
  node: TreeNode;
}

/**
 * Flattens the tree into just the rows that are actually visible given which folders are expanded.
 * Collapsed folders' children are never visited, so a namespace with thousands of classes tucked
 * under a handful of collapsed packages costs O(top-level items), not O(total documents) — the same
 * property the old recursive-JSX version had, just now computed once instead of re-rendered as DOM.
 */
function flattenVisible(nodes: TreeNode[], expanded: Set<string>, depth: number, out: Row[]) {
  for (const node of nodes) {
    if (node.type === "file") {
      out.push({ key: `f:${node.docName}`, depth, node });
    } else {
      out.push({ key: `d:${node.path}`, depth, node });
      if (expanded.has(node.path)) flattenVisible(node.children, expanded, depth + 1, out);
    }
  }
}

function isDescendantPath(ancestorPath: string, path: string): boolean {
  return path === ancestorPath || path.startsWith(`${ancestorPath}.`);
}

const FileExplorer = forwardRef<FileExplorerHandle, FileExplorerProps>(function FileExplorer(
  { nodes, onOpenFile, onNodeContextMenu, onRename, onMove },
  ref,
) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draggingNode, setDraggingNode] = useState<TreeNode | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const lastIndexRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useImperativeHandle(
    ref,
    () => ({
      startRename(node: TreeNode) {
        setEditingKey(nodeKey(node));
      },
    }),
    [],
  );

  const rows = useMemo(() => {
    const out: Row[] = [];
    flattenVisible(nodes, expanded, 0, out);
    return out;
  }, [nodes, expanded]);

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    const observer = new ResizeObserver(([entry]) => setViewportHeight(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    setScrollTop(viewportRef.current?.scrollTop ?? 0);
  }, []);

  const toggleFolder = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const commitRename = useCallback(
    (node: TreeNode, value: string) => {
      setEditingKey(null);
      const trimmed = value.trim();
      if (!trimmed || trimmed === node.name) return;
      onRename?.(node, trimmed);
    },
    [onRename],
  );

  const cancelRename = useCallback(() => setEditingKey(null), []);
  const startRename = useCallback((key: string) => setEditingKey(key), []);
  const clearDragOver = useCallback(() => setDragOverKey(null), []);

  const handleDragStart = useCallback((node: TreeNode) => {
    setDraggingNode(node);
  }, []);

  const handleDragEnd = useCallback(() => {
    setDraggingNode(null);
    setDragOverKey(null);
  }, []);

  const isValidDropTarget = useCallback(
    (target: TreeFolder | null) => {
      if (!draggingNode) return false;
      if (target === null) return true;
      if (draggingNode.type === "folder" && isDescendantPath(draggingNode.path, target.path))
        return false;
      if (draggingNode.type === "file" && nodeKey(draggingNode) === `d:${target.path}`)
        return false;
      return true;
    },
    [draggingNode],
  );

  const handleDrop = useCallback(
    (target: TreeFolder | null) => {
      setDragOverKey(null);
      const source = draggingNode;
      setDraggingNode(null);
      if (!source || !isValidDropTarget(target)) return;
      const destination = target ? `"${target.name}"` : "raiz do namespace";
      const label = source.type === "folder" ? `pasta "${source.name}"` : `"${source.name}"`;
      if (!window.confirm(`Mover ${label} para ${destination}?`)) return;
      onMove?.(source, target);
    },
    [draggingNode, isValidDropTarget, onMove],
  );

  // Ctrl/Cmd+click toggles one row in/out of the selection; Shift+click selects the visible range
  // since the last clicked row; a plain click collapses the selection to just that row and keeps
  // the old open-file/toggle-folder behavior — the same conventions as VS Code's explorer.
  const handleRowClick = useCallback(
    (event: React.MouseEvent, row: Row, index: number) => {
      if (event.ctrlKey || event.metaKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(row.key)) next.delete(row.key);
          else next.add(row.key);
          return next;
        });
        lastIndexRef.current = index;
        return;
      }
      if (event.shiftKey && lastIndexRef.current !== null) {
        const [from, to] = [lastIndexRef.current, index].sort((a, b) => a - b);
        setSelected(new Set(rows.slice(from, to + 1).map((r) => r.key)));
        return;
      }
      setSelected(new Set([row.key]));
      lastIndexRef.current = index;
      if (row.node.type === "file") onOpenFile(row.node.docName);
      else toggleFolder(row.node.path);
    },
    [rows, onOpenFile, toggleFolder],
  );

  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent, row: Row) => {
      if (!onNodeContextMenu) return;
      event.preventDefault();
      event.stopPropagation();
      if (selected.has(row.key) && selected.size > 1) {
        const selectedNodes = rows.filter((r) => selected.has(r.key)).map((r) => r.node);
        onNodeContextMenu(row.node, event.clientX, event.clientY, selectedNodes);
      } else {
        setSelected(new Set([row.key]));
        onNodeContextMenu(row.node, event.clientX, event.clientY, [row.node]);
      }
    },
    [onNodeContextMenu, rows, selected],
  );

  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    rows.length,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );
  const visible = rows.slice(startIndex, endIndex);

  return (
    <div
      className="file-tree-viewport"
      ref={viewportRef}
      onScroll={handleScroll}
      onDragOver={(event) => {
        if (!isValidDropTarget(null)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        event.preventDefault();
        handleDrop(null);
      }}
    >
      <div className="file-tree" style={{ height: rows.length * ROW_HEIGHT }}>
        {visible.map((row, i) => (
          <FileTreeRow
            key={row.key}
            row={row}
            index={startIndex + i}
            top={(startIndex + i) * ROW_HEIGHT}
            expanded={row.node.type === "folder" && expanded.has(row.node.path)}
            editing={editingKey === row.key}
            dragging={draggingNode !== null && nodeKey(draggingNode) === row.key}
            dragOver={dragOverKey === row.key}
            selected={selected.has(row.key)}
            onRowClick={handleRowClick}
            onRowContextMenu={handleRowContextMenu}
            onCommitRename={commitRename}
            onCancelRename={cancelRename}
            onStartRename={startRename}
            canDrag={canReparent(row.node)}
            onDragStartNode={handleDragStart}
            onDragEndNode={handleDragEnd}
            isValidDropTarget={isValidDropTarget}
            onDragOverRow={setDragOverKey}
            onDragLeaveRow={clearDragOver}
            onDropRow={handleDrop}
          />
        ))}
      </div>
    </div>
  );
});

const FileTreeRow = memo(function FileTreeRow({
  row,
  index,
  top,
  expanded,
  editing,
  dragging,
  dragOver,
  selected,
  onRowClick,
  onRowContextMenu,
  onCommitRename,
  onCancelRename,
  onStartRename,
  canDrag,
  onDragStartNode,
  onDragEndNode,
  isValidDropTarget,
  onDragOverRow,
  onDragLeaveRow,
  onDropRow,
}: {
  row: Row;
  index: number;
  top: number;
  expanded: boolean;
  editing: boolean;
  dragging: boolean;
  dragOver: boolean;
  selected: boolean;
  onRowClick: (event: React.MouseEvent, row: Row, index: number) => void;
  onRowContextMenu: (event: React.MouseEvent, row: Row) => void;
  onCommitRename: (node: TreeNode, value: string) => void;
  onCancelRename: () => void;
  onStartRename: (key: string) => void;
  canDrag: boolean;
  onDragStartNode: (node: TreeNode) => void;
  onDragEndNode: () => void;
  isValidDropTarget: (target: TreeFolder | null) => boolean;
  onDragOverRow: (key: string) => void;
  onDragLeaveRow: () => void;
  onDropRow: (target: TreeFolder | null) => void;
}) {
  const { node, depth } = row;
  const style = { top, height: ROW_HEIGHT, paddingLeft: depth * INDENT_PX + 4 };
  const guides = Array.from({ length: depth }, (_, level) => (
    <span key={level} className="file-tree-guide" style={{ left: level * INDENT_PX + 11 }} />
  ));
  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "F2") {
      event.preventDefault();
      onStartRename(row.key);
    }
  }

  const dragHandlers = canDrag
    ? {
        draggable: true,
        onDragStart: (event: React.DragEvent) => {
          event.dataTransfer.effectAllowed = "move";
          onDragStartNode(node);
        },
        onDragEnd: () => onDragEndNode(),
      }
    : undefined;

  const folderDropHandlers =
    node.type === "folder"
      ? {
          onDragOver: (event: React.DragEvent) => {
            if (!isValidDropTarget(node)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "move";
            onDragOverRow(row.key);
          },
          onDragLeave: () => onDragLeaveRow(),
          onDrop: (event: React.DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            onDropRow(node);
          },
        }
      : undefined;

  const className = [
    "file-tree-row",
    node.type === "file" ? "file-tree-file" : "file-tree-folder-label",
    selected ? "selected" : "",
    dragging ? "dragging" : "",
    dragOver ? "drag-over" : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (node.type === "file") {
    return (
      <div
        className={className}
        style={style}
        tabIndex={0}
        onClick={(event) => onRowClick(event, row, index)}
        onContextMenu={(event) => onRowContextMenu(event, row)}
        onKeyDown={handleKeyDown}
        title={node.docName}
        {...dragHandlers}
      >
        {guides}
        <span className="file-tree-icon">{fileIcon(node.name)}</span>
        {editing ? (
          <RenameInput
            initialValue={node.name}
            onCommit={(value) => onCommitRename(node, value)}
            onCancel={onCancelRename}
          />
        ) : (
          node.name
        )}
      </div>
    );
  }

  return (
    <div
      className={className}
      style={style}
      tabIndex={0}
      onClick={(event) => onRowClick(event, row, index)}
      onContextMenu={(event) => onRowContextMenu(event, row)}
      onKeyDown={handleKeyDown}
      {...dragHandlers}
      {...folderDropHandlers}
    >
      {guides}
      <span className="file-tree-chevron">{expanded ? "▾" : "▸"}</span>
      <span className="file-tree-icon">{expanded ? "📂" : "📁"}</span>
      {editing ? (
        <RenameInput
          initialValue={node.name}
          onCommit={(value) => onCommitRename(node, value)}
          onCancel={onCancelRename}
        />
      ) : (
        node.name
      )}
    </div>
  );
});

/** Enter/blur commits, Escape cancels — the blur-commits-by-default path is what lets Enter simply
 * blur the input rather than needing separate commit wiring for keyboard vs. click-away. */
function RenameInput({
  initialValue,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const cancelledRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <input
      ref={inputRef}
      className="file-tree-rename-input"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          inputRef.current?.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancelledRef.current = true;
          inputRef.current?.blur();
        }
      }}
      onBlur={() => {
        if (cancelledRef.current) onCancel();
        else onCommit(value);
      }}
    />
  );
}

export default FileExplorer;
