import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import {
  getObjectScriptLanguageId,
  registerObjectScriptLanguage,
} from "../monaco/objectscript-language";
import { registerObjectScriptCompletion } from "../monaco/objectscript-completion";
import {
  extractClassNameAt,
  goToClassReference,
  registerObjectScriptDefinition,
} from "../monaco/classReferenceNavigation";
import { registerObjectScriptHover } from "../monaco/objectscript-hover";
import { computeParameterUsageDecorations } from "../monaco/parameterHighlight";
import { registerAllBuiltinThemes } from "../themes/registry";
import type { Diagnostic } from "../utils/diagnostics";

export interface EditorTab {
  id: string;
  /** File name (with extension), used to pick which ObjectScript grammar tokenizes this tab —
   * see getObjectScriptLanguageId. */
  title: string;
  content: string;
  readOnly?: boolean;
}

interface CodeEditorProps {
  tabs: EditorTab[];
  activeTabId: string | null;
  onContentChange: (tabId: string, content: string) => void;
  diagnostics?: Record<string, Diagnostic[]>;
  theme?: string;
}

export interface CodeEditorHandle {
  getSelectedText: () => string;
  insertTextAtCursor: (text: string) => void;
  setTabContent: (tabId: string, content: string) => void;
  revealLine: (tabId: string, line: number) => void;
}

const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor(
  { tabs, activeTabId, onContentChange, diagnostics, theme = "vs-dark" },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const listenersRef = useRef(new Map<string, monaco.IDisposable>());
  const paramDecorationsRef = useRef(new Map<string, string[]>());
  const onContentChangeRef = useRef(onContentChange);
  const [ready, setReady] = useState(false);

  onContentChangeRef.current = onContentChange;

  function refreshParameterDecorations(tabId: string, model: monaco.editor.ITextModel) {
    const previousIds = paramDecorationsRef.current.get(tabId) ?? [];
    const newIds = model.deltaDecorations(previousIds, computeParameterUsageDecorations(model));
    paramDecorationsRef.current.set(tabId, newIds);
  }

  const tabIdsKey = tabs.map((tab) => tab.id).join(",");
  const activeReadOnly = tabs.find((tab) => tab.id === activeTabId)?.readOnly ?? false;

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;

    registerAllBuiltinThemes(monaco);
    registerObjectScriptCompletion(monaco);
    registerObjectScriptDefinition(monaco);
    registerObjectScriptHover(monaco);

    // Wait for the TextMate grammar so the editor never briefly flashes the bootstrap Monarch colors.
    registerObjectScriptLanguage(monaco).then(() => {
      if (cancelled || !containerRef.current) return;
      editorRef.current = monaco.editor.create(containerRef.current, {
        automaticLayout: true,
        minimap: { enabled: true },
        fontSize: 14,
        theme,
      });
      // Monaco's bundled "go to definition" contribution (the F12 action) isn't included in this
      // build of monaco-editor — only the Ctrl+click-on-hover-link variant is. This action gives
      // F12 the same behavior directly, reusing the same class-reference lookup either way.
      editorRef.current.addAction({
        id: "objectscript.goToClassDefinition",
        label: "Ir para definição da classe",
        keybindings: [monaco.KeyCode.F12],
        run(ed) {
          const model = ed.getModel();
          const position = ed.getPosition();
          if (!model || !position) return;
          const className = extractClassNameAt(model, position);
          if (className) goToClassReference(className);
        },
      });
      setReady(true);
    });

    return () => {
      cancelled = true;
      editorRef.current?.dispose();
      editorRef.current = null;
      for (const disposable of listenersRef.current.values()) disposable.dispose();
      listenersRef.current.clear();
      for (const model of modelsRef.current.values()) model.dispose();
      modelsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One Monaco text model per open tab (not just a shared `value`), so each tab keeps its own
  // undo history and cursor position when switching. Models for closed tabs get disposed.
  useEffect(() => {
    if (!ready) return;
    const currentIds = new Set(tabs.map((tab) => tab.id));

    for (const [id, model] of modelsRef.current) {
      if (currentIds.has(id)) continue;
      listenersRef.current.get(id)?.dispose();
      listenersRef.current.delete(id);
      paramDecorationsRef.current.delete(id);
      model.dispose();
      modelsRef.current.delete(id);
    }

    for (const tab of tabs) {
      if (modelsRef.current.has(tab.id)) continue;
      const model = monaco.editor.createModel(
        tab.content,
        getObjectScriptLanguageId(tab.title),
        monaco.Uri.parse(`inmemory://tab/${tab.id}`),
      );
      modelsRef.current.set(tab.id, model);
      listenersRef.current.set(
        tab.id,
        model.onDidChangeContent(() => {
          onContentChangeRef.current(tab.id, model.getValue());
          refreshParameterDecorations(tab.id, model);
        }),
      );
      refreshParameterDecorations(tab.id, model);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, tabIdsKey]);

  // Re-picks each model's grammar when a tab is renamed to a different extension (e.g. Studio's
  // "Save As" flow) — the effect above only creates models for newly-opened tabs.
  const tabTitlesKey = tabs.map((tab) => `${tab.id}:${tab.title}`).join(",");
  useEffect(() => {
    if (!ready) return;
    for (const tab of tabs) {
      const model = modelsRef.current.get(tab.id);
      if (!model) continue;
      const languageId = getObjectScriptLanguageId(tab.title);
      if (model.getLanguageId() !== languageId) monaco.editor.setModelLanguage(model, languageId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, tabTitlesKey]);

  useEffect(() => {
    if (!ready || !activeTabId || !editorRef.current) return;
    const model = modelsRef.current.get(activeTabId);
    if (model) editorRef.current.setModel(model);
  }, [ready, activeTabId, tabIdsKey]);

  // readOnly is an editor-level option (there's one shared editor across all tabs' models — see
  // above), so it has to be re-applied on every tab switch rather than living on the model. Read-only
  // status usually isn't known yet when a tab first opens (it's a separate, async server check — see
  // App.tsx's applyReadOnlyStatus), so this also re-fires once that resolves for the active tab.
  useEffect(() => {
    if (!ready || !editorRef.current) return;
    editorRef.current.updateOptions({ readOnly: activeReadOnly });
  }, [ready, activeTabId, activeReadOnly]);

  useEffect(() => {
    if (ready) monaco.editor.setTheme(theme);
  }, [ready, theme]);

  useEffect(() => {
    if (!ready) return;
    for (const [tabId, model] of modelsRef.current) {
      const tabDiagnostics = diagnostics?.[tabId] ?? [];
      monaco.editor.setModelMarkers(
        model,
        "objectscript-compile",
        tabDiagnostics.map((diagnostic) => {
          const line = Math.min(Math.max(1, diagnostic.line), model.getLineCount());
          return {
            startLineNumber: line,
            endLineNumber: line,
            startColumn: 1,
            endColumn: model.getLineMaxColumn(line),
            message: diagnostic.message,
            severity:
              diagnostic.severity === "error"
                ? monaco.MarkerSeverity.Error
                : monaco.MarkerSeverity.Warning,
          };
        }),
      );
    }
  }, [ready, diagnostics, tabIdsKey]);

  useImperativeHandle(ref, () => ({
    getSelectedText: () => {
      const editor = editorRef.current;
      const selection = editor?.getSelection();
      if (!editor || !selection) return "";
      return editor.getModel()?.getValueInRange(selection) ?? "";
    },
    insertTextAtCursor: (text: string) => {
      const editor = editorRef.current;
      const selection = editor?.getSelection();
      if (!editor || !selection) return;
      editor.executeEdits("studio-user-action", [{ range: selection, text }]);
    },
    setTabContent: (tabId: string, content: string) => {
      const model = modelsRef.current.get(tabId);
      if (model && model.getValue() !== content) model.setValue(content);
    },
    revealLine: (tabId: string, line: number) => {
      const editor = editorRef.current;
      const model = modelsRef.current.get(tabId);
      if (!editor || !model) return;
      if (editor.getModel() !== model) editor.setModel(model);
      const clampedLine = Math.min(Math.max(1, line), model.getLineCount());
      const position = { lineNumber: clampedLine, column: 1 };
      editor.revealLineInCenter(clampedLine);
      editor.setPosition(position);
      editor.focus();
    },
  }));

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
});

export default CodeEditor;
