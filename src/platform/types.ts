// Tipos que antes viviam em `electron/*.ts` (processo principal) e eram importados pelo front-end
// só pela assinatura (type-only). Como o backend agora é Rust, este arquivo é a única fonte da
// verdade dessas formas para o front-end — devem ficar em sincronia com as structs `#[derive(Serialize)]`
// equivalentes em `src-tauri/src/*.rs` conforme cada uma for implementada.

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  https: boolean;
  pathPrefix?: string;
  username: string;
  namespace: string;
}

export interface AtelierServerInfo {
  version: string;
  id: string;
  api: number;
  namespaces: string[];
}

export interface AtelierDocNameEntry {
  name: string;
  cat: string;
  date?: string;
}

export interface AtelierDocument {
  name: string;
  ts: string;
  cat: string;
  enc: boolean;
  content: string[];
}

export interface DocumentReadOnlyStatus {
  readOnly: boolean;
  reason?: string;
}

export interface RestCallResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

export interface AtelierQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface AtelierSearchMatch {
  line: number;
  text: string;
}

export interface AtelierSearchFileResult {
  doc: string;
  matches: AtelierSearchMatch[];
}

export interface StudioMenuItem {
  id: string;
  name: string;
  enabled: number;
  save?: number;
  separator?: number;
}

export interface StudioMenu {
  id: string;
  name: string;
  items: StudioMenuItem[];
}

export interface StudioUserAction {
  action: number;
  target: string;
  message: string;
  reload: boolean;
  doc: unknown;
  errorText: string;
}

export interface AgentEvent {
  runId: string;
  line: string;
  stderr?: boolean;
}

export interface AgentDone {
  runId: string;
  code: number;
}

export interface AgentPendingWrite {
  pendingId: string;
  runId: string;
  name: string;
  patch: string;
}

export interface AgentSession {
  runId: string;
  sessionId: string;
}

/** `approved` é a decisão do humano; `saved` é se a escrita realmente chegou no servidor — mantidos
 * separados para que uma falha de rede/compilação após a aprovação não seja reportada ao agente como
 * uma rejeição do usuário. */
export interface WriteResolution {
  approved: boolean;
  saved: boolean;
  compileOutput?: string[];
  error?: string;
  message?: string;
}

export interface SpecFileEntry {
  name: string;
  path: string;
  modifiedAt: number;
}

export type UpdaterStatus =
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "not-available" }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

export interface AiSettingsView {
  providerId: string;
  model: string;
  savedKeyProviders: string[];
}

export interface AiSaveConfigArgs {
  providerId: string;
  model: string;
  keys?: Record<string, string>;
}

/** Mesma forma exposta pelo antigo `electron/preload.ts` via `contextBridge.exposeInMainWorld`,
 * agora implementada em `./electronApiShim.ts` sobre `@tauri-apps/api`. */
export interface ElectronAPI {
  getVersions: () => { chrome: string; node: string; electron: string };
  onMainMessage: (callback: (message: string) => void) => void;
  windowControls: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    onCloseRequested: (callback: () => void) => void;
    confirmClose: () => Promise<void>;
  };
  updater: {
    check: () => Promise<void>;
    install: () => Promise<void>;
    onStatus: (callback: (status: UpdaterStatus) => void) => () => void;
  };
  connections: {
    list: () => Promise<ConnectionProfile[]>;
    save: (
      profile: Omit<ConnectionProfile, "id"> & { id?: string },
      password?: string,
    ) => Promise<ConnectionProfile>;
    delete: (id: string) => Promise<void>;
  };
  atelier: {
    test: (id: string) => Promise<AtelierServerInfo>;
    listNamespaces: (id: string) => Promise<string[]>;
    listDocuments: (
      id: string,
      namespace: string,
      includeSystem?: boolean,
    ) => Promise<AtelierDocNameEntry[]>;
    getDocument: (id: string, namespace: string, name: string) => Promise<AtelierDocument>;
    getDocumentReadOnlyStatus: (
      id: string,
      namespace: string,
      name: string,
    ) => Promise<DocumentReadOnlyStatus>;
    searchInFiles: (
      id: string,
      namespace: string,
      query: string,
      documents: string,
      includeSystem?: boolean,
    ) => Promise<AtelierSearchFileResult[]>;
    saveDocument: (
      id: string,
      namespace: string,
      name: string,
      contentLines: string[],
    ) => Promise<void>;
    deleteDocument: (id: string, namespace: string, name: string) => Promise<void>;
    compile: (id: string, namespace: string, docs: string[]) => Promise<string[]>;
    query: (
      id: string,
      namespace: string,
      sql: string,
      parameters: unknown[],
    ) => Promise<AtelierQueryResult>;
    callRoute: (
      id: string,
      path: string,
      method: string,
      headers: Record<string, string>,
      body?: string,
    ) => Promise<RestCallResult>;
    isStudioExtensionEnabled: (id: string, namespace: string) => Promise<boolean>;
    getStudioMenus: (
      id: string,
      namespace: string,
      menuType: "main" | "context",
      docName: string,
      selectedText?: string,
    ) => Promise<StudioMenu[]>;
    invokeStudioUserAction: (
      id: string,
      namespace: string,
      type: number,
      actionId: string,
      docName: string,
      selectedText?: string,
    ) => Promise<StudioUserAction | null>;
    invokeStudioAfterUserAction: (
      id: string,
      namespace: string,
      type: number,
      actionId: string,
      docName: string,
      answer: string,
      msg: string,
    ) => Promise<StudioUserAction | null>;
  };
  studio: {
    openCspAction: (url: string) => Promise<"1" | "2">;
  };
  files: {
    saveText: (suggestedName: string, content: string) => Promise<string | null>;
  };
  agent: {
    run: (
      connectionId: string,
      namespace: string,
      prompt: string,
      specsDir: string,
      model?: string,
      sessionId?: string,
    ) => Promise<string>;
    abort: (runId: string) => Promise<void>;
    /** Clears the "one agent at a time" lock regardless of which run holds it — for when the
     * frontend has lost track of the current runId (a reload, a crash) and so has no id left to
     * pass to `abort`. */
    forceReset: () => Promise<void>;
    resolvePendingWrite: (
      pendingId: string,
      approved: boolean,
    ) => Promise<WriteResolution | null>;
    onEvent: (callback: (payload: AgentEvent) => void) => () => void;
    onDone: (callback: (payload: AgentDone) => void) => () => void;
    onSession: (callback: (payload: AgentSession) => void) => () => void;
    onPendingWrite: (callback: (payload: AgentPendingWrite) => void) => () => void;
  };
  specs: {
    resolveDir: (
      connectionId: string,
      namespace: string,
      customDir: string | null,
    ) => Promise<string>;
    list: (dir: string) => Promise<SpecFileEntry[]>;
    read: (filePath: string) => Promise<string>;
    write: (filePath: string, content: string) => Promise<void>;
    create: (dir: string, name: string) => Promise<string>;
    delete: (filePath: string) => Promise<void>;
    seedSddTemplate: (dir: string) => Promise<void>;
    rename: (filePath: string, newName: string) => Promise<string>;
    chooseDirectory: (currentDir?: string) => Promise<string | null>;
  };
  ai: {
    getConfig: () => Promise<AiSettingsView>;
    saveConfig: (args: AiSaveConfigArgs) => Promise<AiSettingsView>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
