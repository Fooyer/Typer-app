import { useEffect, useState } from "react";
import type { SpecFileEntry } from "../platform/types";
import { loadSpecsDirOverride, saveSpecsDirOverride } from "../utils/specsPreference";
import SidebarSection from "./SidebarSection";
import type { LogLevel } from "./OutputPanel";

interface SpecsPanelProps {
  connectionId: string | null;
  namespace: string | null;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenSpec: (path: string, name: string, content: string) => void;
  onSpecDeleted?: (specPath: string) => void;
  onSpecRenamed?: (oldPath: string, newPath: string, newName: string) => void;
  onLog: (message: string, level?: LogLevel) => void;
}

type DialogState = { mode: "create" | "rename"; target?: SpecFileEntry; value: string } | null;

function SpecsPanel({
  connectionId,
  namespace,
  collapsed,
  onToggleCollapsed,
  onOpenSpec,
  onSpecDeleted,
  onSpecRenamed,
  onLog,
}: SpecsPanelProps) {
  const [dir, setDir] = useState<string | null>(null);
  const [customDir, setCustomDir] = useState<string | null>(null);
  const [files, setFiles] = useState<SpecFileEntry[]>([]);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: SpecFileEntry;
  } | null>(null);
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number } | null>(null);

  const hasElectronAPI = typeof window.electronAPI !== "undefined";

  async function loadFiles(connId: string, ns: string, dirOverride: string | null) {
    try {
      const resolved = await window.electronAPI.specs.resolveDir(connId, ns, dirOverride);
      setDir(resolved);
      setFiles(await window.electronAPI.specs.list(resolved));
    } catch (error) {
      onLog(`Erro ao carregar specs: ${(error as Error).message}`, "error");
    }
  }

  useEffect(() => {
    if (!hasElectronAPI || !connectionId || !namespace) {
      setDir(null);
      setFiles([]);
      setCustomDir(null);
      return;
    }
    const override = loadSpecsDirOverride(connectionId, namespace);
    setCustomDir(override);
    void loadFiles(connectionId, namespace, override);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasElectronAPI, connectionId, namespace]);

  useEffect(() => {
    if (!contextMenu && !folderMenu) return;
    const close = () => {
      setContextMenu(null);
      setFolderMenu(null);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu, folderMenu]);

  async function chooseDirectory() {
    if (!connectionId || !namespace) return;
    const chosen = await window.electronAPI.specs.chooseDirectory(dir ?? undefined);
    if (!chosen) return;
    setCustomDir(chosen);
    saveSpecsDirOverride(connectionId, namespace, chosen);
    await loadFiles(connectionId, namespace, chosen);
  }

  async function useDefaultDirectory() {
    if (!connectionId || !namespace) return;
    setCustomDir(null);
    saveSpecsDirOverride(connectionId, namespace, null);
    await loadFiles(connectionId, namespace, null);
  }

  async function openFile(file: SpecFileEntry) {
    try {
      const content = await window.electronAPI.specs.read(file.path);
      onOpenSpec(file.path, file.name, content);
    } catch (error) {
      onLog(`Erro ao abrir ${file.name}: ${(error as Error).message}`, "error");
    }
  }

  async function deleteFile(file: SpecFileEntry) {
    setContextMenu(null);
    if (!window.confirm(`Excluir "${file.name}"? Esta ação não pode ser desfeita.`)) return;
    if (!connectionId || !namespace) return;
    try {
      await window.electronAPI.specs.delete(file.path);
      onLog(`${file.name} excluído.`, "success");
      onSpecDeleted?.(file.path);
      await loadFiles(connectionId, namespace, customDir);
    } catch (error) {
      onLog(`Erro ao excluir ${file.name}: ${(error as Error).message}`, "error");
    }
  }

  function openCreateDialog() {
    setDialog({ mode: "create", value: "" });
  }

  async function applySddTemplate() {
    setFolderMenu(null);
    if (!dir || !connectionId || !namespace) return;
    try {
      await window.electronAPI.specs.seedSddTemplate(dir);
      onLog("Template SDD criado em Specs.", "success");
      await loadFiles(connectionId, namespace, customDir);
    } catch (error) {
      onLog(`Erro ao criar template SDD: ${(error as Error).message}`, "error");
    }
  }

  function openRenameDialog(file: SpecFileEntry) {
    setContextMenu(null);
    setDialog({ mode: "rename", target: file, value: file.name.replace(/\.md$/i, "") });
  }

  async function submitDialog() {
    if (!dialog || !dir || !connectionId || !namespace || !dialog.value.trim()) return;
    const value = dialog.value.trim();
    setDialog(null);
    try {
      if (dialog.mode === "create") {
        const filePath = await window.electronAPI.specs.create(dir, value);
        onLog(`${value} criado.`, "success");
        await loadFiles(connectionId, namespace, customDir);
        onOpenSpec(filePath, filePath.split(/[/\\]/).pop() ?? value, "");
      } else if (dialog.target) {
        const newPath = await window.electronAPI.specs.rename(dialog.target.path, value);
        const newName = newPath.split(/[/\\]/).pop() ?? value;
        onLog(`${dialog.target.name} renomeado para ${newName}.`, "success");
        onSpecRenamed?.(dialog.target.path, newPath, newName);
        await loadFiles(connectionId, namespace, customDir);
      }
    } catch (error) {
      onLog(`Erro: ${(error as Error).message}`, "error");
    }
  }

  if (!hasElectronAPI) return null;

  return (
    <SidebarSection
      title="Specs"
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      grow={false}
      actions={
        connectionId && namespace ? (
          <>
            <button
              type="button"
              onClick={() => void chooseDirectory()}
              title={dir ?? "Escolher pasta"}
            >
              📁
            </button>
            {customDir && (
              <button
                type="button"
                onClick={() => void useDefaultDirectory()}
                title="Usar pasta padrão"
              >
                ↺
              </button>
            )}
            <button type="button" onClick={openCreateDialog} title="Novo arquivo de spec">
              📄+
            </button>
          </>
        ) : undefined
      }
    >
      {!connectionId || !namespace ? (
        <p className="connection-status">Conecte-se a um servidor para usar Specs.</p>
      ) : (
        <div className="specs-panel-body">
          <div
            className="specs-file-list"
            onContextMenu={(event) => {
              event.preventDefault();
              setFolderMenu({ x: event.clientX, y: event.clientY });
            }}
          >
            {files.length === 0 ? (
              <p className="connection-status">Nenhum arquivo .md ainda.</p>
            ) : (
              files.map((file) => (
                <div
                  key={file.path}
                  className="specs-file-row"
                  onClick={() => void openFile(file)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setContextMenu({ x: event.clientX, y: event.clientY, file });
                  }}
                >
                  <span className="specs-file-icon">📝</span>
                  {file.name}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {contextMenu && (
        <ul className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <li onClick={() => openRenameDialog(contextMenu.file)}>✎ Renomear…</li>
          <li onClick={() => void deleteFile(contextMenu.file)}>🗑️ Excluir</li>
        </ul>
      )}

      {folderMenu && (
        <ul className="context-menu" style={{ left: folderMenu.x, top: folderMenu.y }}>
          <li onClick={() => void applySddTemplate()}>📋 Criar template SDD</li>
        </ul>
      )}

      {dialog && (
        <div className="modal-overlay" onClick={() => setDialog(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h4>{dialog.mode === "create" ? "Novo Arquivo de Spec" : "Renomear"}</h4>
            <input
              autoFocus
              value={dialog.value}
              onChange={(event) => setDialog({ ...dialog, value: event.target.value })}
              onKeyDown={(event) => event.key === "Enter" && void submitDialog()}
              placeholder="plano.md"
            />
            <div className="modal-actions">
              <button type="button" onClick={() => void submitDialog()}>
                {dialog.mode === "create" ? "Criar" : "Renomear"}
              </button>
              <button type="button" onClick={() => setDialog(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </SidebarSection>
  );
}

export default SpecsPanel;
