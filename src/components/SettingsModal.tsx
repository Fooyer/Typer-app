import { useEffect, useState } from "react";
import type { UpdaterStatus } from "../platform/types";
import type { AppTheme } from "../themes/registry";
import {
  AI_PROVIDERS,
  loadAiPreference,
  saveAiPreference,
} from "../utils/aiPreference";
import AppLogo from "./AppLogo";

const RELEASES_URL = "https://github.com/Fooyer/Typer-app/releases";

export interface SettingsModalProps {
  themes: AppTheme[];
  themeId: string;
  onSelectTheme: (id: string) => void;
  onImportThemeClick: () => void;
  accentOverride: string | null;
  onSelectAccent: (color: string | null) => void;
  // Lifted from App.tsx (same state that drives the titlebar update pill) rather than tracked
  // separately here, so the "Sobre" tab and the pill never disagree about what's in flight and a
  // manual "Verificar agora" click here doesn't race the app's own periodic check.
  updateStatus: UpdaterStatus | null;
  onCheckForUpdates: () => void;
  onInstallUpdate: () => void;
  onClose: () => void;
}

type SettingsTab = "aparencia" | "ia" | "sobre";

const TABS: { id: SettingsTab; label: string; icon: string; desc: string }[] = [
  { id: "aparencia", label: "Aparência", icon: "🎨", desc: "Tema, cores e destaque" },
  { id: "ia", label: "Inteligência Artificial", icon: "🤖", desc: "Provedor, modelo e chaves" },
  { id: "sobre", label: "Sobre", icon: "ℹ️", desc: "Versão e atualizações" },
];

// Presets shown alongside the free-form color picker — "Padrão" (null) restores the original brand
// purple/blue derived from the theme itself instead of an override; the rest are just convenient
// starting points, not an exhaustive list.
const ACCENT_PRESETS: { label: string; value: string | null }[] = [
  { label: "Cor do tema", value: null },
  { label: "Roxo", value: "#7c3aed" },
  { label: "Azul", value: "#2563eb" },
  { label: "Ciano", value: "#0891b2" },
  { label: "Verde", value: "#16a34a" },
  { label: "Laranja", value: "#ea580c" },
  { label: "Rosa", value: "#db2777" },
  { label: "Vermelho", value: "#dc2626" },
  { label: "Cinza", value: "#64748b" },
];

/** Cheap preview swatch colors for the theme grid — a simplified lookup (not appearance.ts's full
 * `pick` fallback chain) since this is only decorative, not the actual chrome being applied. */
function swatchColors(theme: AppTheme): { bg: string; accent: string } {
  const colors = theme.vscodeTheme.colors;
  const bg = colors["editor.background"] ?? (theme.kind === "dark" ? "#1e1e1e" : "#ffffff");
  const accent =
    colors["focusBorder"] ??
    colors["activityBarBadge.background"] ??
    (theme.kind === "dark" ? "#569cd6" : "#007acc");
  return { bg, accent };
}

function SettingsModal({
  themes,
  themeId,
  onSelectTheme,
  onImportThemeClick,
  accentOverride,
  onSelectAccent,
  updateStatus,
  onCheckForUpdates,
  onInstallUpdate,
  onClose,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("aparencia");
  const isCustomAccent =
    accentOverride !== null && !ACCENT_PRESETS.some((p) => p.value === accentOverride);

  // ---- AI provider configuration --------------------------------
  const hasElectronAPI = typeof window.electronAPI !== "undefined";

  // ---- About / updates --------------------------------
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!hasElectronAPI) return;
    window.electronAPI.app
      .getVersion()
      .then(setAppVersion)
      .catch(() => setAppVersion(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [providerId, setProviderId] = useState<string>(() => loadAiPreference().providerId);
  const [model, setModel] = useState<string>(() => loadAiPreference().model);
  // Model ids the bundled opencode can actually use, per selected provider (`opencode models ...`).
  // Empty for providers not configured on this machine → the field then works as free-form id only.
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  // True only while the opencode CLI call behind modelOptions is in flight, so just the model field
  // shows a spinner — the rest of the modal (provider select, API keys, etc.) stays fully usable.
  const [modelsLoading, setModelsLoading] = useState(false);
  // Draft API keys for BOTH here: each provider row keeps its own typed-but-unsaved value, so the
  // user can fill several keys and save them all at once (the main process persists each provider's
  // key independently — see electron/aiSettings.ts).
  const [apiKeys, setApiKeys] = useState<Record<string, string>>(() =>
    Object.fromEntries(AI_PROVIDERS.filter((p) => p.id !== "default").map((p) => [p.id, ""])),
  );
  // Providers the user explicitly asked to clear on the next save (checkbox shown only when that
  // provider already has a key). An empty changed field alone means "keep", so this is the only
  // way to remove.
  const [removeKeys, setRemoveKeys] = useState<Set<string>>(() => new Set());
  // Which provider ids actually have a saved key in the main process (never the key itself).
  const [savedKeyProviders, setSavedKeyProviders] = useState<string[]>([]);
  const [aiStatus, setAiStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!hasElectronAPI) return;
    window.electronAPI.ai
      .getConfig()
      .then((config) => {
        setProviderId(config.providerId);
        setModel(config.model);
        setSavedKeyProviders(config.savedKeyProviders);
      })
      .catch(() => {
        setAiStatus("Não foi possível carregar a configuração da IA.");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The model suggestions come live from the bundled opencode binary, scoped to the selected
  // provider. Refetch whenever the provider changes so the datalist only ever offers ids that make
  // sense for what's selected (on this machine "Padrão" is where the opencode/* models live).
  useEffect(() => {
    if (!hasElectronAPI) {
      setModelOptions([]);
      return;
    }
    // Guards against a stale response landing after the user has already switched providers again
    // (the previous request's promise settling after a newer one was fired).
    let stale = false;
    setModelsLoading(true);
    window.electronAPI.ai
      .modelList(providerId === "default" ? undefined : providerId)
      .then((models) => {
        if (!stale) setModelOptions(models);
      })
      .catch(() => {
        if (!stale) setModelOptions([]);
      })
      .finally(() => {
        if (!stale) setModelsLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [hasElectronAPI, providerId]);

  const isDefaultProvider = providerId === "default";
  const keyProviders = AI_PROVIDERS.filter((p) => p.id !== "default");

  function setApiKeyValue(id: string, value: string) {
    setApiKeys((prev) => ({ ...prev, [id]: value }));
    // Typing a value clearly isn't "remove this key" anymore — drop any pending removal.
    if (value.trim() !== "") {
      setRemoveKeys((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  function toggleRemoveKey(id: string) {
    setRemoveKeys((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSaveAi() {
    if (!hasElectronAPI) return;
    try {
      const trimmed = model.trim();
      const keys: Record<string, string> = {};
      for (const provider of keyProviders) {
        if (removeKeys.has(provider.id)) {
          keys[provider.id] = "";
          continue;
        }
        const value = (apiKeys[provider.id] ?? "").trim();
        if (value) keys[provider.id] = value;
      }
      const config = await window.electronAPI.ai.saveConfig({
        providerId,
        model: trimmed,
        keys,
      });
      saveAiPreference({ providerId, model: trimmed });
      setSavedKeyProviders(config.savedKeyProviders);
      setApiKeys(Object.fromEntries(keyProviders.map((p) => [p.id, ""])));
      setRemoveKeys(new Set());
      setAiStatus("Configuração de IA salva.");
    } catch (err) {
      setAiStatus(`Erro ao salvar: ${(err as Error).message}`);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={(event) => event.stopPropagation()}>
        <div className="settings-modal-header">
          <AppLogo />
          <div className="settings-modal-title">
            <h3>Configurações</h3>
            <p>Ajuste a aparência do Typer e a IA que alimenta o painel do agente.</p>
          </div>
          <button type="button" className="settings-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>

        <div className="settings-modal-body">
          <nav className="settings-tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-tab${activeTab === tab.id ? " active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="settings-tab-icon">{tab.icon}</span>
                <span className="settings-tab-text">
                  <span className="settings-tab-label">{tab.label}</span>
                  <span className="settings-tab-desc">{tab.desc}</span>
                </span>
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {activeTab === "aparencia" && (
              <>
                <section className="settings-section">
                  <div className="settings-section-head">
                    <h4>Tema</h4>
                    <p className="settings-hint">
                      Temas escuros e claros portados do VS Code, ou importe o seu próprio
                      (JSON de tema do VS Code).
                    </p>
                  </div>
                  <div className="settings-card">
                    <div className="theme-grid">
                      {themes.map((theme) => {
                        const { bg, accent } = swatchColors(theme);
                        const selected = theme.id === themeId;
                        return (
                          <button
                            key={theme.id}
                            type="button"
                            className={`theme-swatch${selected ? " selected" : ""}`}
                            onClick={() => onSelectTheme(theme.id)}
                            title={theme.label}
                          >
                            <span
                              className="theme-swatch-preview"
                              style={{ background: bg, borderColor: accent }}
                            >
                              <span className="theme-swatch-accent" style={{ background: accent }} />
                            </span>
                            <span className="theme-swatch-label">{theme.label}</span>
                            <span className="theme-swatch-kind">
                              {theme.kind === "dark" ? "Escuro" : "Claro"}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="settings-actions">
                      <button type="button" onClick={onImportThemeClick}>
                        Importar tema…
                      </button>
                    </div>
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-section-head">
                    <h4>Cor de destaque</h4>
                    <p className="settings-hint">
                      Usada na logo e na barra de título, por padrão segue o tema escolhido,
                      mas você pode fixar uma cor própria.
                    </p>
                  </div>
                  <div className="settings-card">
                    <div className="accent-row">
                      {ACCENT_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          className={`accent-swatch${accentOverride === preset.value ? " selected" : ""}`}
                          style={
                            preset.value
                              ? { background: preset.value }
                              : { background: "var(--accent)" }
                          }
                          title={preset.label}
                          onClick={() => onSelectAccent(preset.value)}
                        />
                      ))}
                      <label
                        className={`accent-swatch accent-swatch-custom${isCustomAccent ? " selected" : ""}`}
                        title="Cor personalizada"
                        style={isCustomAccent ? { background: accentOverride! } : undefined}
                      >
                        🎨
                        <input
                          type="color"
                          value={accentOverride ?? "#7c3aed"}
                          onChange={(event) => onSelectAccent(event.target.value)}
                        />
                      </label>
                    </div>
                  </div>
                </section>
              </>
            )}

            {activeTab === "ia" && (
              <>
                <section className="settings-section">
                  <div className="settings-section-head">
                    <h4>Provedor de IA do agente</h4>
                    <p className="settings-hint">
                      Escolha qual provedor e qual modelo o painel de IA usa nas próximas
                      execuções. As chaves ficam criptografadas no computador e nunca aparecem
                      nas mensagens do chat.
                    </p>
                  </div>
                  <div className="settings-card">
                    <label className="settings-field">
                      <span>Provedor</span>
                      <select
                        value={providerId}
                        onChange={(event) => setProviderId(event.target.value)}
                      >
                        {AI_PROVIDERS.map((provider) => (
                          <option key={provider.id} value={provider.id}>
                            {provider.label}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="settings-field">
                      <span>Modelo</span>
                      <div className="settings-model-input">
                        <input
                          type="text"
                          list="ai-model-suggestions"
                          value={model}
                          onChange={(event) => setModel(event.target.value)}
                          placeholder={
                            isDefaultProvider
                              ? "modelo padrão do opencode"
                              : "digite o id do modelo aceito pelo provedor"
                          }
                        />
                        {modelsLoading && (
                          <span
                            className="settings-model-spinner"
                            role="status"
                            aria-label="Carregando modelos do opencode…"
                            title="Carregando modelos do opencode…"
                          />
                        )}
                      </div>
                      <datalist id="ai-model-suggestions">
                        {modelOptions.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                      {modelsLoading && (
                        <span className="settings-hint">Buscando modelos do opencode…</span>
                      )}
                      {!modelsLoading && isDefaultProvider && modelOptions.length > 0 && (
                        <span className="settings-hint">
                          Sugestões listadas vêm do opencode instalado (
                          <code>opencode models</code>).
                        </span>
                      )}
                      {!modelsLoading && !isDefaultProvider && modelOptions.length === 0 && (
                        <span className="settings-hint">
                          Este provedor não está configurado no seu opencode, digite o id do
                          modelo manualmente (ex.: claude-sonnet-4-5).
                        </span>
                      )}
                    </label>
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-section-head">
                    <h4>Chaves de API</h4>
                    <p className="settings-hint">
                      Preencha várias de uma vez, salvar aplica todas. Deixe um campo vazio para
                      manter a chave atual daquele provedor.
                    </p>
                  </div>
                  <div className="settings-card">
                    {keyProviders.map((provider) => {
                      const saved = savedKeyProviders.includes(provider.id);
                      return (
                        <div key={provider.id} className="settings-field">
                          <span className="settings-key-row">
                            {provider.label}
                            {saved ? (
                              <em className="settings-key-status ok">chave salva</em>
                            ) : (
                              <em className="settings-key-status missing">sem chave</em>
                            )}
                          </span>
                          <div className="settings-key-line">
                            <input
                              type="password"
                              value={apiKeys[provider.id] ?? ""}
                              onChange={(event) => setApiKeyValue(provider.id, event.target.value)}
                              placeholder={
                                saved ? "•••••••• (digite para trocar)" : "cole sua chave de API"
                              }
                              autoComplete="off"
                            />
                            {saved && (
                              <label className="settings-key-remove">
                                <input
                                  type="checkbox"
                                  checked={removeKeys.has(provider.id)}
                                  onChange={() => toggleRemoveKey(provider.id)}
                                />
                                remover
                              </label>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    <p className="settings-hint">
                      Provedores suportados: Claude/Anthropic, Gemini/Google, OpenAI e OpenRouter
                      (além do provedor padrão do opencode). A chave é passada ao opencode apenas
                      no momento da execução, via variável de ambiente.
                    </p>
                  </div>
                  <div className="settings-actions">
                    <button
                      type="button"
                      onClick={() => void handleSaveAi()}
                      className="settings-primary"
                    >
                      Salvar configuração de IA
                    </button>
                    {aiStatus && <span className="settings-status">{aiStatus}</span>}
                  </div>
                </section>
              </>
            )}

            {activeTab === "sobre" && (
              <>
                <section className="settings-section">
                  <div className="settings-section-head">
                    <h4>Typer</h4>
                  </div>
                  <div className="settings-card settings-about-card">
                    <AppLogo />
                    <div>
                      <div className="settings-about-name">Typer</div>
                      <div className="settings-hint">
                        {appVersion ? `Versão ${appVersion}` : "Obtendo versão…"}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-section-head">
                    <h4>Atualizações</h4>
                    <p className="settings-hint">
                      O Typer verifica automaticamente se há uma nova versão sempre que é aberto
                      (e a cada poucas horas enquanto fica aberto), baixando em segundo plano.
                      Você também pode verificar manualmente a qualquer momento.
                    </p>
                  </div>
                  <div className="settings-card">
                    <div className="settings-update-status">
                      {(updateStatus === null || updateStatus.state === "not-available") && (
                        <span>Você já está na versão mais recente.</span>
                      )}
                      {updateStatus?.state === "checking" && (
                        <span className="settings-update-row">
                          <span className="settings-model-spinner" role="status" aria-hidden="true" />
                          Verificando atualizações…
                        </span>
                      )}
                      {updateStatus?.state === "available" && (
                        <span className="settings-update-row">
                          <span className="settings-model-spinner" role="status" aria-hidden="true" />
                          Nova versão {updateStatus.version} encontrada, baixando…
                        </span>
                      )}
                      {updateStatus?.state === "downloading" && (
                        <span className="settings-update-row">
                          <span className="settings-model-spinner" role="status" aria-hidden="true" />
                          Baixando atualização… {updateStatus.percent}%
                        </span>
                      )}
                      {updateStatus?.state === "downloaded" && (
                        <span>Atualização {updateStatus.version} pronta para instalar.</span>
                      )}
                      {updateStatus?.state === "error" && (
                        <span className="settings-key-status missing">
                          Erro ao verificar atualizações: {updateStatus.message}
                        </span>
                      )}
                    </div>
                    <div className="settings-actions">
                      {updateStatus?.state === "downloaded" ? (
                        <button
                          type="button"
                          className="settings-primary"
                          onClick={onInstallUpdate}
                        >
                          Reiniciar e instalar
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={onCheckForUpdates}
                          disabled={
                            updateStatus?.state === "checking" ||
                            updateStatus?.state === "downloading" ||
                            updateStatus?.state === "available"
                          }
                        >
                          Verificar atualizações agora
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => window.open(RELEASES_URL, "_blank")}
                      >
                        Ver notas de lançamento
                      </button>
                    </div>
                  </div>
                </section>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsModal;
