import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ConnectionProfile, AtelierDocNameEntry } from "../platform/types";
import {
  buildDocumentTree,
  collectFiles,
  docParentPath,
  parentPath,
  rehomeDocName,
  collectClassFiles,
  type TreeFile,
  type TreeFolder,
  type TreeNode,
} from "../utils/documentTree";
import { isNoiseDocument } from "../utils/documentFilters";
import { matchesGlob } from "../utils/glob";
import { classSourceToExportXml, combineExportXml } from "../utils/classXmlExport";
import { mapWithConcurrency } from "../utils/concurrency";
import { setKnownClasses } from "../monaco/classIndex";
import FileExplorer, { type FileExplorerHandle } from "./FileExplorer";
import SidebarSection from "./SidebarSection";
import SpecsPanel from "./SpecsPanel";
import type { LogLevel } from "./OutputPanel";

interface ConnectionsPanelProps {
  onOpenDocument: (connectionId: string, namespace: string, name: string, content: string) => void;
  onLog: (message: string, level?: LogLevel) => void;
  onDocumentDeleted?: (connectionId: string, namespace: string, docName: string) => void;
  onDocumentRenamed?: (
    connectionId: string,
    namespace: string,
    oldName: string,
    newName: string,
  ) => void;
  onOpenApiTester?: (connectionId: string, namespace: string, docName: string) => void;
  onOpenAgent?: (connectionId: string, namespace: string) => void;
  onOpenSpec?: (path: string, name: string, content: string) => void;
  onSpecDeleted?: (specPath: string) => void;
  onSpecRenamed?: (oldPath: string, newPath: string, newName: string) => void;
}

export interface ConnectionsPanelHandle {
  /** Reloads the document list — but only if `connectionId`/`namespace` is the one currently shown,
   * so a background write (e.g. the agent saving a file in a namespace the user isn't even looking
   * at right now) doesn't yank the explorer out from under them. Debounced so several writes
   * approved back-to-back (the agent editing a handful of files in one run) coalesce into a single
   * `listDocuments` round trip instead of one per file. */
  refreshDocuments: (connectionId: string, namespace: string) => void;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const EMPTY_FORM = {
  id: undefined as string | undefined,
  name: "",
  host: "localhost",
  port: 52773,
  https: false,
  pathPrefix: "",
  username: "_SYSTEM",
  namespace: "USER",
  password: "",
};

const CLASS_TEMPLATE = (fullName: string) => [
  `Class ${fullName} Extends %RegisteredObject`,
  "{",
  "",
  "}",
  "",
];

const ConnectionsPanel = forwardRef<ConnectionsPanelHandle, ConnectionsPanelProps>(
  function ConnectionsPanel(
    {
      onOpenDocument,
      onLog,
      onDocumentDeleted,
      onDocumentRenamed,
      onOpenApiTester,
      onOpenAgent,
      onOpenSpec,
      onSpecDeleted,
      onSpecRenamed,
    }: ConnectionsPanelProps,
    ref,
  ) {
    const [connections, setConnections] = useState<ConnectionProfile[]>([]);
    const [explorerCollapsed, setExplorerCollapsed] = useState(false);
    const [connectionsCollapsed, setConnectionsCollapsed] = useState(false);
    const [specsCollapsed, setSpecsCollapsed] = useState(false);
    const [formOpen, setFormOpen] = useState(false);
    const [form, setForm] = useState(EMPTY_FORM);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [namespaces, setNamespaces] = useState<string[]>([]);
    const [activeNamespace, setActiveNamespace] = useState<string>("");
    const [allDocuments, setAllDocuments] = useState<AtelierDocNameEntry[]>([]);
    const [filter, setFilter] = useState("");
    const [showSystemFiles, setShowSystemFiles] = useState(false);
    const [contextMenu, setContextMenu] = useState<{
      x: number;
      y: number;
      node: TreeNode | null;
      selectedNodes: TreeNode[];
    } | null>(null);
    const [newClassDialogOpen, setNewClassDialogOpen] = useState(false);
    const [newClassName, setNewClassName] = useState("");
    const [newFileDialogOpen, setNewFileDialogOpen] = useState(false);
    const [newFileName, setNewFileName] = useState("");
    const [connectingTo, setConnectingTo] = useState<string | null>(null);
    const fileExplorerRef = useRef<FileExplorerHandle>(null);
    const [confirmRequest, setConfirmRequest] = useState<{
      message: string;
      confirmLabel?: string;
      onConfirm: () => void;
    } | null>(null);
    // Read by refreshDocuments below, which is exposed on the imperative handle and so can be called
    // long after the render that created it — a ref keeps it seeing the current connection/namespace
    // instead of whatever was active when the handle was first built.
    const activeConnectionRef = useRef<{ id: string; namespace: string } | null>(null);
    const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const hasElectronAPI = typeof window.electronAPI !== "undefined";
    activeConnectionRef.current =
      activeId && activeNamespace ? { id: activeId, namespace: activeNamespace } : null;

    const filteredDocuments = useMemo(
      () =>
        allDocuments.filter(
          (doc) => (showSystemFiles || !isNoiseDocument(doc.name)) && matchesGlob(filter, doc.name),
        ),
      [allDocuments, filter, showSystemFiles],
    );

    // Rebuilding the tree is O(documents) and every render that skips this memo (e.g. opening a
    // context menu, typing in the new-connection form) would otherwise redo it and hand FileExplorer a
    // brand-new `nodes` array — even though nothing about the file list changed — which in turn forces
    // its own memoized row-flattening to redo its work too. Keyed on filteredDocuments so it only
    // recomputes when the visible document set actually changes.
    const documentTree = useMemo(() => buildDocumentTree(filteredDocuments), [filteredDocuments]);

    useEffect(() => {
      if (!hasElectronAPI) return;
      window.electronAPI.connections.list().then(setConnections);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      if (!contextMenu) return;
      const close = () => setContextMenu(null);
      window.addEventListener("click", close);
      return () => window.removeEventListener("click", close);
    }, [contextMenu]);

    async function refreshConnections() {
      setConnections(await window.electronAPI.connections.list());
    }

    async function saveConnection() {
      const { password, ...profile } = form;
      await window.electronAPI.connections.save(profile, password || undefined);
      setForm(EMPTY_FORM);
      setFormOpen(false);
      await refreshConnections();
      onLog(`Conexão "${profile.name || profile.host}" salva.`, "success");
    }

    async function performDeleteConnection(id: string) {
      await window.electronAPI.connections.delete(id);
      if (activeId === id) {
        setActiveId(null);
        setAllDocuments([]);
        setNamespaces([]);
      }
      await refreshConnections();
    }

    function requestDeleteConnection(connection: ConnectionProfile) {
      setConfirmRequest({
        message: `Remover a conexão "${connection.name || connection.host}"? As credenciais salvas serão apagadas.`,
        confirmLabel: "Remover",
        onConfirm: () => {
          setConfirmRequest(null);
          void performDeleteConnection(connection.id);
        },
      });
    }

    function editConnection(connection: ConnectionProfile) {
      setForm({ ...connection, pathPrefix: connection.pathPrefix ?? "", password: "" });
      setFormOpen(true);
    }

    function newConnection() {
      setForm(EMPTY_FORM);
      setFormOpen(true);
    }

    async function testConnection(id: string) {
      onLog("Testando conexão…");
      try {
        const info = await window.electronAPI.atelier.test(id);
        onLog(`Conexão OK — servidor ${info.version} (API v${info.api})`, "success");
      } catch (error) {
        onLog(`Erro ao testar conexão: ${(error as Error).message}`, "error");
      }
    }

    async function loadDocuments(id: string, namespace: string) {
      onLog(`Listando arquivos em ${namespace}…`);
      try {
        const docs = await window.electronAPI.atelier.listDocuments(id, namespace);
        setAllDocuments(docs);
        setKnownClasses(
          docs
            .filter((doc) => doc.name.toLowerCase().endsWith(".cls"))
            .map((doc) => doc.name.replace(/\.cls$/i, "")),
        );
        onLog(
          docs.length
            ? `${docs.length} arquivo(s) encontrado(s) em ${namespace}.`
            : `Nenhum arquivo encontrado em ${namespace}.`,
        );
      } catch (error) {
        onLog(`Erro ao listar arquivos: ${(error as Error).message}`, "error");
        setAllDocuments([]);
      }
    }

    useEffect(() => {
      return () => {
        if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
      };
    }, []);

    useImperativeHandle(
      ref,
      () => ({
        refreshDocuments(connectionId: string, namespace: string) {
          const current = activeConnectionRef.current;
          if (!current || current.id !== connectionId || current.namespace !== namespace) return;
          if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current);
          refreshDebounceRef.current = setTimeout(() => {
            refreshDebounceRef.current = null;
            void loadDocuments(connectionId, namespace);
          }, 300);
        },
      }),
      [],
    );

    async function connect(connection: ConnectionProfile) {
      const label = connection.name || `${connection.host}:${connection.port}`;
      setActiveId(connection.id);
      setAllDocuments([]);
      setExplorerCollapsed(false);
      setConnectionsCollapsed(true);
      setConnectingTo(label);
      onLog(`Conectando a "${label}"…`);
      try {
        const availableNamespaces = await window.electronAPI.atelier.listNamespaces(connection.id);
        setNamespaces(availableNamespaces);
        const namespace = availableNamespaces.includes(connection.namespace)
          ? connection.namespace
          : availableNamespaces[0];
        setActiveNamespace(namespace);
        onLog(`Conectado. Namespaces disponíveis: ${availableNamespaces.join(", ")}.`, "success");
        await loadDocuments(connection.id, namespace);
      } catch (error) {
        onLog(`Erro ao conectar: ${(error as Error).message}`, "error");
      } finally {
        setConnectingTo(null);
      }
    }

    function changeNamespace(namespace: string) {
      setActiveNamespace(namespace);
      if (activeId) void loadDocuments(activeId, namespace);
    }

    async function openDocument(name: string) {
      if (!activeId || !activeNamespace) return;
      onLog(`Abrindo ${name}…`);
      try {
        const doc = await window.electronAPI.atelier.getDocument(activeId, activeNamespace, name);
        onOpenDocument(activeId, activeNamespace, name, doc.content.join("\n"));
      } catch (error) {
        onLog(`Erro ao abrir ${name}: ${(error as Error).message}`, "error");
      }
    }

    function openNewClassDialog(prefix = "") {
      setNewClassName(prefix);
      setNewClassDialogOpen(true);
    }

    async function submitNewClass() {
      if (!activeId || !activeNamespace || !newClassName.trim()) return;
      const fullName = newClassName.trim().replace(/\.cls$/i, "");
      const docName = `${fullName}.cls`;
      setNewClassDialogOpen(false);
      setNewClassName("");
      onLog(`Criando ${docName}…`);
      try {
        const template = CLASS_TEMPLATE(fullName);
        await window.electronAPI.atelier.saveDocument(activeId, activeNamespace, docName, template);
        onLog(`${docName} criado.`, "success");
        await loadDocuments(activeId, activeNamespace);
        onOpenDocument(activeId, activeNamespace, docName, template.join("\n"));
      } catch (error) {
        onLog(`Erro ao criar ${docName}: ${(error as Error).message}`, "error");
      }
    }

    function openNewFileDialog(prefix = "") {
      setNewFileName(prefix);
      setNewFileDialogOpen(true);
    }

    /** Unlike classes, a generic document (markdown notes, plain text, …) has no fixed extension or
     * package convention to fill in for the user — they type the whole thing, "/" and all, the same
     * way non-.cls docs are already addressed everywhere else (see splitSegments in
     * documentTree.ts), and this just saves it empty for them to start writing in. */
    async function submitNewFile() {
      if (!activeId || !activeNamespace) return;
      const docName = newFileName.trim();
      if (!docName) return;
      const lastSegment = docName.slice(docName.lastIndexOf("/") + 1);
      if (!lastSegment.includes(".")) {
        onLog(`"${docName}" precisa de uma extensão (ex: "notas.md").`, "error");
        return;
      }
      setNewFileDialogOpen(false);
      setNewFileName("");
      onLog(`Criando ${docName}…`);
      try {
        await window.electronAPI.atelier.saveDocument(activeId, activeNamespace, docName, [""]);
        onLog(`${docName} criado.`, "success");
        await loadDocuments(activeId, activeNamespace);
        onOpenDocument(activeId, activeNamespace, docName, "");
      } catch (error) {
        onLog(`Erro ao criar ${docName}: ${(error as Error).message}`, "error");
      }
    }

    function handleContextMenu(event: React.MouseEvent) {
      event.preventDefault();
      setContextMenu({ x: event.clientX, y: event.clientY, node: null, selectedNodes: [] });
    }

    function handleNodeContextMenu(
      node: TreeNode,
      x: number,
      y: number,
      selectedNodes: TreeNode[],
    ) {
      setContextMenu({ x, y, node, selectedNodes });
    }

    function requestRename(node: TreeNode) {
      setContextMenu(null);
      fileExplorerRef.current?.startRename(node);
    }

    /** Renames a single document on the server (get → fix Class decl line if present → save →
     * compile → delete old). Shared by leaf renames (F2 on a file) and every file swept up by a
     * folder rename or a drag-and-drop move — those are just this, run once per affected file. */
    async function renameOneDocument(oldDocName: string, newDocName: string): Promise<boolean> {
      if (!activeId || !activeNamespace) return false;
      if (newDocName === oldDocName) return true;
      if (newDocName.toLowerCase() === oldDocName.toLowerCase()) {
        // IRIS resolves class/routine names case-insensitively, so "renaming" to a name that only
        // differs in letter case doesn't create a separate document — the save silently lands back
        // on the same existing one (confirmed: this previously corrupted the class's own declaration
        // line without ever creating the "new" name, then failed to compile it). Refuse instead of
        // risking that half-done state.
        onLog(
          `Não é possível renomear "${oldDocName}" para "${newDocName}": o IRIS não diferencia maiúsculas de minúsculas em nomes de classes/rotinas, então isso não conta como um nome novo. Escolha um nome que difira em mais que a capitalização.`,
          "error",
        );
        return false;
      }
      onLog(`Renomeando ${oldDocName} para ${newDocName}…`);
      try {
        const doc = await window.electronAPI.atelier.getDocument(
          activeId,
          activeNamespace,
          oldDocName,
        );
        let lines = doc.content;
        if (oldDocName.toLowerCase().endsWith(".cls")) {
          const oldFullName = oldDocName.replace(/\.cls$/i, "");
          const newFullName = newDocName.replace(/\.cls$/i, "");
          const declIndex = lines.findIndex((line) => /^\s*Class\s+/i.test(line));
          if (declIndex >= 0) {
            lines = [...lines];
            lines[declIndex] = lines[declIndex].replace(
              new RegExp(escapeRegExp(oldFullName)),
              newFullName,
            );
          }
        }
        await window.electronAPI.atelier.saveDocument(activeId, activeNamespace, newDocName, lines);
        const output = await window.electronAPI.atelier.compile(activeId, activeNamespace, [
          newDocName,
        ]);
        output.forEach((line) => onLog(line, "info"));
        await window.electronAPI.atelier.deleteDocument(activeId, activeNamespace, oldDocName);
        onDocumentRenamed?.(activeId, activeNamespace, oldDocName, newDocName);
        onLog(`${oldDocName} renomeado para ${newDocName}.`, "success");
        return true;
      } catch (error) {
        onLog(`Erro ao renomear ${oldDocName}: ${(error as Error).message}`, "error");
        return false;
      }
    }

    /** Renames every file under a moved/renamed folder, then reloads the tree once at the end. */
    async function renameBatch(pairs: { oldDocName: string; newDocName: string }[], label: string) {
      if (!activeId || !activeNamespace) return;
      const toRename = pairs.filter((pair) => pair.oldDocName !== pair.newDocName);
      if (toRename.length === 0) return;
      onLog(`Movendo ${label}: ${toRename.length} arquivo(s)…`);
      let okCount = 0;
      for (const { oldDocName, newDocName } of toRename) {
        if (await renameOneDocument(oldDocName, newDocName)) okCount++;
      }
      await loadDocuments(activeId, activeNamespace);
      onLog(
        `${label}: ${okCount}/${toRename.length} arquivo(s) movido(s).`,
        okCount === toRename.length ? "success" : "error",
      );
    }

    async function handleRename(node: TreeNode, newValue: string) {
      if (!activeId || !activeNamespace) return;
      if (node.type === "file") {
        const ext = node.name.includes(".") ? node.name.slice(node.name.lastIndexOf(".") + 1) : "";
        let newLeaf = newValue;
        if (ext && !newLeaf.toLowerCase().endsWith(`.${ext.toLowerCase()}`))
          newLeaf = `${newLeaf}.${ext}`;
        const prefix = node.docName.slice(0, node.docName.length - node.name.length);
        const newDocName = `${prefix}${newLeaf}`;
        if (await renameOneDocument(node.docName, newDocName))
          await loadDocuments(activeId, activeNamespace);
      } else {
        const parent = parentPath(node.path);
        const newFolderPath = parent ? `${parent}.${newValue}` : newValue;
        const pairs = collectFiles(node).map((file) => ({
          oldDocName: file.docName,
          newDocName: rehomeDocName(file.docName, node.path, newFolderPath),
        }));
        await renameBatch(pairs, `pasta "${node.name}"`);
      }
    }

    async function handleMove(source: TreeNode, target: TreeFolder | null) {
      if (!activeId || !activeNamespace) return;
      if (source.type === "folder") {
        const newFolderPath = target ? `${target.path}.${source.name}` : source.name;
        if (newFolderPath === source.path) return;
        const pairs = collectFiles(source).map((file) => ({
          oldDocName: file.docName,
          newDocName: rehomeDocName(file.docName, source.path, newFolderPath),
        }));
        await renameBatch(pairs, `pasta "${source.name}"`);
      } else {
        const oldPrefixPath = docParentPath(source.docName);
        const newPrefixPath = target ? target.path : "";
        if (newPrefixPath === oldPrefixPath) return;
        const newDocName = rehomeDocName(source.docName, oldPrefixPath, newPrefixPath);
        if (await renameOneDocument(source.docName, newDocName))
          await loadDocuments(activeId, activeNamespace);
      }
    }

    function requestDelete(node: TreeFile) {
      setContextMenu(null);
      if (!activeId || !activeNamespace) return;
      const connectionId = activeId;
      const namespace = activeNamespace;
      setConfirmRequest({
        message: `Excluir "${node.docName}"? Esta ação não pode ser desfeita.`,
        confirmLabel: "Excluir",
        onConfirm: () => {
          setConfirmRequest(null);
          void performDelete(connectionId, namespace, node);
        },
      });
    }

    async function performDelete(connectionId: string, namespace: string, node: TreeFile) {
      onLog(`Excluindo ${node.docName}…`);
      try {
        await window.electronAPI.atelier.deleteDocument(connectionId, namespace, node.docName);
        await loadDocuments(connectionId, namespace);
        onDocumentDeleted?.(connectionId, namespace, node.docName);
        onLog(`${node.docName} excluído.`, "success");
      } catch (error) {
        onLog(`Erro ao excluir ${node.docName}: ${(error as Error).message}`, "error");
      }
    }

    async function exportNodesAsXml(nodes: TreeNode[]) {
      setContextMenu(null);
      if (!activeId || !activeNamespace) return;
      const classFiles = collectClassFiles(nodes);
      if (classFiles.length === 0) {
        onLog("Nenhuma classe .cls encontrada na seleção.", "error");
        return;
      }
      onLog(`Exportando ${classFiles.length} classe(s) como XML…`);
      try {
        const xmls: string[] = new Array(classFiles.length);
        let firstClassName = "";
        await mapWithConcurrency(classFiles, 4, async (file, index) => {
          const doc = await window.electronAPI.atelier.getDocument(
            activeId,
            activeNamespace,
            file.docName,
          );
          const { xml, className } = classSourceToExportXml(doc.content);
          xmls[index] = xml;
          if (index === 0) firstClassName = className;
        });
        const combined = classFiles.length === 1 ? xmls[0] : combineExportXml(xmls);
        const suggestedName = classFiles.length === 1 ? `${firstClassName}.cls.xml` : "Export.xml";
        const savedPath = await window.electronAPI.files.saveText(suggestedName, combined);
        if (savedPath)
          onLog(`${classFiles.length} classe(s) exportada(s) para ${savedPath}.`, "success");
      } catch (error) {
        onLog(`Erro ao exportar: ${(error as Error).message}`, "error");
      }
    }

    if (!hasElectronAPI) {
      return (
        <div className="sidebar">
          <p className="connection-status">
            Disponível apenas rodando no app desktop — este recurso usa comandos Tauri com o
            processo principal.
          </p>
        </div>
      );
    }

    return (
      <div className="sidebar">
        <SidebarSection
          title="Explorador"
          collapsed={explorerCollapsed}
          onToggleCollapsed={() => setExplorerCollapsed((value) => !value)}
          actions={
            activeId ? (
              <>
                <button type="button" onClick={() => openNewClassDialog()} title="Nova classe">
                  🧩+
                </button>
                <button type="button" onClick={() => openNewFileDialog()} title="Novo arquivo">
                  📄+
                </button>
              </>
            ) : undefined
          }
        >
          {!activeId ? (
            <p className="connection-status">
              Conecte-se a um servidor abaixo para navegar pelos arquivos.
            </p>
          ) : (
            <div className="documents-list" onContextMenu={handleContextMenu}>
              <label className="namespace-select">
                Namespace
                <select
                  value={activeNamespace}
                  onChange={(event) => changeNamespace(event.target.value)}
                >
                  {namespaces.map((namespace) => (
                    <option key={namespace} value={namespace}>
                      {namespace}
                    </option>
                  ))}
                </select>
              </label>
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filtro por nome (ex: *.cls)"
              />
              <label className="show-system-toggle">
                <input
                  type="checkbox"
                  checked={showSystemFiles}
                  onChange={(event) => setShowSystemFiles(event.target.checked)}
                />
                Mostrar arquivos do sistema (Ens*, CSPX, .mac, .inc)
              </label>
              <FileExplorer
                ref={fileExplorerRef}
                nodes={documentTree}
                onOpenFile={openDocument}
                onNodeContextMenu={handleNodeContextMenu}
                onRename={handleRename}
                onMove={handleMove}
              />
            </div>
          )}
        </SidebarSection>

        <SpecsPanel
          connectionId={activeId}
          namespace={activeNamespace || null}
          collapsed={specsCollapsed}
          onToggleCollapsed={() => setSpecsCollapsed((value) => !value)}
          onOpenSpec={onOpenSpec ?? (() => {})}
          onSpecDeleted={onSpecDeleted}
          onSpecRenamed={onSpecRenamed}
          onLog={onLog}
        />

        <SidebarSection
          title="Conexões"
          collapsed={connectionsCollapsed}
          onToggleCollapsed={() => setConnectionsCollapsed((value) => !value)}
          grow={false}
          actions={
            <button type="button" onClick={newConnection} title="Nova conexão">
              +
            </button>
          }
        >
          <ul className="connections-list">
            {connections.map((connection) => (
              <li key={connection.id} className={connection.id === activeId ? "active" : ""}>
                <span
                  className="connection-name"
                  onClick={() => connect(connection)}
                  title="Conectar e ver arquivos"
                >
                  🖥️ {connection.name || `${connection.host}:${connection.port}`}
                </span>
                <button
                  type="button"
                  onClick={() => testConnection(connection.id)}
                  title="Testar conexão"
                >
                  ●
                </button>
                <button type="button" onClick={() => editConnection(connection)} title="Editar">
                  ✎
                </button>
                <button
                  type="button"
                  onClick={() => requestDeleteConnection(connection)}
                  title="Remover"
                >
                  ✕
                </button>
              </li>
            ))}
            {connections.length === 0 && (
              <li className="connections-empty">Nenhuma conexão ainda.</li>
            )}
          </ul>
        </SidebarSection>

        {formOpen && (
          <div className="modal-overlay" onClick={() => setFormOpen(false)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <h4>{form.id ? "Editar conexão" : "Nova conexão"}</h4>
              <label>
                Nome
                <input
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </label>
              <label>
                Host
                <input
                  value={form.host}
                  onChange={(event) => setForm({ ...form, host: event.target.value })}
                />
              </label>
              <label>
                Porta
                <input
                  type="number"
                  value={form.port}
                  onChange={(event) => setForm({ ...form, port: Number(event.target.value) })}
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={form.https}
                  onChange={(event) => setForm({ ...form, https: event.target.checked })}
                />
                HTTPS
              </label>
              <label>
                Namespace padrão
                <input
                  value={form.namespace}
                  onChange={(event) => setForm({ ...form, namespace: event.target.value })}
                />
              </label>
              <label>
                Usuário
                <input
                  value={form.username}
                  onChange={(event) => setForm({ ...form, username: event.target.value })}
                />
              </label>
              <label>
                Senha
                <input
                  type="password"
                  value={form.password}
                  placeholder={form.id ? "(mantém a senha salva se em branco)" : ""}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                />
              </label>
              <div className="modal-actions">
                <button type="button" onClick={saveConnection}>
                  Salvar
                </button>
                <button type="button" onClick={() => setFormOpen(false)}>
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {contextMenu && (
          <ul className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            {contextMenu.node === null && (
              <li onClick={() => openNewClassDialog()}>🧩 Nova Classe…</li>
            )}
            {contextMenu.node === null && (
              <li onClick={() => openNewFileDialog()}>📄 Novo Arquivo…</li>
            )}
            {contextMenu.node === null && onOpenAgent && (
              <li
                onClick={() => {
                  setContextMenu(null);
                  if (activeId && activeNamespace) onOpenAgent(activeId, activeNamespace);
                }}
              >
                🤖 Abrir agente (opencode)…
              </li>
            )}
            {contextMenu.selectedNodes.length > 1 && (
              <li onClick={() => void exportNodesAsXml(contextMenu.selectedNodes)}>
                📤 Exportar {contextMenu.selectedNodes.length} itens como XML…
              </li>
            )}
            {contextMenu.selectedNodes.length <= 1 &&
              contextMenu.node?.type === "folder" &&
              (() => {
                const folder = contextMenu.node as TreeFolder;
                return (
                  <>
                    <>
                      <li onClick={() => openNewClassDialog(`${folder.path}.`)}>
                        🧩 Nova Classe aqui…
                      </li>
                      <li onClick={() => openNewFileDialog(`${folder.path.replace(/\./g, "/")}/`)}>
                        📄 Novo Arquivo aqui…
                      </li>
                      <li onClick={() => requestRename(folder)}>✎ Renomear…</li>
                      <li onClick={() => void exportNodesAsXml([folder])}>
                        📤 Exportar pasta como XML…
                      </li>
                    </>
                  </>
                );
              })()}
            {contextMenu.selectedNodes.length <= 1 &&
              contextMenu.node?.type === "file" &&
              (() => {
                const file = contextMenu.node as TreeFile;
                return (
                  <>
                    <li onClick={() => requestRename(file)}>✎ Renomear…</li>
                    {file.docName.toLowerCase().endsWith(".cls") && (
                      <li onClick={() => void exportNodesAsXml([file])}>📤 Exportar como XML…</li>
                    )}
                    {file.docName.toLowerCase().endsWith(".cls") && onOpenApiTester && (
                      <li
                        onClick={() => {
                          setContextMenu(null);
                          if (activeId && activeNamespace)
                            onOpenApiTester(activeId, activeNamespace, file.docName);
                        }}
                      >
                        🔌 Testar Rotas da API…
                      </li>
                    )}
                    <li onClick={() => requestDelete(file)}>🗑️ Excluir</li>
                  </>
                );
              })()}
          </ul>
        )}

        {newClassDialogOpen && (
          <div className="modal-overlay" onClick={() => setNewClassDialogOpen(false)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <h4>Nova Classe</h4>
              <input
                autoFocus
                value={newClassName}
                onChange={(event) => setNewClassName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && submitNewClass()}
                placeholder="Pacote.NomeDaClasse"
              />
              <div className="modal-actions">
                <button type="button" onClick={submitNewClass}>
                  Criar
                </button>
                <button type="button" onClick={() => setNewClassDialogOpen(false)}>
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {newFileDialogOpen && (
          <div className="modal-overlay" onClick={() => setNewFileDialogOpen(false)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <h4>Novo Arquivo</h4>
              <input
                autoFocus
                value={newFileName}
                onChange={(event) => setNewFileName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && submitNewFile()}
                placeholder="specs/plano.md"
              />
              <div className="modal-actions">
                <button type="button" onClick={submitNewFile}>
                  Criar
                </button>
                <button type="button" onClick={() => setNewFileDialogOpen(false)}>
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}

        {connectingTo && (
          <div className="connecting-overlay">
            <div className="connecting-spinner" />
            <div className="connecting-message">Conectando ao servidor {connectingTo}…</div>
          </div>
        )}

        {confirmRequest && (
          <div className="modal-overlay" onClick={() => setConfirmRequest(null)}>
            <div className="modal" onClick={(event) => event.stopPropagation()}>
              <h4>Confirmar</h4>
              <p>{confirmRequest.message}</p>
              <div className="modal-actions">
                <button type="button" onClick={confirmRequest.onConfirm}>
                  {confirmRequest.confirmLabel ?? "Confirmar"}
                </button>
                <button type="button" onClick={() => setConfirmRequest(null)}>
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  },
);

export default ConnectionsPanel;
