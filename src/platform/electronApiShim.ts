// Recria a superfície de `window.electronAPI` (antes exposta pelo preload do Electron via
// contextBridge/ipcRenderer) sobre as APIs do Tauri, para que todo o resto de `src/` (App.tsx e os
// componentes) continue funcionando sem alteração — eles só conhecem essa interface, nunca o
// transporte por trás dela. Ver o plano de migração para o mapeamento completo IPC -> comando Rust.
//
// Import isto uma única vez, por efeito colateral, antes do primeiro render (ver main.tsx).
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type {
  AgentDone,
  AgentEvent,
  AgentPendingWrite,
  AgentSession,
  AiSaveConfigArgs,
  AiSettingsView,
  AtelierDocNameEntry,
  AtelierDocument,
  AtelierQueryResult,
  AtelierSearchFileResult,
  AtelierServerInfo,
  ConnectionProfile,
  DocumentReadOnlyStatus,
  RestCallResult,
  SpecFileEntry,
  StudioMenu,
  StudioUserAction,
  UpdaterStatus,
  WriteResolution,
} from "./types";

/** `invoke()` rejeita com o valor bruto que o comando Rust devolveu em `Err(...)` — uma STRING, não
 * um `Error` — enquanto todo o resto de `src/` (herdado do preload do Electron, onde lançar um
 * `Error` no processo principal chega como `Error` de verdade no `ipcRenderer.invoke()`) assume
 * `error.message`. Sem isso, todo catch vira "Erro: undefined". */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(typeof error === "string" ? error : JSON.stringify(error));
  }
}

/** Assina um evento Tauri e devolve uma função de cancelamento SÍNCRONA — a mesma forma que o
 * preload do Electron expunha (`ipcRenderer.on` + `removeListener`), já que `listen()` do Tauri é
 * assíncrono (retorna `Promise<UnlistenFn>`) mas os componentes chamam `off()` de forma síncrona
 * (normalmente no cleanup de um `useEffect`). */
function bridgeEvent<T>(eventName: string, callback: (payload: T) => void): () => void {
  let unlisten: (() => void) | undefined;
  let disposed = false;
  void listen<T>(eventName, (event) => callback(event.payload)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

const appWindow = getCurrentWindow();

/** Holds the `Update` handle from the last successful `check()` so `install()` (called later, from a
 * separate button click) knows what to download — mirrors electron-updater keeping that state on the
 * main-process singleton instead of round-tripping it through the renderer. */
let pendingUpdate: Update | null = null;
const updateStatusListeners = new Set<(status: UpdaterStatus) => void>();

function emitUpdateStatus(status: UpdaterStatus): void {
  updateStatusListeners.forEach((listener) => listener(status));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Espelha `forceCloseWindows` de electron/ipc.ts: distingue a primeira tentativa de fechar (deve
// avisar sobre abas não salvas) de um fechamento já confirmado pelo usuário. Diferente do Electron,
// aqui a interceptação inteira acontece no próprio WebView — `onCloseRequested` do Tauri já permite
// `preventDefault()` direto em JS, sem precisar de um comando Rust dedicado.
let forceClose = false;

contextBridgeShim();

function contextBridgeShim(): void {
  window.electronAPI = {
    getVersions: () => ({ chrome: "n/a", node: "n/a", electron: "n/a" }),
    onMainMessage: (callback) => {
      void listen<string>("main-message", (event) => callback(event.payload));
    },
    app: {
      getVersion: () => getVersion(),
    },
    windowControls: {
      minimize: () => appWindow.minimize(),
      toggleMaximize: async () => {
        if (await appWindow.isMaximized()) await appWindow.unmaximize();
        else await appWindow.maximize();
      },
      close: () => appWindow.close(),
      onCloseRequested: (callback) => {
        void appWindow.onCloseRequested((event) => {
          if (forceClose) return;
          event.preventDefault();
          callback();
        });
      },
      confirmClose: async () => {
        forceClose = true;
        await appWindow.close();
      },
    },
    // Checa releases publicados no GitHub (ver .github/workflows/release.yml e
    // tauri.conf.json's plugins.updater.endpoints) — equivalente ao `autoUpdater` do
    // electron-updater com o provider "github", só que via tauri-plugin-updater.
    updater: {
      // Mirrors the old electron-updater flow: checking an available update downloads it right
      // away, silently, in the background — the caller (App.tsx) only needs to prompt the user
      // once `onStatus` reports "downloaded". `install()` is the one step that stays manual.
      check: async () => {
        emitUpdateStatus({ state: "checking" });
        try {
          const update = await checkForUpdate();
          if (!update) {
            pendingUpdate = null;
            emitUpdateStatus({ state: "not-available" });
            return;
          }
          pendingUpdate = update;
          emitUpdateStatus({ state: "available", version: update.version });
          let totalBytes = 0;
          let downloadedBytes = 0;
          await update.download((event) => {
            if (event.event === "Started") {
              totalBytes = event.data.contentLength ?? 0;
              downloadedBytes = 0;
              emitUpdateStatus({ state: "downloading", percent: 0 });
            } else if (event.event === "Progress") {
              downloadedBytes += event.data.chunkLength;
              const percent = totalBytes > 0 ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)) : 0;
              emitUpdateStatus({ state: "downloading", percent });
            } else if (event.event === "Finished") {
              emitUpdateStatus({ state: "downloaded", version: update.version });
            }
          });
        } catch (error) {
          emitUpdateStatus({ state: "error", message: errorMessage(error) });
        }
      },
      install: async () => {
        const update = pendingUpdate;
        if (!update) return;
        try {
          // Already downloaded by check() above — this just runs the installer.
          await update.install();
          // No-op on Windows (install() already exits the app to run the installer) — required on
          // macOS/Linux, where the new version only takes over on the next launch.
          await relaunch();
        } catch (error) {
          emitUpdateStatus({ state: "error", message: errorMessage(error) });
        }
      },
      onStatus: (callback) => {
        updateStatusListeners.add(callback);
        return () => updateStatusListeners.delete(callback);
      },
    },
    connections: {
      list: () => call<ConnectionProfile[]>("connections_list"),
      save: (profile, password) => call<ConnectionProfile>("connections_save", { profile, password }),
      delete: (id) => call<void>("connections_delete", { id }),
    },
    atelier: {
      test: (id) => call<AtelierServerInfo>("atelier_test", { id }),
      listNamespaces: (id) => call<string[]>("atelier_list_namespaces", { id }),
      listDocuments: (id, namespace, includeSystem) =>
        call<AtelierDocNameEntry[]>("atelier_list_documents", { id, namespace, includeSystem }),
      getDocument: (id, namespace, name) =>
        call<AtelierDocument>("atelier_get_document", { id, namespace, name }),
      getDocumentReadOnlyStatus: (id, namespace, name) =>
        call<DocumentReadOnlyStatus>("atelier_get_document_read_only_status", {
          id,
          namespace,
          name,
        }),
      searchInFiles: (id, namespace, query, documents, includeSystem) =>
        call<AtelierSearchFileResult[]>("atelier_search_in_files", {
          id,
          namespace,
          query,
          documents,
          includeSystem,
        }),
      saveDocument: (id, namespace, name, contentLines) =>
        call<void>("atelier_save_document", { id, namespace, name, contentLines }),
      deleteDocument: (id, namespace, name) =>
        call<void>("atelier_delete_document", { id, namespace, name }),
      compile: (id, namespace, docs) => call<string[]>("atelier_compile", { id, namespace, docs }),
      query: (id, namespace, sql, parameters) =>
        call<AtelierQueryResult>("atelier_query", { id, namespace, sql, parameters }),
      callRoute: (id, path, method, headers, body) =>
        call<RestCallResult>("atelier_call_route", { id, path, method, headers, body }),
      isStudioExtensionEnabled: (id, namespace) =>
        call<boolean>("atelier_is_studio_extension_enabled", { id, namespace }),
      getStudioMenus: (id, namespace, menuType, docName, selectedText) =>
        call<StudioMenu[]>("atelier_get_studio_menus", {
          id,
          namespace,
          menuType,
          docName,
          selectedText,
        }),
      invokeStudioUserAction: (id, namespace, type, actionId, docName, selectedText) =>
        call<StudioUserAction | null>("atelier_invoke_studio_user_action", {
          id,
          namespace,
          type,
          actionId,
          docName,
          selectedText,
        }),
      invokeStudioAfterUserAction: (id, namespace, type, actionId, docName, answer, msg) =>
        call<StudioUserAction | null>("atelier_invoke_studio_after_user_action", {
          id,
          namespace,
          type,
          actionId,
          docName,
          answer,
          msg,
        }),
    },
    studio: {
      openCspAction: (url) => call<"1" | "2">("studio_open_csp_action", { url }),
    },
    files: {
      saveText: (suggestedName, content) =>
        call<string | null>("dialog_save_text_file", { suggestedName, content }),
    },
    agent: {
      run: (connectionId, namespace, prompt, specsDir, model, sessionId) =>
        call<string>("agent_run", {
          connectionId,
          namespace,
          prompt,
          specsDir,
          model,
          sessionId,
        }),
      abort: (runId) => call<void>("agent_abort", { runId }),
      forceReset: () => call<void>("agent_force_reset"),
      resolvePendingWrite: (pendingId, approved) =>
        call<WriteResolution | null>("agent_resolve_pending_write", { pendingId, approved }),
      onEvent: (callback) => bridgeEvent<AgentEvent>("agent:event", callback),
      onDone: (callback) => bridgeEvent<AgentDone>("agent:done", callback),
      onSession: (callback) => bridgeEvent<AgentSession>("agent:session", callback),
      onPendingWrite: (callback) => bridgeEvent<AgentPendingWrite>("agent:pendingWrite", callback),
    },
    specs: {
      resolveDir: (connectionId, namespace, customDir) =>
        call<string>("specs_resolve_dir", { connectionId, namespace, customDir }),
      list: (dir) => call<SpecFileEntry[]>("specs_list", { dir }),
      read: (filePath) => call<string>("specs_read", { filePath }),
      write: (filePath, content) => call<void>("specs_write", { filePath, content }),
      create: (dir, name) => call<string>("specs_create", { dir, name }),
      delete: (filePath) => call<void>("specs_delete", { filePath }),
      seedSddTemplate: (dir) => call<void>("specs_seed_sdd_template", { dir }),
      rename: (filePath, newName) => call<string>("specs_rename", { filePath, newName }),
      chooseDirectory: (currentDir) =>
        call<string | null>("specs_choose_directory", { currentDir }),
    },
    ai: {
      getConfig: () => call<AiSettingsView>("ai_get_config"),
      saveConfig: (args: AiSaveConfigArgs) => call<AiSettingsView>("ai_save_config", { args }),
      modelList: (providerId) => call<string[]>("model_list", { providerId }),
    },
  };
}
