import AppLogo from "./AppLogo";

interface WelcomePanelProps {
  onNewSql: () => void;
  onOpenClass: () => void;
  onFindInFiles: () => void;
  onImportTheme: () => void;
  onOpenSettings: () => void;
  onShowSidebar: () => void;
}

/**
 * The app's start page (the first tab opens here instead of a sample class), modeled after VS Code's
 * welcome screen: a centered header with the logo, then action rows that look like menu items so the
 * most useful entry points work straight from here — connecting, opening a class, a fresh SQL tab,
 * find-in-files, theme import and settings. Actions that need a server context (class, find-in-files)
 * fall back to the sidebar's currently connected server, see App.tsx's getActiveServerContext.
 */
function WelcomePanel({
  onNewSql,
  onOpenClass,
  onFindInFiles,
  onImportTheme,
  onOpenSettings,
  onShowSidebar,
}: WelcomePanelProps) {
  return (
    <div className="welcome-panel">
      <div className="welcome-inner">
        <div className="welcome-header">
          <div className="welcome-logo">
            <AppLogo />
          </div>
          <h1 className="welcome-title">Bem-vindo ao Typer</h1>
          <p className="welcome-subtitle">IDE para desenvolvimento no InterSystems IRIS.</p>
        </div>

        <section className="welcome-section">
          <h2 className="welcome-section-title">Começar</h2>
          <button type="button" className="welcome-action" onClick={onShowSidebar}>
            <span className="welcome-action-icon">🖥️</span>
            <span className="welcome-action-text">
              <strong>Conectar ao Servidor</strong>
              <span className="welcome-action-desc">
                Escolha um servidor IRIS no painel Conexões, à esquerda.
              </span>
            </span>
          </button>
          <button type="button" className="welcome-action" onClick={onOpenClass}>
            <span className="welcome-action-icon">🧩</span>
            <span className="welcome-action-text">
              <strong>Abrir Classe…</strong>
              <span className="welcome-action-desc">
                Digite o nome de uma classe para abri-la direto no editor.
              </span>
            </span>
            <kbd className="welcome-key">Ctrl+O</kbd>
          </button>
          <button type="button" className="welcome-action" onClick={onNewSql}>
            <span className="welcome-action-icon">🗄️</span>
            <span className="welcome-action-text">
              <strong>Nova consulta SQL</strong>
              <span className="welcome-action-desc">
                Abrir uma nova guia para rodar queries no namespace.
              </span>
            </span>
          </button>
          <button type="button" className="welcome-action" onClick={onFindInFiles}>
            <span className="welcome-action-icon">🔍</span>
            <span className="welcome-action-text">
              <strong>Localizar em Arquivos</strong>
              <span className="welcome-action-desc">
                Pesquisar textos nos documentos do namespace ativo.
              </span>
            </span>
            <kbd className="welcome-key">Ctrl+Shift+F</kbd>
          </button>
        </section>

        <section className="welcome-section">
          <h2 className="welcome-section-title">Personalizar</h2>
          <button type="button" className="welcome-action" onClick={onImportTheme}>
            <span className="welcome-action-icon">🎨</span>
            <span className="welcome-action-text">
              <strong>Importar Tema…</strong>
              <span className="welcome-action-desc">
                Carregar um tema VS Code (.json) exportado de outra instalação.
              </span>
            </span>
          </button>
          <button type="button" className="welcome-action" onClick={onOpenSettings}>
            <span className="welcome-action-icon">⚙️</span>
            <span className="welcome-action-text">
              <strong>Configurações…</strong>
              <span className="welcome-action-desc">
                Trocar tema, cor de destaque e preferências do agente.
              </span>
            </span>
          </button>
        </section>
      </div>
    </div>
  );
}

export default WelcomePanel;