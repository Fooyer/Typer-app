//! Rust port of `electron/agentRun.ts`. Runs `opencode` headless (`opencode run --format json`)
//! as a Tauri sidecar against a config-only project dir, streaming each stdout line back to the
//! frontend as it's produced. Reads/writes happen live against the IRIS server through the MCP
//! bridge (`agent_bridge.rs`).

use crate::agent_bridge;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::oneshot;

struct ActiveRun {
    /// Sending on this asks the run loop below to kill the child (the "Parar" button) — same
    /// pattern as `agent_bridge`'s pending-write channels, so cancellation never has to reach
    /// across threads/tasks to touch the child process directly.
    cancel: oneshot::Sender<()>,
    bridge_token: String,
}

static ACTIVE_RUNS: LazyLock<Mutex<HashMap<String, ActiveRun>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Resolution order mirrors a proven sibling project's approach: a production build (Tauri's
/// `externalBin` bundling copies the sidecar next to the main executable, dropping the
/// target-triple suffix) first, then the raw dev-time sidecar file under `src-tauri/binaries/`
/// (still triple-suffixed, since there's no bundling step in `cargo run`/`tauri dev`), then bare
/// `opencode` on PATH as a last resort.
fn resolve_opencode_binary() -> PathBuf {
    let exe_name = if cfg!(windows) { "opencode.exe" } else { "opencode" };
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(exe_name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    let triple_name =
        if cfg!(windows) { "opencode-x86_64-pc-windows-msvc.exe" } else { "opencode-x86_64-unknown-linux-gnu" };
    let dev_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(triple_name);
    if dev_path.is_file() {
        return dev_path;
    }
    PathBuf::from(exe_name)
}

fn base_command(bin: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(bin);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW — opencode is a console app; without this a visible console window
        // would flash open behind the app every time a turn runs.
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

/// The `typer-mcp` sidecar sits right next to the main executable both in dev (Cargo places every
/// `[[bin]]` target from this package in the same `target/debug`) and in a packaged build (Tauri's
/// `externalBin` copies it alongside the main binary, dropping the target-triple suffix).
fn mcp_binary_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or_else(|| "sem diretório pai para o executável".to_string())?;
    let name = if cfg!(windows) { "typer-mcp.exe" } else { "typer-mcp" };
    Ok(dir.join(name))
}

fn project_dir(app: &AppHandle, connection_id: &str, namespace: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("agent-projects").join(connection_id).join(namespace))
}

fn agents_instructions(namespace: &str, host: &str, port: u16) -> String {
    format!(
        r#"# Servidor IRIS conectado + Specs locais

Este projeto usa DUAS fontes de informação completamente separadas — nunca confunda uma com a outra:

## 0. Regra de ouro: você não conhece este projeto de antemão

Você NÃO tem nenhum conhecimento prévio sobre as classes, rotinas ou a estrutura deste namespace —
zero. Qualquer coisa que você "lembrar" de projetos parecidos não vale aqui. Isso significa:

- Para QUALQUER pergunta sobre o projeto — um resumo, "o que esse namespace faz", "como funciona
  X" — o PRIMEIRO passo é sempre `iris_list_documents` para ver o que realmente existe. Nunca
  responda especulando sobre o conteúdo antes de listar/ler algo de verdade.
- Depois de listar, leia (`iris_read_document`) os documentos cujo nome sugira relevância para a
  pergunta — não é preciso ler tudo, mas responder sem ter lido pelo menos um punhado de arquivos
  reais é inaceitável para qualquer pergunta que dependa do conteúdo do projeto.
- Se `iris_search` ajudar a encontrar onde algo está definido, use antes de abrir documentos às
  cegas.
- Nomes de documento são sempre o caminho completo devolvido por `iris_list_documents` (ex:
  "Pacote.Sub.Classe.cls", "/csp/user/pagina.csp") — use esse valor exato em `iris_read_document`/
  `iris_propose_write`, nunca um nome adivinhado ou abreviado.
- **NÃO delegue nada com a ferramenta "task" (sub-agentes). Ela está desativada neste projeto e
  qualquer chamada será rejeitada.** Mesmo que o output pareça grande ou repetitivo, leia e
  processe você mesmo, em uma única linha de execução contínua — nunca tente dividir o trabalho
  entre "agentes" paralelos ou passar uma sub-tarefa adiante. Se precisar ler várias specs ou
  documentos, chame `iris_read_document`/`specs_read` várias vezes seguidas, um de cada vez, você
  mesmo.

## 1. Código-fonte no servidor IRIS (ferramentas `iris_*`)

Este projeto não tem os fontes localmente. O namespace **{namespace}** no servidor **{host}:{port}**
é acessado inteiramente através das ferramentas MCP do servidor "iris":

- `iris_list_documents` — lista classes e rotinas do namespace.
- `iris_read_document` — lê o conteúdo atual de um documento (ex: "Pacote.Classe.cls").
- `iris_search` — busca um texto no código-fonte de todo o namespace.
- `iris_propose_write` — propõe salvar o conteúdo completo de um documento. Fica pendente até um
  humano aprovar ou rejeitar. Confira `approved` (decisão do usuário) e `saved` (se realmente
  foi gravado) no resultado: `approved: false` é uma rejeição (não insista sem perguntar);
  `approved: true, saved: false` significa que o usuário disse sim mas a gravação falhou (ex:
  timeout) — pode valer a pena tentar de novo.

Sempre leia um documento com `iris_read_document` antes de propor uma escrita nele.

## 2. Specs do projeto (ferramentas `specs_*`)

"Specs" são arquivos .md locais (planos, notas, especificações escritas pelo usuário sobre o que
construir) — NÃO são classes/rotinas do IRIS, NÃO existem no namespace do servidor, e NÃO devem ser
buscadas com `iris_search`, `iris_list_documents` ou `iris_read_document`. Elas ficam em outro
lugar (uma pasta local, fora deste projeto) e só são acessíveis por:

- `specs_list` — lista os nomes dos arquivos .md de spec disponíveis.
- `specs_read` — lê o conteúdo de um deles pelo nome (ex: "plano.md").
- `specs_write` — cria ou sobrescreve um arquivo .md de spec com o conteúdo completo informado
  (não um diff parcial). Cria o arquivo se ainda não existir. Diferente de `iris_propose_write`,
  isto NÃO espera aprovação humana — grava direto. Leia o arquivo com `specs_read` primeiro sempre
  que for uma edição (não uma criação do zero), para não apagar conteúdo por engano.

Sempre que o usuário mencionar "specs", "especificação", "plano" ou pedir para seguir/atualizar um
documento de planejamento do projeto, use `specs_list`/`specs_read`/`specs_write` — nunca as
ferramentas `iris_*`. Antes de atuar em uma tarefa, também vale a pena checar `specs_list` e ler
(`specs_read`) as specs cujo nome pareça relevante para o que foi pedido — não leia todas
indiscriminadamente, só as que puderem conter contexto útil. Se nenhuma parecer relevante, siga sem
ler nenhuma. Se o usuário pedir para registrar uma decisão, atualizar o plano ou documentar algo do
que foi feito, use `specs_write` para isso em vez de só responder no chat.

Não use ferramentas de arquivo local (read/write/edit/bash) para nada disso — este diretório de
projeto é só configuração, tanto o código quanto as specs são acessados exclusivamente pelas
ferramentas MCP acima.

## 3. Narre o progresso com uma checklist

Para qualquer tarefa com mais de um passo óbvio (e principalmente para pedidos grandes/complexos),
comece respondendo com uma checklist curta em markdown listando as subtarefas que você identificou,
ex:

```
- [ ] Ler Pacote.Classe.cls para entender a estrutura atual
- [ ] Propor a alteração X
- [ ] Propor a alteração Y
```

Depois, ao concluir CADA item (não só no final), envie de novo a checklist inteira com aquele item
marcado `[x]`, mais uma frase curta do que foi feito nele — não espere terminar tudo para reportar.
Isso é essencial em tarefas longas: o usuário está vendo essas mensagens chegarem em tempo real, e
silêncio prolongado parece uma travada mesmo quando você só está processando um pedido grande —
prefira reportar demais a reportar de menos. Se surgir uma subtarefa nova no meio do caminho,
adicione-a à checklist no próximo envio em vez de omiti-la.

## 4. Formate as respostas para leitura fácil

Depois de investigar (`iris_list_documents`/`iris_read_document`), NUNCA devolva o resultado como um
parágrafo único e denso, com informação empilhada por dois-pontos e vírgulas. Estruture:

- Comece com uma frase curta dizendo o que é o projeto/componente.
- Liste as partes/funcionalidades principais em tópicos (`-`), uma por linha — não espremidas numa
  única frase separada por vírgula.
- Use `código` para nomes de classes, pacotes, rotas e ferramentas (ex: `Wiki.UI`, `/csp/wiki`).
- Se houver partes claramente distintas (ex: backend vs frontend, ou funcionalidades
  independentes), separe cada uma em seu próprio tópico ou sub-seção (`##`/`###`) — não junte tudo.
- Prefira uma resposta um pouco mais longa e organizada a uma resposta curta e densa: o usuário vai
  ler isso com calma, não só escanear.

Exemplo — em vez de responder assim:

> Wiki de conhecimento em Markdown rodando 100% em IRIS (pacote Wiki): CRUD de páginas via REST
> (/csp/wiki), renderização Markdown→HTML, busca e histórico/backlinks, cache+ETag, e chat com IA
> (RAG via embeddings no Ollama + resposta do servidor opencode). Front em HTML/JS gerado por
> Wiki.UI.

responda assim:

> **Wiki de conhecimento em Markdown, 100% dentro do IRIS** (pacote `Wiki`).
>
> - **API REST** (`/csp/wiki`) — CRUD de páginas.
> - **Renderização** — Markdown → HTML.
> - **Busca e navegação** — busca full-text, histórico de versões e backlinks entre páginas.
> - **Performance** — cache com ETag.
> - **Chat com IA** — RAG usando embeddings via Ollama, resposta gerada pelo servidor opencode.
> - **Frontend** — HTML/JS servido por `Wiki.UI`.
"#
    )
}

#[allow(clippy::too_many_arguments)]
fn ensure_project_dir(
    connection_id: &str,
    namespace: &str,
    host: &str,
    port: u16,
    bridge_port: u16,
    bridge_token: &str,
    provider_id: Option<&str>,
    provider_env_var: Option<&str>,
    app: &AppHandle,
) -> Result<PathBuf, String> {
    let dir = project_dir(app, connection_id, namespace)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mcp_bin = mcp_binary_path()?.to_string_lossy().into_owned();

    let mut config = serde_json::json!({
        "$schema": "https://opencode.ai/config.json",
        "mcp": {
            "iris": {
                "type": "local",
                "command": [mcp_bin.clone(), "iris"],
                "environment": { "IRIS_BRIDGE_PORT": bridge_port.to_string(), "IRIS_BRIDGE_TOKEN": bridge_token },
            },
            "specs": {
                "type": "local",
                "command": [mcp_bin, "specs"],
                "environment": { "IRIS_BRIDGE_PORT": bridge_port.to_string(), "IRIS_BRIDGE_TOKEN": bridge_token },
            },
        },
        // `task` denied too: opencode's built-in delegation tool spawns a nested sub-agent turn
        // with no reliable way to show its progress (its own status field settles almost
        // instantly regardless of how long the delegated work actually takes, and no nested
        // events for the child session surface on this stdout at all — confirmed against a real
        // run) — from the UI it just looks like the run silently stopped for minutes. Denying it
        // outright means a blocked call fails fast and visibly instead of the turn quietly
        // stalling on a black box.
        "permission": { "write": "deny", "edit": "deny", "bash": "deny", "task": "deny" },
    });
    if let (Some(provider_id), Some(env_var)) = (provider_id, provider_env_var) {
        if provider_id != "default" {
            config["provider"] = serde_json::json!({ provider_id: { "apiKey": format!("{{env:{env_var}}}") } });
        }
    }
    fs::write(dir.join("opencode.json"), serde_json::to_string_pretty(&config).unwrap())
        .map_err(|e| e.to_string())?;
    fs::write(dir.join("AGENTS.md"), agents_instructions(namespace, host, port)).map_err(|e| e.to_string())?;

    Ok(dir)
}

#[tauri::command]
pub async fn agent_run(
    app: AppHandle,
    connection_id: String,
    namespace: String,
    prompt: String,
    specs_dir: String,
    model: Option<String>,
    session_id: Option<String>,
) -> Result<String, String> {
    // Capping this to one agent at a time app-wide is deliberate — see agentRun.ts's doc comment
    // about license-constrained IRIS session pools.
    if !ACTIVE_RUNS.lock().unwrap().is_empty() {
        return Err(
            "Só um agente pode rodar por vez neste app (para economizar sessões/licença do IRIS). \
             Aguarde a execução atual terminar, ou clique em Parar nela, antes de iniciar uma nova."
                .to_string(),
        );
    }

    let config = crate::connections::resolve_config(&app, &connection_id)?;
    let ai = crate::ai_settings::resolve_run_config(&app);
    if ai.provider_id != "default" && ai.api_key.is_none() {
        return Err(format!(
            "Nenhuma chave de API configurada para o provedor \"{}\". Abra Configurações → \
             Inteligência Artificial e salve a chave antes de rodar o agente.",
            ai.provider_id
        ));
    }

    let run_id = uuid::Uuid::new_v4().to_string();
    let (bridge_port, bridge_token) =
        agent_bridge::register_session(app.clone(), namespace.clone(), config.clone(), run_id.clone(), specs_dir);
    let dir = ensure_project_dir(
        &connection_id,
        &namespace,
        &config.host,
        config.port,
        bridge_port,
        &bridge_token,
        Some(ai.provider_id.as_str()),
        ai.env_var.as_deref(),
        &app,
    )?;

    let model = model.or_else(|| if ai.model.is_empty() { None } else { Some(ai.model.clone()) });
    let mut args: Vec<String> = vec![
        "run".into(),
        "--dir".into(),
        dir.to_string_lossy().into_owned(),
        "--format".into(),
        "json".into(),
        "--thinking".into(),
    ];
    if let Some(model) = &model {
        args.push("--model".into());
        args.push(model.clone());
    }
    if let Some(session_id) = &session_id {
        args.push("--session".into());
        args.push(session_id.clone());
    }
    args.push(prompt);

    let bin = resolve_opencode_binary();
    let mut command = base_command(&bin);
    command.args(&args).current_dir(&dir);
    if let (Some(env_var), Some(api_key)) = (ai.env_var.as_deref(), ai.api_key.as_deref()) {
        command.env(env_var, api_key);
    }
    // stdin must be null, not the default open pipe — opencode blocks trying to read from stdin
    // if it's left open with nothing writing to it and no EOF, hanging forever before producing a
    // single byte of output.
    command.stdin(std::process::Stdio::null());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());

    let mut child = command.spawn().map_err(|e| format!("Não foi possível iniciar o opencode ({}): {e}", bin.display()))?;
    let pid = child.id();
    let stdout = child.stdout.take().expect("piped stdout");
    let mut stderr_pipe = child.stderr.take().expect("piped stderr");
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf).await;
        buf
    });

    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    ACTIVE_RUNS.lock().unwrap().insert(run_id.clone(), ActiveRun { cancel: cancel_tx, bridge_token: bridge_token.clone() });

    let app_events = app.clone();
    let run_id_events = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut latest_session_id: Option<String> = None;
        let mut killed = false;

        loop {
            tokio::select! {
                line = lines.next_line() => {
                    match line {
                        Ok(Some(text)) => {
                            if text.trim().is_empty() { continue; }
                            let _ = app_events.emit(
                                "agent:event",
                                serde_json::json!({ "runId": run_id_events, "line": text, "stderr": false }),
                            );
                            if latest_session_id.is_none() {
                                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) {
                                    if let Some(sid) = parsed.get("sessionID").and_then(|v| v.as_str()) {
                                        latest_session_id = Some(sid.to_string());
                                        let _ = app_events.emit(
                                            "agent:session",
                                            serde_json::json!({ "runId": run_id_events, "sessionId": sid }),
                                        );
                                    }
                                }
                            }
                        }
                        Ok(None) => break,
                        Err(_) => break,
                    }
                }
                _ = &mut cancel_rx => {
                    killed = true;
                    #[cfg(windows)]
                    {
                        // Kills the whole process tree, not just the child — opencode spawns
                        // subprocesses for tool calls, and a plain kill wouldn't touch those.
                        if let Some(pid) = pid {
                            let _ = std::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).spawn();
                        }
                    }
                    #[cfg(not(windows))]
                    { let _ = child.start_kill(); }
                    break;
                }
            }
        }

        let status = child.wait().await;
        let bridge_token = ACTIVE_RUNS.lock().unwrap().remove(&run_id_events).map(|r| r.bridge_token);
        if let Some(token) = bridge_token {
            agent_bridge::end_session(&token);
        }

        if killed {
            let _ = app_events.emit("agent:done", serde_json::json!({ "runId": run_id_events, "code": 1 }));
            return;
        }
        match status {
            Ok(status) if status.success() => {
                let _ = app_events.emit("agent:done", serde_json::json!({ "runId": run_id_events, "code": 0 }));
            }
            _ => {
                let stderr_bytes = stderr_task.await.unwrap_or_default();
                let stderr_text = String::from_utf8_lossy(&stderr_bytes).trim().to_string();
                if !stderr_text.is_empty() {
                    let _ = app_events.emit(
                        "agent:event",
                        serde_json::json!({ "runId": run_id_events, "line": stderr_text, "stderr": true }),
                    );
                }
                let _ = app_events.emit("agent:done", serde_json::json!({ "runId": run_id_events, "code": 1 }));
            }
        }
    });

    Ok(run_id)
}

#[tauri::command]
pub fn agent_abort(run_id: String) -> Result<(), String> {
    // Removing here (rather than leaving it to the run loop) means a second click can't send on
    // an already-fired `cancel` — the run loop's own post-select cleanup only handles the
    // "finished naturally" path once this entry is already gone.
    if let Some(entry) = ACTIVE_RUNS.lock().unwrap().remove(&run_id) {
        let _ = entry.cancel.send(());
        agent_bridge::end_session(&entry.bridge_token);
    }
    Ok(())
}

/// Called on app shutdown — without this, quitting with a run active can leave the child (and its
/// bridge session) running past the app's own lifetime.
pub fn abort_all_agent_runs() {
    let run_ids: Vec<String> = ACTIVE_RUNS.lock().unwrap().keys().cloned().collect();
    for run_id in run_ids {
        let _ = agent_abort(run_id);
    }
}

/// Frontend-facing escape hatch for the "one agent at a time" lock (see `agent_run` above) — if
/// the webview ever loses track of the current `runId` (a reload, a crash, this exact app being
/// iterated on with hot-reload) it has no way to call `agent_abort(runId)` on the run it can no
/// longer name, and the lock would otherwise never clear without restarting the whole app. Clears
/// every tracked run regardless of id, same as the app-shutdown path.
#[tauri::command]
pub fn agent_force_reset() {
    abort_all_agent_runs();
}
