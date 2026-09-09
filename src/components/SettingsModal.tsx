import { useEffect, useState } from "react";
import type { AppTheme } from "../themes/registry";
import { AI_PROVIDERS, loadAiPreference, saveAiPreference } from "../utils/aiPreference";

export interface SettingsModalProps {
  themes: AppTheme[];
  themeId: string;
  onSelectTheme: (id: string) => void;
  onImportThemeClick: () => void;
  accentOverride: string | null;
  onSelectAccent: (color: string | null) => void;
  onClose: () => void;
}

type SettingsTab = "aparencia" | "ia";

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "aparencia", label: "Aparência", icon: "🎨" },
  { id: "ia", label: "Inteligência Artificial", icon: "🤖" },
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
  onClose,
}: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("aparencia");
  const isCustomAccent =
    accentOverride !== null && !ACCENT_PRESETS.some((p) => p.value === accentOverride);

  // ---- AI provider configuration --------------------------------
  const hasElectronAPI = typeof window.electronAPI !== "undefined";
  const [providerId, setProviderId] = useState<string>(() => loadAiPreference().providerId);
  const [model, setModel] = useState<string>(() => loadAiPreference().model);
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

  const selectedProvider = AI_PROVIDERS.find((p) => p.id === providerId) ?? AI_PROVIDERS[0];
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
      const config = await window.electronAPI.ai.saveConfig({ providerId, model: trimmed, keys });
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
          <h3>Configurações</h3>
          <button type="button" className="settings-close" onClick={onClose} title="Fechar">
            ✕
          </button>
        </div>
        <div className="settings-modal-body">
          <div className="settings-tabs">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`settings-tab${activeTab === tab.id ? " active" : ""}`}
                onClick={() => setActiveTab(tab.id)}
              >
                <span className="settings-tab-icon">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>

          <div className="settings-content">
            {activeTab === "aparencia" && (
              <>
                <section className="settings-section">
                  <h4>Tema</h4>
                  <p className="settings-hint">
                    Temas escuros e claros portados do VS Code, ou importe o seu próprio (JSON de
                    tema do VS Code).
                  </p>
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
                </section>

                <section className="settings-section">
                  <h4>Cor de destaque</h4>
                  <p className="settings-hint">
                    Usada na logo e na barra de título do app — por padrão segue o tema escolhido
                    acima, mas você pode fixar uma cor própria.
                  </p>
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
                </section>
              </>
            )}

            {activeTab === "ia" && (
              <>
                <section className="settings-section">
                  <h4>Provedor de IA do agente</h4>
                  <p className="settings-hint">
                    Escolha qual provedor o agente (opencode) usa nas próximas execuções. As chaves
                    de API ficam gravadas criptografadas no computador e nunca aparecem nas
                    mensagens do chat.
                  </p>
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
                    <input
                      type="text"
                      list="ai-model-suggestions"
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      placeholder={
                        isDefaultProvider ? "modelo padrão do opencode" : "ex.: gemini-2.5-pro"
                      }
                      disabled={isDefaultProvider}
                    />
                    <datalist id="ai-model-suggestions">
                      {selectedProvider.models.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  </label>
                </section>

                <section className="settings-section">
                  <h4>Chaves de API</h4>
                  <p className="settings-hint">
                    Preencha várias de uma vez — salvar aplica todas. Deixe um campo vazio para
                    manter a chave atual daquele provedor.
                  </p>
                  {keyProviders.map((provider) => {
                    const saved = savedKeyProviders.includes(provider.id);
                    return (
                      <div key={provider.id} className="settings-field">
                        <span className="settings-key-row">
                          {provider.label}
                          {saved ? (
                            <em className="settings-key-status ok">✓ chave salva</em>
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
                    (além do provedor padrão do opencode). A chave é passada ao opencode apenas no
                    momento da execução, via variável de ambiente.
                  </p>
                  <div className="settings-actions">
                    <button
                      type="button"
                      onClick={() => void handleSaveAi()}
                      className="settings-primary"
                    >
                      Salvar configuração de IA
                    </button>
                    {aiStatus && <p className="settings-hint settings-status">{aiStatus}</p>}
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
