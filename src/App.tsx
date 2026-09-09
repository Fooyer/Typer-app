import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import AgentPanel from "./components/AgentPanel";
import AppLogo from "./components/AppLogo";
import ApiTester from "./components/ApiTester";
import CodeEditor, { type CodeEditorHandle } from "./components/CodeEditor";
import ConnectionsPanel, { type ConnectionsPanelHandle } from "./components/ConnectionsPanel";
import MenuBar, { type MenuDef } from "./components/MenuBar";
import OutputPanel, { type LogLevel, type LogLine, type OutputTab } from "./components/OutputPanel";
import QuickOpenClassModal from "./components/QuickOpenClassModal";
import type { SearchMatch } from "./components/SearchPanel";
import SettingsModal from "./components/SettingsModal";
import SqlRunner from "./components/SqlRunner";
import StudioDialogModal, { type StudioDialogRequest } from "./components/StudioDialogModal";
import { applyAppChrome } from "./themes/appearance";
import {
  BUILTIN_THEMES,
  getAllThemes,
  getTheme,
  registerCustomTheme,
  type AppTheme,
} from "./themes/registry";
import type { VSCodeTheme } from "./themes/convert";
import { loadAccentOverride, saveAccentOverride } from "./utils/accentPreference";
import { parseCompileDiagnostics, type Diagnostic } from "./utils/diagnostics";
import { isNoiseDocument } from "./utils/documentFilters";
import { matchesAnyGlob } from "./utils/glob";
import { mapWithConcurrency } from "./utils/concurrency";
import { classSourceToExportXml } from "./utils/classXmlExport";
import { downloadTextFile } from "./utils/download";
import { loadThemePreference, saveThemePreference } from "./utils/themePreference";
import { setClassReferenceOpener } from "./monaco/classReferenceNavigation";
import { getKnownClasses } from "./monaco/classIndex";
import { setClassMemberProvider, type ClassMember } from "./monaco/classMembers";
import { setTypeParameterProvider } from "./monaco/typeParameters";
import type { StudioMenu, StudioUserAction, UpdaterStatus } from "./platform/types";

// Read once at module load (before App() ever mounts) so a persisted custom theme is registered
// into themes/registry.ts's in-memory theme list before the component's first render asks for it.
const storedThemePreference = loadThemePreference();
if (
  storedThemePreference?.custom &&
  storedThemePreference.custom.id === storedThemePreference.themeId
) {
  registerCustomTheme(
    monaco,
    storedThemePreference.custom.id,
    storedThemePreference.custom.label,
    storedThemePreference.custom.kind,
    storedThemePreference.custom.vscodeTheme,
  );
}

/** Height the output panel eases down to when collapsed — its header row (tabs + actions) plus a
 * little breathing room below, so the buttons' own bottom padding/border reads as a margin instead
 * of sitting flush against the window edge. A few px taller than `.output-panel-header`'s own
 * rendered height in style.css (padding + the row of small buttons + border-bottom). */
const OUTPUT_COLLAPSED_HEIGHT = 48;

const SAMPLE = `Class Demo.Hello Extends %RegisteredObject
{

/// Says hello to the given name.
ClassMethod Greet(name As %String) As %String
{
    Set greeting = "Hello, "_name_"!"
    Write greeting, !
    Quit greeting
}

}
`;

interface Tab {
  id: string;
  kind: "code" | "sql" | "api" | "agent" | "spec";
  title: string;
  content: string;
  savedContent: string;
  connectionId?: string;
  namespace?: string;
  docName?: string;
  /** Absolute path on local disk — only set for kind "spec" (see SpecsPanel.tsx/electron/specs.ts).
   * Specs are plain local files, not IRIS server documents, so they carry a filesystem path
   * instead of connectionId/namespace/docName driving a save. */
  specPath?: string;
  /** Server says this document can't be edited (deployed class, or source control checkout status)
   * — see applyReadOnlyStatus. Undefined until that async check resolves; treated as editable
   * until then, same as any tab not backed by a server document. */
  readOnly?: boolean;
  readOnlyReason?: string;
}

function isDirty(tab: Tab): boolean {
  return tab.content !== tab.savedContent;
}

function guessThemeKind(theme: VSCodeTheme): "dark" | "light" {
  const hex = theme.colors["editor.background"]?.replace("#", "").slice(0, 6);
  if (!hex || hex.length < 6) return "dark";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 > 128 ? "light" : "dark";
}

const hasElectronAPI = typeof window.electronAPI !== "undefined";

function App() {
  const [tabs, setTabs] = useState<Tab[]>([
    { id: "tab-0", kind: "code", title: "sample.cls", content: SAMPLE, savedContent: SAMPLE },
  ]);
  const [activeTabId, setActiveTabId] = useState<string | null>("tab-0");
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null);
  const [pendingWindowClose, setPendingWindowClose] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdaterStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<Record<string, Diagnostic[]>>({});
  const [panelOpen, setPanelOpen] = useState(true);
  const [outputOpen, setOutputOpen] = useState(true);
  const [outputResizing, setOutputResizing] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [outputHeight, setOutputHeight] = useState(200);
  const [logLines, setLogLines] = useState<LogLine[]>([]);
  const [themes, setThemes] = useState<AppTheme[]>(() => getAllThemes());
  const [themeId, setThemeId] = useState(() =>
    storedThemePreference && getTheme(storedThemePreference.themeId)
      ? storedThemePreference.themeId
      : themes[0].id,
  );
  const [accentOverride, setAccentOverride] = useState<string | null>(() => loadAccentOverride());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [studioMenus, setStudioMenus] = useState<StudioMenu[]>([]);
  const [studioDialog, setStudioDialog] = useState<StudioDialogRequest | null>(null);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [outputTab, setOutputTab] = useState<OutputTab>("log");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMask, setSearchMask] = useState("");
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchRunning, setSearchRunning] = useState(false);
  const [searchStatus, setSearchStatus] = useState("");
  const [searchResults, setSearchResults] = useState<SearchMatch[]>([]);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const searchScopeRef = useRef<{ connectionId: string; namespace: string } | null>(null);
  const searchTokenRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const codeEditorRef = useRef<CodeEditorHandle>(null);
  const connectionsPanelRef = useRef<ConnectionsPanelHandle>(null);
  const nextLogId = useRef(1);
  const nextTabId = useRef(1);
  // Read by the window-close listener below, which is registered once on mount — a ref keeps it
  // seeing the current tabs instead of whatever `tabs` was when the listener was first attached.
  const tabsRef = useRef<Tab[]>(tabs);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  tabsRef.current = tabs;

  function appendLog(message: string, level: LogLevel = "info") {
    const time = new Date().toLocaleTimeString();
    setLogLines((lines) => [...lines, { id: nextLogId.current++, time, level, message }]);
  }

  function selectTheme(id: string) {
    setThemeId(id);
    const theme = getTheme(id);
    if (!theme) return;
    applyAppChrome(theme, accentOverride);
    const isBuiltin = BUILTIN_THEMES.some((builtin) => builtin.id === theme.id);
    saveThemePreference({
      themeId: theme.id,
      custom: isBuiltin
        ? undefined
        : { id: theme.id, label: theme.label, kind: theme.kind, vscodeTheme: theme.vscodeTheme },
    });
  }

  // Overrides (or, passing null, clears the override on) the titlebar/logo accent — see
  // themes/appearance.ts's applyAppChrome and SettingsModal's "Cor de destaque" section.
  function selectAccent(color: string | null) {
    setAccentOverride(color);
    saveAccentOverride(color);
    const theme = getTheme(themeId);
    if (theme) applyAppChrome(theme, color);
  }

  // Applies the restored (or default) theme's chrome colors before the first paint, so the app never
  // flashes the CSS file's hardcoded default colors before correcting itself to the saved theme.
  useLayoutEffect(() => {
    const theme = getTheme(themeId);
    if (theme) applyAppChrome(theme, accentOverride);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Consistent with the rest of the app's own modal styling — a native `alert()` would use the
  // OS/browser's dialog chrome, breaking out of the app's theme.
  function showAlert(message: string): Promise<void> {
    return new Promise((resolve) => {
      setStudioDialog({
        kind: "alert",
        message,
        onAnswer: () => {
          setStudioDialog(null);
          resolve();
        },
      });
    });
  }

  // main.ts intercepts the window's close (titlebar button, Alt+F4, OS close alike) and asks here
  // first — see electron/main.ts's "close" listener — so unsaved tabs get the same warning closing
  // a single tab already gets, instead of silently discarding them.
  useEffect(() => {
    if (!hasElectronAPI) return;
    window.electronAPI.windowControls.onCloseRequested(() => {
      const hasUnsaved = tabsRef.current.some(isDirty);
      if (hasUnsaved) setPendingWindowClose(true);
      else void window.electronAPI.windowControls.confirmClose();
    });
  }, []);

  // main.ts's updater.ts checks for updates on startup and every few hours, downloading silently in
  // the background — this just reflects that progress in the titlebar and surfaces the result, so the
  // user only ever has to act once a new version is actually ready (see the update pill below).
  useEffect(() => {
    if (!hasElectronAPI) return;
    return window.electronAPI.updater.onStatus((status) => {
      setUpdateStatus(status);
      if (status.state === "available")
        appendLog(`Nova versão ${status.version} encontrada, baixando…`, "info");
      if (status.state === "downloaded")
        appendLog(`Atualização ${status.version} pronta — reinicie para aplicar.`, "success");
      if (status.state === "error")
        appendLog(`Erro ao verificar atualizações: ${status.message}`, "error");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function importThemeFile(file: File) {
    let parsed: VSCodeTheme;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      await showAlert("Arquivo de tema inválido: JSON malformado.");
      return;
    }
    if (!parsed.colors || !parsed.tokenColors) {
      await showAlert("Arquivo de tema inválido: faltam os campos 'colors' ou 'tokenColors'.");
      return;
    }

    const theme = registerCustomTheme(
      monaco,
      `custom-${Date.now()}`,
      parsed.name ?? file.name.replace(/\.json$/i, ""),
      guessThemeKind(parsed),
      parsed,
    );
    const updated = getAllThemes();
    setThemes(updated);
    selectTheme(theme.id);
  }

  function handleDocumentDeleted(connectionId: string, namespace: string, docName: string) {
    const tab = tabs.find(
      (t) => t.connectionId === connectionId && t.namespace === namespace && t.docName === docName,
    );
    if (tab) removeTab(tab.id);
  }

  function handleDocumentRenamed(
    connectionId: string,
    namespace: string,
    oldName: string,
    newName: string,
  ) {
    setTabs((prev) =>
      prev.map((t) =>
        t.connectionId === connectionId && t.namespace === namespace && t.docName === oldName
          ? { ...t, docName: newName, title: newName }
          : t,
      ),
    );
  }

  function handleSpecDeleted(specPath: string) {
    const tab = tabs.find((t) => t.kind === "spec" && t.specPath === specPath);
    if (tab) removeTab(tab.id);
  }

  function handleSpecRenamed(oldPath: string, newPath: string, newName: string) {
    setTabs((prev) =>
      prev.map((t) =>
        t.kind === "spec" && t.specPath === oldPath
          ? { ...t, specPath: newPath, title: newName }
          : t,
      ),
    );
  }

  // Fired by AgentPanel after the agent's write actually lands on the server (approved AND saved —
  // not just clicked "approve"). Refreshes the explorer so a newly created class shows up without a
  // manual reload, and — if that document happens to be open in a tab — pulls the fresh content in
  // too, the same way saveAndCompile already reloads after a manual save/compile.
  function handleAgentDocumentSaved(connectionId: string, namespace: string, docName: string) {
    connectionsPanelRef.current?.refreshDocuments(connectionId, namespace);
    const tab = tabsRef.current.find(
      (t) => t.connectionId === connectionId && t.namespace === namespace && t.docName === docName,
    );
    if (!tab) return;
    if (isDirty(tab)) {
      appendLog(
        `${docName} foi alterado no servidor pelo agente, mas a aba aberta tem edições não salvas — salve ou descarte para ver a versão mais recente.`,
        "info",
      );
      return;
    }
    window.electronAPI.atelier
      .getDocument(connectionId, namespace, docName)
      .then((doc) => {
        const freshContent = doc.content.join("\n");
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tab.id ? { ...t, content: freshContent, savedContent: freshContent } : t,
          ),
        );
        codeEditorRef.current?.setTabContent(tab.id, freshContent);
      })
      .catch((error) => {
        appendLog(`Não foi possível recarregar ${docName}: ${(error as Error).message}`, "error");
      });
  }

  // Fire-and-forget: the tab is created (and shown as editable) immediately with whatever content
  // was already fetched, and flips to read-only a moment later if the server says so — this is a
  // separate round trip (see getDocumentReadOnlyStatus) from the one that fetched the content, so
  // there's no reason to make opening a document wait on it.
  function applyReadOnlyStatus(
    tabId: string,
    connectionId: string,
    namespace: string,
    docName: string,
  ) {
    if (!hasElectronAPI) return;
    window.electronAPI.atelier
      .getDocumentReadOnlyStatus(connectionId, namespace, docName)
      .then((status) => {
        if (!status.readOnly) return;
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tabId ? { ...t, readOnly: true, readOnlyReason: status.reason } : t,
          ),
        );
      })
      .catch(() => {});
  }

  function handleOpenDocument(
    connectionId: string,
    namespace: string,
    name: string,
    content: string,
  ) {
    const existing = tabs.find(
      (tab) =>
        tab.connectionId === connectionId && tab.namespace === namespace && tab.docName === name,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = `doc-${nextTabId.current++}`;
    setTabs((prev) => [
      ...prev,
      {
        id,
        kind: "code",
        title: name,
        content,
        savedContent: content,
        connectionId,
        namespace,
        docName: name,
      },
    ]);
    setActiveTabId(id);
    appendLog(`${name} aberto (${namespace}).`, "success");
    applyReadOnlyStatus(id, connectionId, namespace, name);
  }

  async function openClassByName(className: string) {
    if (!hasElectronAPI) return;
    const context = activeTab?.connectionId && activeTab.namespace ? activeTab : null;
    if (!context?.connectionId || !context.namespace) {
      appendLog(
        `Não é possível abrir "${className}": a aba atual não está ligada a um servidor.`,
        "error",
      );
      return;
    }
    const { connectionId, namespace } = context;
    const docName = `${className}.cls`;
    const existing = tabs.find(
      (tab) =>
        tab.connectionId === connectionId && tab.namespace === namespace && tab.docName === docName,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    appendLog(`Abrindo definição de ${className}…`);
    try {
      const doc = await window.electronAPI.atelier.getDocument(connectionId, namespace, docName);
      handleOpenDocument(connectionId, namespace, docName, doc.content.join("\n"));
    } catch (error) {
      appendLog(`Não foi possível abrir "${className}": ${(error as Error).message}`, "error");
    }
  }

  async function openServerDocument(connectionId: string, namespace: string, name: string) {
    const existing = tabs.find(
      (tab) =>
        tab.connectionId === connectionId && tab.namespace === namespace && tab.docName === name,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    try {
      const doc = await window.electronAPI.atelier.getDocument(connectionId, namespace, name);
      handleOpenDocument(connectionId, namespace, name, doc.content.join("\n"));
    } catch (error) {
      appendLog(`Não foi possível abrir "${name}": ${(error as Error).message}`, "error");
    }
  }

  async function openSearchResult(docName: string, line: number) {
    const scope = searchScopeRef.current;
    if (!scope) return;
    const { connectionId, namespace } = scope;
    const existing = tabs.find(
      (tab) =>
        tab.connectionId === connectionId && tab.namespace === namespace && tab.docName === docName,
    );
    if (existing) {
      setActiveTabId(existing.id);
      requestAnimationFrame(() => codeEditorRef.current?.revealLine(existing.id, line));
      return;
    }
    try {
      const doc = await window.electronAPI.atelier.getDocument(connectionId, namespace, docName);
      const id = `doc-${nextTabId.current++}`;
      const content = doc.content.join("\n");
      setTabs((prev) => [
        ...prev,
        {
          id,
          kind: "code",
          title: docName,
          content,
          savedContent: content,
          connectionId,
          namespace,
          docName,
        },
      ]);
      setActiveTabId(id);
      requestAnimationFrame(() => codeEditorRef.current?.revealLine(id, line));
      applyReadOnlyStatus(id, connectionId, namespace, docName);
    } catch (error) {
      appendLog(`Não foi possível abrir "${docName}": ${(error as Error).message}`, "error");
    }
  }

  const DEFAULT_SEARCH_MASK = "*.cls,*.int";

  // Tries IRIS's server-side full-text search first (Atelier API v2, IRIS 2023.1+): one request,
  // IRIS greps on its end and returns only matches. Servers older than v2 (or with the route
  // disabled) throw — see searchInFiles's doc comment — and we fall back to the slower path below.
  async function runFindInFilesViaServer(
    connectionId: string,
    namespace: string,
    query: string,
    mask: string,
    token: number,
  ): Promise<SearchMatch[] | null> {
    const documents = mask.trim() || DEFAULT_SEARCH_MASK;
    const results = await window.electronAPI.atelier.searchInFiles(
      connectionId,
      namespace,
      query,
      documents,
    );
    if (searchTokenRef.current !== token) return null;
    const matches: SearchMatch[] = [];
    for (const entry of results) {
      // An explicit mask means the user chose exactly where to search — don't second-guess it by
      // hiding ENS/CSPX noise on top; only apply that default-noise filter when they didn't ask.
      if (!mask.trim() && isNoiseDocument(entry.doc)) continue;
      for (const match of entry.matches) {
        if (searchCaseSensitive && !match.text.includes(query)) continue;
        matches.push({ docName: entry.doc, line: match.line, text: match.text });
      }
    }
    return matches;
  }

  // Mirrors Studio's Ctrl+Shift+F "Find in Files" on servers without the v2 search route:
  // downloads every document in the active connection/namespace and greps their lines client-side.
  // Concurrency is capped (see mapWithConcurrency) because hammering IRIS with one
  // unauthenticated-per-request burst can exhaust its session pool.
  async function runFindInFilesByDownload(
    connectionId: string,
    namespace: string,
    query: string,
    mask: string,
    token: number,
  ): Promise<SearchMatch[] | null> {
    setSearchStatus(`Listando arquivos em ${namespace}…`);
    const docs = await window.electronAPI.atelier.listDocuments(connectionId, namespace);
    if (searchTokenRef.current !== token) return null;
    const targets = docs.filter((doc) =>
      mask.trim() ? matchesAnyGlob(mask, doc.name) : !isNoiseDocument(doc.name),
    );
    setSearchStatus(`Pesquisando "${query}" em ${targets.length} arquivo(s)…`);
    const needle = searchCaseSensitive ? query : query.toLowerCase();
    const matches: SearchMatch[] = [];
    let scanned = 0;
    await mapWithConcurrency(targets, 6, async (doc) => {
      if (searchTokenRef.current !== token) return;
      try {
        const document = await window.electronAPI.atelier.getDocument(
          connectionId,
          namespace,
          doc.name,
        );
        document.content.forEach((lineText, index) => {
          const haystack = searchCaseSensitive ? lineText : lineText.toLowerCase();
          if (haystack.includes(needle))
            matches.push({ docName: doc.name, line: index + 1, text: lineText });
        });
      } catch {
        // skip unreadable docs rather than aborting the whole search
      } finally {
        scanned++;
        if (searchTokenRef.current === token) {
          setSearchStatus(`Pesquisando "${query}"… ${scanned}/${targets.length} arquivo(s)`);
        }
      }
    });
    if (searchTokenRef.current !== token) return null;
    return matches;
  }

  async function runFindInFiles() {
    if (!hasElectronAPI) return;
    const context = activeTab?.connectionId && activeTab.namespace ? activeTab : null;
    if (!context?.connectionId || !context.namespace) {
      setSearchStatus("Abra um arquivo de um servidor para pesquisar em todos os arquivos.");
      return;
    }
    const query = searchQuery.trim();
    if (!query) return;
    const { connectionId, namespace } = context;
    const token = ++searchTokenRef.current;
    searchScopeRef.current = { connectionId, namespace };
    setSearchRunning(true);
    setSearchResults([]);
    setSearchStatus(`Pesquisando "${query}" em ${namespace}…`);
    const mask = searchMask;
    try {
      let matches: SearchMatch[] | null = null;
      try {
        matches = await runFindInFilesViaServer(connectionId, namespace, query, mask, token);
      } catch (serverSearchError) {
        if (searchTokenRef.current !== token) return;
        appendLog(
          `Busca server-side (v2/action/search) indisponível: ${(serverSearchError as Error).message} — usando download por arquivo.`,
          "info",
        );
      }
      if (searchTokenRef.current !== token) return;
      if (!matches) {
        matches = await runFindInFilesByDownload(connectionId, namespace, query, mask, token);
      }
      if (!matches || searchTokenRef.current !== token) return;
      matches.sort((a, b) => a.docName.localeCompare(b.docName) || a.line - b.line);
      setSearchResults(matches);
      const fileCount = new Set(matches.map((m) => m.docName)).size;
      setSearchStatus(
        matches.length
          ? `${matches.length} ocorrência(s) em ${fileCount} arquivo(s).`
          : "Nenhuma ocorrência encontrada.",
      );
    } catch (error) {
      if (searchTokenRef.current === token)
        setSearchStatus(`Erro na pesquisa: ${(error as Error).message}`);
    } finally {
      if (searchTokenRef.current === token) setSearchRunning(false);
    }
  }

  // Bumping the token makes every pending checkpoint in runFindInFilesViaServer/ByDownload bail out
  // on its next await instead of applying stale results — see the `searchTokenRef.current !== token`
  // guards throughout both. Requests already in flight (up to 6, for the download path) still finish
  // over the wire, but nothing further is dispatched and nothing they return gets shown.
  function cancelSearch() {
    searchTokenRef.current++;
    setSearchRunning(false);
    setSearchStatus("Pesquisa cancelada.");
  }

  function openFindInFiles() {
    setOutputOpen(true);
    setOutputTab("search");
    setSearchFocusToken((token) => token + 1);
  }

  // Handles the response of a server custom-menu action (0-7), mirroring vscode-objectscript's
  // processUserAction switch. Only codes 1/2/6/7 produce a user answer that must be reported back
  // to the server via invokeStudioAfterUserAction; the server may then chain another action.
  async function processStudioAction(
    connectionId: string,
    namespace: string,
    docName: string,
    menuType: number,
    actionId: string,
    result: StudioUserAction,
  ) {
    appendLog(`[studio] resultado bruto: ${JSON.stringify(result)}`, "info");
    switch (result.action) {
      case 1: {
        const answer = await new Promise<string>((resolve) => {
          setStudioDialog({
            kind: "confirm",
            message: result.target,
            onAnswer: (ans) => {
              setStudioDialog(null);
              resolve(ans);
            },
          });
        });
        const after = await window.electronAPI.atelier.invokeStudioAfterUserAction(
          connectionId,
          namespace,
          menuType,
          actionId,
          docName,
          answer,
          "",
        );
        if (after)
          await processStudioAction(connectionId, namespace, docName, menuType, actionId, after);
        return;
      }
      case 2: {
        // Opened in an Electron window we control (not an external OS browser), so the CSP page's
        // own `postMessage({ result: "done" })` can report completion back — see studioCspWindow.ts.
        let answer: "1" | "2" = "2";
        try {
          const tokenResult = await window.electronAPI.atelier.query(
            connectionId,
            namespace,
            "SELECT %Atelier_v1_Utils.General_GetCSPToken(?) AS Token",
            [result.target],
          );
          const token = (tokenResult.rows[0] as Record<string, unknown> | undefined)?.Token;
          const profile = (await window.electronAPI.connections.list()).find(
            (p) => p.id === connectionId,
          );
          if (profile && token) {
            const protocol = profile.https ? "https" : "http";
            const base = `${protocol}://${profile.host}:${profile.port}${profile.pathPrefix ?? ""}`;
            const separator = result.target.includes("?") ? "&" : "?";
            const url = `${base}${result.target}${separator}CSPCHD=${encodeURIComponent(String(token))}&CSPSHARE=1&Namespace=${encodeURIComponent(namespace)}`;
            answer = await window.electronAPI.studio.openCspAction(url);
          }
        } catch (error) {
          appendLog(`Erro ao abrir página do servidor: ${(error as Error).message}`, "error");
        }
        const after = await window.electronAPI.atelier.invokeStudioAfterUserAction(
          connectionId,
          namespace,
          menuType,
          actionId,
          docName,
          answer,
          "",
        );
        if (after)
          await processStudioAction(connectionId, namespace, docName, menuType, actionId, after);
        return;
      }
      case 3: {
        if (/^(https?|ftp):\/\//i.test(result.target)) window.open(result.target, "_blank");
        else
          appendLog(
            `Ação do servidor pediu para executar "${result.target}", não suportado neste cliente.`,
            "error",
          );
        return;
      }
      case 4: {
        codeEditorRef.current?.insertTextAtCursor(result.target);
        return;
      }
      case 5: {
        const items = result.target
          .split(",")
          .map((item) => item.trim().split(":")[0])
          .filter(Boolean);
        for (const name of items) await openServerDocument(connectionId, namespace, name);
        return;
      }
      case 6: {
        await new Promise<void>((resolve) => {
          setStudioDialog({
            kind: "alert",
            message: result.target,
            onAnswer: () => {
              setStudioDialog(null);
              resolve();
            },
          });
        });
        const after = await window.electronAPI.atelier.invokeStudioAfterUserAction(
          connectionId,
          namespace,
          menuType,
          actionId,
          docName,
          "1",
          "",
        );
        if (after)
          await processStudioAction(connectionId, namespace, docName, menuType, actionId, after);
        return;
      }
      case 7: {
        const answer = await new Promise<{ answer: string; msg?: string }>((resolve) => {
          setStudioDialog({
            kind: "prompt",
            message: result.target,
            onAnswer: (ans, msg) => {
              setStudioDialog(null);
              resolve({ answer: ans, msg });
            },
          });
        });
        const after = await window.electronAPI.atelier.invokeStudioAfterUserAction(
          connectionId,
          namespace,
          menuType,
          actionId,
          docName,
          answer.answer,
          answer.msg ?? result.message ?? "",
        );
        if (after)
          await processStudioAction(connectionId, namespace, docName, menuType, actionId, after);
        return;
      }
      default:
        return;
    }
  }

  // A completed action (e.g. logging in) can change which menu items the server considers enabled,
  // so refetch once the whole action chain settles — but only once per click, not per recursive
  // AfterUserAction round trip, so a multi-step action doesn't hammer the server with repeat queries.
  async function refreshStudioMenus() {
    const connectionId = activeTab?.connectionId;
    const namespace = activeTab?.namespace;
    const docName = activeTab?.docName;
    if (!hasElectronAPI || !connectionId || !namespace || !docName) return;
    try {
      const enabled = await window.electronAPI.atelier.isStudioExtensionEnabled(
        connectionId,
        namespace,
      );
      if (!enabled) return;
      const menus = await window.electronAPI.atelier.getStudioMenus(
        connectionId,
        namespace,
        "main",
        docName,
      );
      setStudioMenus(menus);
      const summary = menus
        .map(
          (menu) =>
            `${menu.name}: [${menu.items.map((item) => `${item.name}=${item.enabled}`).join(", ")}]`,
        )
        .join(" | ");
      appendLog(`[studio] menus atualizados -> ${summary}`, "info");
    } catch {
      // keep whatever menu state was already loaded rather than clearing it on a transient error
    }
  }

  async function runStudioAction(actionId: string) {
    if (!hasElectronAPI || !activeTab?.connectionId || !activeTab.namespace || !activeTab.docName)
      return;
    const { connectionId, namespace, docName } = activeTab;
    const menuType = 0;
    const selectedText = codeEditorRef.current?.getSelectedText() ?? "";
    try {
      const result = await window.electronAPI.atelier.invokeStudioUserAction(
        connectionId,
        namespace,
        menuType,
        actionId,
        docName,
        selectedText,
      );
      if (result)
        await processStudioAction(connectionId, namespace, docName, menuType, actionId, result);
    } catch (error) {
      appendLog(`Erro ao executar ação do servidor: ${(error as Error).message}`, "error");
    } finally {
      await refreshStudioMenus();
    }
  }

  function openSqlTab() {
    const existing = tabs.find((tab) => tab.kind === "sql");
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = `sql-${nextTabId.current++}`;
    setTabs((prev) => [
      ...prev,
      { id, kind: "sql", title: "Consulta SQL", content: "", savedContent: "" },
    ]);
    setActiveTabId(id);
  }

  // The "api" tab's content isn't editable — it just pins the class UDL text (as of when the tab
  // was opened) so ApiTester can parse its XData UrlMap without a second server round trip.
  function openApiTab(connectionId: string, namespace: string, docName: string, content: string) {
    const existing = tabs.find(
      (tab) =>
        tab.kind === "api" &&
        tab.connectionId === connectionId &&
        tab.namespace === namespace &&
        tab.docName === docName,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = `api-${nextTabId.current++}`;
    const title = docName.replace(/\.cls$/i, "");
    setTabs((prev) => [
      ...prev,
      { id, kind: "api", title, content, savedContent: content, connectionId, namespace, docName },
    ]);
    setActiveTabId(id);
  }

  function openAgentTab(connectionId: string, namespace: string) {
    const existing = tabs.find(
      (tab) =>
        tab.kind === "agent" && tab.connectionId === connectionId && tab.namespace === namespace,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = `agent-${nextTabId.current++}`;
    setTabs((prev) => [
      ...prev,
      {
        id,
        kind: "agent",
        title: `Agente: ${namespace}`,
        content: "",
        savedContent: "",
        connectionId,
        namespace,
      },
    ]);
    setActiveTabId(id);
  }

  function openSpecTab(specPath: string, name: string, content: string) {
    const existing = tabs.find((tab) => tab.kind === "spec" && tab.specPath === specPath);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const id = `spec-${nextTabId.current++}`;
    setTabs((prev) => [
      ...prev,
      { id, kind: "spec", title: name, content, savedContent: content, specPath },
    ]);
    setActiveTabId(id);
  }

  async function saveSpecFile() {
    const tab = activeTab;
    if (!tab || tab.kind !== "spec" || !tab.specPath) return;
    try {
      await window.electronAPI.specs.write(tab.specPath, tab.content);
      setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, savedContent: t.content } : t)));
      appendLog(`${tab.title} salvo.`, "success");
    } catch (error) {
      appendLog(`Erro ao salvar ${tab.title}: ${(error as Error).message}`, "error");
    }
  }

  function saveActiveTab() {
    if (activeTab?.kind === "spec") void saveSpecFile();
    else void saveAndCompile();
  }

  function openApiTesterForActiveTab() {
    if (
      !activeTab ||
      activeTab.kind !== "code" ||
      !activeTab.connectionId ||
      !activeTab.namespace ||
      !activeTab.docName
    )
      return;
    // Uses the last-saved/compiled source, not the possibly-unsaved editor content — the tester
    // calls the live deployed endpoint, so its route list should match what the server actually runs.
    openApiTab(
      activeTab.connectionId,
      activeTab.namespace,
      activeTab.docName,
      activeTab.savedContent,
    );
  }

  async function openApiTesterForDocument(
    connectionId: string,
    namespace: string,
    docName: string,
  ) {
    try {
      const doc = await window.electronAPI.atelier.getDocument(connectionId, namespace, docName);
      openApiTab(connectionId, namespace, docName, doc.content.join("\n"));
    } catch (error) {
      appendLog(`Não foi possível abrir "${docName}": ${(error as Error).message}`, "error");
    }
  }

  function updateTabContent(tabId: string, content: string) {
    setTabs((prev) => prev.map((tab) => (tab.id === tabId ? { ...tab, content } : tab)));
  }

  function removeTab(tabId: string) {
    setTabs((prev) => {
      const index = prev.findIndex((tab) => tab.id === tabId);
      const next = prev.filter((tab) => tab.id !== tabId);
      if (activeTabId === tabId) {
        const fallback = next[Math.min(index, next.length - 1)];
        setActiveTabId(fallback ? fallback.id : null);
      }
      return next;
    });
    setDiagnostics((prev) => {
      if (!(tabId in prev)) return prev;
      const { [tabId]: _removed, ...rest } = prev;
      return rest;
    });
  }

  function closeTab(tabId: string) {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab && isDirty(tab)) {
      setPendingCloseId(tabId);
      return;
    }
    removeTab(tabId);
  }

  async function saveAndCompile() {
    const tab = activeTab;
    if (!tab || !tab.connectionId || !tab.namespace || !tab.docName) return;
    const { connectionId, namespace, docName } = tab;
    if (tab.readOnly) {
      appendLog(
        `Não é possível salvar "${docName}": ${tab.readOnlyReason ?? "o servidor marca este documento como somente leitura."}`,
        "error",
      );
      return;
    }
    appendLog(`Salvando ${docName}…`);
    try {
      const lines = tab.content.split("\n");
      await window.electronAPI.atelier.saveDocument(connectionId, namespace, docName, lines);
      appendLog(`Compilando ${docName}…`);
      const output = await window.electronAPI.atelier.compile(connectionId, namespace, [docName]);
      output.forEach((line) => appendLog(line, "info"));

      const parsed = parseCompileDiagnostics(output);
      setDiagnostics((prev) => ({ ...prev, [tab.id]: parsed }));

      // Compiling can change the document server-side (e.g. IRIS appends/updates a Storage
      // definition for persistent classes), so reload it instead of just marking the local edit as saved.
      const recompiled = await window.electronAPI.atelier.getDocument(
        connectionId,
        namespace,
        docName,
      );
      const freshContent = recompiled.content.join("\n");
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tab.id ? { ...t, content: freshContent, savedContent: freshContent } : t,
        ),
      );
      codeEditorRef.current?.setTabContent(tab.id, freshContent);
      appendLog(
        `${docName} salvo e compilado.`,
        parsed.some((d) => d.severity === "error") ? "error" : "success",
      );
    } catch (error) {
      appendLog(`Erro ao salvar/compilar ${docName}: ${(error as Error).message}`, "error");
    }
  }

  async function exportActiveClassAsXml() {
    if (!activeTab || activeTab.kind !== "code") return;
    try {
      const { xml, className } = classSourceToExportXml(activeTab.content.split("\n"));
      const suggestedName = `${className}.cls.xml`;
      if (hasElectronAPI) {
        const savedPath = await window.electronAPI.files.saveText(suggestedName, xml);
        if (savedPath) appendLog(`${className} exportado para ${savedPath}.`, "success");
      } else {
        downloadTextFile(suggestedName, xml);
        appendLog(`${suggestedName} baixado.`, "success");
      }
    } catch (error) {
      appendLog(`Erro ao exportar XML: ${(error as Error).message}`, "error");
    }
  }

  function startSidebarResize(event: React.MouseEvent) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(moveEvent: MouseEvent) {
      setSidebarWidth(Math.min(600, Math.max(180, startWidth + (moveEvent.clientX - startX))));
    }
    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startOutputResize(event: React.MouseEvent) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = outputHeight;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    // The container's height now eases in/out on collapse — that transition would otherwise fight
    // a live drag (each mousemove's height lagging behind the cursor), so suspend it for the drag.
    setOutputResizing(true);

    function onMove(moveEvent: MouseEvent) {
      setOutputHeight(Math.min(600, Math.max(80, startHeight - (moveEvent.clientY - startY))));
    }
    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setOutputResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveActiveTab();
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        openFindInFiles();
      }
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        setQuickOpenOpen(true);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    setClassReferenceOpener((className) => void openClassByName(className));
    return () => setClassReferenceOpener(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, tabs]);

  // Powers dot-completion (##class(X)., ..Property, variable.) — see monaco/classMembers.ts and
  // objectscript-completion.ts. %Dictionary.CompiledMethod/CompiledProperty already reflect the
  // full inherited member set, so a single query per class covers superclass members too. Also
  // powers `As Type(...)` type-parameter completion (monaco/typeParameters.ts) the same way, via
  // %Dictionary.CompiledParameter — same connection/namespace, so it shares this effect.
  useEffect(() => {
    const connectionId = activeTab?.connectionId;
    const namespace = activeTab?.namespace;
    if (!hasElectronAPI || !connectionId || !namespace) {
      setClassMemberProvider(null);
      setTypeParameterProvider(null);
      return;
    }
    setClassMemberProvider(async (className) => {
      try {
        const [methods, properties] = await Promise.all([
          window.electronAPI.atelier.query(
            connectionId,
            namespace,
            "SELECT Name, ClassMethod, ReturnType FROM %Dictionary.CompiledMethod WHERE parent = ?",
            [className],
          ),
          window.electronAPI.atelier.query(
            connectionId,
            namespace,
            "SELECT Name, Type FROM %Dictionary.CompiledProperty WHERE parent = ?",
            [className],
          ),
        ]);
        const methodMembers: ClassMember[] = methods.rows.map((row) => ({
          name: String(row.Name),
          kind: "method",
          classMethod: Number(row.ClassMethod) === 1,
          returnType: row.ReturnType ? String(row.ReturnType) : undefined,
        }));
        const propertyMembers: ClassMember[] = properties.rows.map((row) => ({
          name: String(row.Name),
          kind: "property",
          classMethod: false,
          returnType: row.Type ? String(row.Type) : undefined,
        }));
        return [...methodMembers, ...propertyMembers];
      } catch {
        return [];
      }
    });
    setTypeParameterProvider(async (typeName) => {
      try {
        const result = await window.electronAPI.atelier.query(
          connectionId,
          namespace,
          "SELECT Name, Default, Description FROM %Dictionary.CompiledParameter WHERE parent = ?",
          [typeName],
        );
        return result.rows.map((row) => ({
          name: String(row.Name),
          default:
            row.Default !== null && row.Default !== undefined ? String(row.Default) : undefined,
          doc: row.Description ? String(row.Description) : undefined,
        }));
      } catch {
        return [];
      }
    });
    return () => {
      setClassMemberProvider(null);
      setTypeParameterProvider(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.connectionId, activeTab?.namespace]);

  // Servers can contribute custom top-level menus (Caché Studio's "server-side source control"
  // mechanism) scoped to the currently open document. Re-fetch whenever the active document changes.
  useEffect(() => {
    let cancelled = false;

    async function loadMenus() {
      const connectionId = activeTab?.connectionId;
      const namespace = activeTab?.namespace;
      const docName = activeTab?.docName;
      if (!hasElectronAPI || !connectionId || !namespace || !docName) {
        if (!cancelled) setStudioMenus([]);
        return;
      }
      try {
        const enabled = await window.electronAPI.atelier.isStudioExtensionEnabled(
          connectionId,
          namespace,
        );
        if (!enabled) {
          if (!cancelled) setStudioMenus([]);
          return;
        }
        const menus = await window.electronAPI.atelier.getStudioMenus(
          connectionId,
          namespace,
          "main",
          docName,
        );
        if (!cancelled) setStudioMenus(menus);
      } catch {
        if (!cancelled) setStudioMenus([]);
      }
    }

    void loadMenus();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.connectionId, activeTab?.namespace, activeTab?.docName]);

  const pendingCloseTab = pendingCloseId
    ? tabs.find((tab) => tab.id === pendingCloseId)
    : undefined;

  const menus: MenuDef[] = [
    {
      label: "Arquivo",
      items: [
        {
          label: "Abrir Classe…",
          shortcut: "Ctrl+O",
          onSelect: () => setQuickOpenOpen(true),
        },
        {
          label: activeTab?.kind === "spec" ? "Salvar" : "Salvar e Compilar",
          shortcut: "Ctrl+S",
          disabled: activeTab?.kind === "spec" ? !activeTab.specPath : !activeTab?.connectionId,
          onSelect: saveActiveTab,
        },
        {
          label: "Exportar Classe como XML…",
          disabled: activeTab?.kind !== "code",
          onSelect: () => void exportActiveClassAsXml(),
        },
        {
          label: "Testar Rotas da API…",
          disabled:
            activeTab?.kind !== "code" ||
            !activeTab?.connectionId ||
            !activeTab.namespace ||
            !activeTab.docName,
          onSelect: openApiTesterForActiveTab,
        },
        { label: "Importar Tema…", onSelect: () => fileInputRef.current?.click() },
      ],
    },
    {
      label: "Ver",
      items: [
        { label: "Conexões", checked: panelOpen, onSelect: () => setPanelOpen((open) => !open) },
        {
          label: "Saída (Output)",
          checked: outputOpen,
          onSelect: () => setOutputOpen((open) => !open),
        },
        { label: "Localizar em Arquivos…", shortcut: "Ctrl+Shift+F", onSelect: openFindInFiles },
        { label: "Consulta SQL…", onSelect: openSqlTab },
        {
          label: "Tema",
          submenu: themes.map((theme) => ({
            label: theme.label,
            checked: theme.id === themeId,
            onSelect: () => selectTheme(theme.id),
          })),
        },
        { label: "Configurações…", onSelect: () => setSettingsOpen(true) },
      ],
    },
    {
      label: "Agente",
      items: [
        {
          label:
            activeTab?.connectionId && activeTab?.namespace
              ? `Abrir agente: ${activeTab.namespace}…`
              : "Abrir agente…",
          disabled: !activeTab?.connectionId || !activeTab?.namespace,
          onSelect: () => {
            if (activeTab?.connectionId && activeTab?.namespace)
              openAgentTab(activeTab.connectionId, activeTab.namespace);
          },
        },
      ],
    },
    ...studioMenus
      .filter((menu) => menu.items.length > 0)
      .map((menu) => ({
        label: menu.name,
        items: menu.items
          .filter((item) => Number(item.separator) !== 1)
          .map((item) => ({
            label: item.name,
            // Confirmed real (not cosmetic): clicking with enabled=0 returns a literal action=0
            // no-op from the server, so respecting this flag is correct.
            disabled: Number(item.enabled) === 0,
            // The server resolves actions by a composite "menuId,itemId" string, not the bare item id
            // (confirmed from vscode-objectscript's prepareMenuItems: `id: `${sub.id},${el.id}``).
            onSelect: () => void runStudioAction(`${menu.id},${item.id}`),
          })),
      })),
  ];

  return (
    <>
      <div
        className="titlebar"
        onDoubleClick={() => hasElectronAPI && window.electronAPI.windowControls.toggleMaximize()}
      >
        <AppLogo />
        <MenuBar menus={menus} />
        <span className="titlebar-title" />
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importThemeFile(file);
            event.target.value = "";
          }}
        />
        {updateStatus?.state === "downloading" && (
          <div className="update-pill" title={`Baixando atualização… ${updateStatus.percent}%`}>
            Baixando atualização… {updateStatus.percent}%
          </div>
        )}
        {updateStatus?.state === "downloaded" && (
          <button
            type="button"
            className="update-pill update-pill-ready"
            title={`Versão ${updateStatus.version} pronta para instalar`}
            onClick={() => void window.electronAPI.updater.install()}
          >
            Reiniciar e Atualizar
          </button>
        )}
        <div className="window-controls">
          <button
            type="button"
            className="window-control window-control-minimize"
            title="Minimizar"
            onClick={() => hasElectronAPI && window.electronAPI.windowControls.minimize()}
          >
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
              <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
          <button
            type="button"
            className="window-control window-control-maximize"
            title="Maximizar"
            onClick={() => hasElectronAPI && window.electronAPI.windowControls.toggleMaximize()}
          >
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
              <rect
                x="0.5"
                y="0.5"
                width="9"
                height="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          </button>
          <button
            type="button"
            className="window-control window-control-close"
            title="Fechar"
            onClick={() => hasElectronAPI && window.electronAPI.windowControls.close()}
          >
            <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
              <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
            </svg>
          </button>
        </div>
      </div>
      <div className="workbench">
        {panelOpen && (
          <>
            <div className="sidebar-container" style={{ width: sidebarWidth }}>
              <ConnectionsPanel
                ref={connectionsPanelRef}
                onOpenDocument={handleOpenDocument}
                onLog={appendLog}
                onDocumentDeleted={handleDocumentDeleted}
                onDocumentRenamed={handleDocumentRenamed}
                onOpenApiTester={(connectionId, namespace, docName) =>
                  void openApiTesterForDocument(connectionId, namespace, docName)
                }
                onOpenAgent={openAgentTab}
                onOpenSpec={openSpecTab}
                onSpecDeleted={handleSpecDeleted}
                onSpecRenamed={handleSpecRenamed}
              />
            </div>
            <div className="resize-handle resize-handle-x" onMouseDown={startSidebarResize} />
          </>
        )}
        <div className="editor-column">
          <div className="tab-bar">
            <div className="tab-bar-scroll">
              {tabs.map((tab) => (
                <div
                  key={tab.id}
                  className={`tab${tab.id === activeTabId ? " active" : ""}`}
                  onClick={() => setActiveTabId(tab.id)}
                  onMouseDown={(event) => {
                    if (event.button === 1) event.preventDefault();
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1) closeTab(tab.id);
                  }}
                  title={tab.readOnly ? (tab.readOnlyReason ?? "Somente leitura") : undefined}
                >
                  <span className="tab-title">
                    {tab.kind === "sql" ? "🗄️ " : ""}
                    {tab.kind === "api" ? "🔌 " : ""}
                    {tab.kind === "agent" ? "🤖 " : ""}
                    {tab.kind === "spec" ? "📝 " : ""}
                    {tab.readOnly ? "🔒 " : ""}
                    {tab.title}
                    {isDirty(tab) ? " ●" : ""}
                  </span>
                  <button
                    type="button"
                    className="tab-close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className="tab-bar-actions">
              <button
                type="button"
                className="tab-new"
                onClick={openSqlTab}
                title="Nova consulta SQL"
              >
                🗄️
              </button>
            </div>
          </div>
          <div className="editor-area">
            <div
              className="editor-surface"
              style={{
                display:
                  activeTab?.kind === "code" || activeTab?.kind === "spec" ? "block" : "none",
              }}
            >
              <CodeEditor
                ref={codeEditorRef}
                tabs={tabs
                  .filter((tab) => tab.kind === "code" || tab.kind === "spec")
                  .map((tab) => ({
                    id: tab.id,
                    title: tab.title,
                    content: tab.content,
                    readOnly: tab.readOnly,
                  }))}
                activeTabId={
                  activeTab?.kind === "code" || activeTab?.kind === "spec" ? activeTabId : null
                }
                onContentChange={updateTabContent}
                diagnostics={diagnostics}
                theme={themeId}
              />
            </div>
            {tabs
              .filter((tab) => tab.kind === "sql")
              .map((tab) => (
                <div
                  key={tab.id}
                  className="editor-surface"
                  style={{ display: tab.id === activeTabId ? "block" : "none" }}
                >
                  <SqlRunner onLog={appendLog} />
                </div>
              ))}
            {tabs
              .filter(
                (tab) => tab.kind === "api" && tab.connectionId && tab.namespace && tab.docName,
              )
              .map((tab) => (
                <div
                  key={tab.id}
                  className="editor-surface"
                  style={{ display: tab.id === activeTabId ? "block" : "none" }}
                >
                  <ApiTester
                    connectionId={tab.connectionId!}
                    namespace={tab.namespace!}
                    docName={tab.docName!}
                    sourceContent={tab.content}
                    onLog={appendLog}
                  />
                </div>
              ))}
            {tabs
              .filter((tab) => tab.kind === "agent" && tab.connectionId && tab.namespace)
              .map((tab) => (
                <div
                  key={tab.id}
                  className="editor-surface"
                  style={{ display: tab.id === activeTabId ? "block" : "none" }}
                >
                  <AgentPanel
                    connectionId={tab.connectionId!}
                    namespace={tab.namespace!}
                    onLog={appendLog}
                    onDocumentSaved={handleAgentDocumentSaved}
                  />
                </div>
              ))}
          </div>
          {outputOpen && (
            <div className="resize-handle resize-handle-y" onMouseDown={startOutputResize} />
          )}
          <div
            className="output-container"
            style={{
              height: outputOpen ? outputHeight : OUTPUT_COLLAPSED_HEIGHT,
              transition: outputResizing ? "none" : "height 0.18s ease",
            }}
          >
            <OutputPanel
              lines={logLines}
              onClear={() => setLogLines([])}
              activeTab={outputTab}
              // Picking a tab while collapsed also reopens the panel — same one-click reopen the
              // old separate collapsed bar gave, just without swapping in a different component.
              onActiveTabChange={(tab) => {
                setOutputTab(tab);
                setOutputOpen(true);
              }}
              search={{
                query: searchQuery,
                onQueryChange: setSearchQuery,
                mask: searchMask,
                onMaskChange: setSearchMask,
                caseSensitive: searchCaseSensitive,
                onCaseSensitiveChange: setSearchCaseSensitive,
                onSearch: () => void runFindInFiles(),
                onCancel: cancelSearch,
                running: searchRunning,
                status: searchStatus,
                results: searchResults,
                onOpenResult: (docName, line) => void openSearchResult(docName, line),
                focusToken: searchFocusToken,
              }}
              collapsed={!outputOpen}
              onToggleCollapsed={() => setOutputOpen((open) => !open)}
            />
          </div>
        </div>
      </div>

      {pendingCloseTab && (
        <div className="modal-overlay" onClick={() => setPendingCloseId(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h4>Fechar sem salvar?</h4>
            <p>
              "{pendingCloseTab.title}" tem alterações não salvas. Fechar mesmo assim descarta essas
              alterações.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  removeTab(pendingCloseTab.id);
                  setPendingCloseId(null);
                }}
              >
                Fechar sem salvar
              </button>
              <button type="button" onClick={() => setPendingCloseId(null)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingWindowClose && (
        <div className="modal-overlay" onClick={() => setPendingWindowClose(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <h4>Fechar sem salvar?</h4>
            <p>
              Há {tabs.filter(isDirty).length} aba(s) com alterações não salvas. Fechar o programa
              agora descarta essas alterações.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  setPendingWindowClose(false);
                  void window.electronAPI.windowControls.confirmClose();
                }}
              >
                Fechar sem salvar
              </button>
              <button type="button" onClick={() => setPendingWindowClose(false)}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {studioDialog && <StudioDialogModal request={studioDialog} />}

      {settingsOpen && (
        <SettingsModal
          themes={themes}
          themeId={themeId}
          onSelectTheme={selectTheme}
          onImportThemeClick={() => fileInputRef.current?.click()}
          accentOverride={accentOverride}
          onSelectAccent={selectAccent}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {quickOpenOpen && (
        <QuickOpenClassModal
          classNames={getKnownClasses()}
          onOpen={(className) => {
            setQuickOpenOpen(false);
            void openClassByName(className);
          }}
          onClose={() => setQuickOpenOpen(false)}
        />
      )}
    </>
  );
}

export default App;
