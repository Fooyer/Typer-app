//! Rust port of `electron/specs.ts`. "Specs" (.md planning/notes files) are plain local files
//! rather than IRIS server documents — see the original file's doc comment for why.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
pub struct SpecFileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "modifiedAt")]
    pub modified_at: f64,
}

fn default_specs_dir(app: &AppHandle, connection_id: &str, namespace: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("specs").join(connection_id).join(namespace))
}

struct SddTemplateFile {
    name: &'static str,
    content: &'static str,
}

const SDD_TEMPLATE_FILES: &[SddTemplateFile] = &[
    SddTemplateFile {
        name: "00-constituicao.md",
        content: "# Constituição do Projeto\n\nPrincípios e restrições que não mudam de uma tarefa para outra. Preencha isso primeiro — as demais\nspecs devem respeitar o que está aqui.\n\n## Objetivo do projeto\n[Uma ou duas frases sobre o que este projeto/namespace faz e para quem.]\n\n## Princípios\n- [Ex: compatibilidade retroativa é obrigatória em APIs públicas]\n- [Ex: toda classe nova segue o padrão de nomenclatura Pacote.Subpacote.Nome]\n\n## Restrições técnicas\n- [Ex: versão mínima do IRIS, dependências permitidas, padrões de log/erro]\n\n## Fora de escopo\n- [O que este projeto deliberadamente não faz]\n",
    },
    SddTemplateFile {
        name: "01-especificacao.md",
        content: "# Especificação\n\nO que precisa ser construído e por quê — em linguagem de negócio/usuário, sem detalhe de\nimplementação (isso vai no plano).\n\n## Problema\n[Que problema real está sendo resolvido?]\n\n## Requisitos funcionais\n- [ ] [O sistema deve...]\n- [ ] [O sistema deve...]\n\n## Requisitos não funcionais\n- [Ex: performance, segurança, auditoria]\n\n## Critérios de aceite\n- [Como saber que está pronto?]\n\n## Fora de escopo\n- [O que esta spec explicitamente não cobre]\n",
    },
    SddTemplateFile {
        name: "02-plano.md",
        content: "# Plano Técnico\n\nComo a especificação será implementada.\n\n## Abordagem\n[Visão geral da solução técnica.]\n\n## Classes / rotinas envolvidas\n- [Pacote.Classe — responsabilidade]\n\n## Modelo de dados\n[Novas propriedades, índices, relacionamentos, se houver.]\n\n## Decisões e alternativas consideradas\n- [Decisão] — [por quê, o que foi descartado e por quê]\n\n## Riscos\n- [O que pode dar errado e como mitigar]\n",
    },
    SddTemplateFile {
        name: "03-tarefas.md",
        content: "# Tarefas\n\nChecklist executável derivado do plano. Marque conforme for concluindo.\n\n## Fase 1\n- [ ] [Tarefa]\n- [ ] [Tarefa]\n\n## Fase 2\n- [ ] [Tarefa]\n\n## Validação\n- [ ] [Como testar/validar o resultado]\n",
    },
    SddTemplateFile {
        name: "04-notas.md",
        content: "# Notas e Decisões\n\nLog livre de pesquisa, dúvidas em aberto e decisões tomadas ao longo do caminho — o que não cabe\nnos documentos formais acima.\n\n## Perguntas em aberto\n- [Pergunta]\n\n## Decisões tomadas\n- [Data] — [decisão e motivo]\n",
    },
];

/// Writes the SDD scaffold into `dir`, skipping any file that already exists.
pub fn seed_sdd_scaffold(dir: &Path) -> Result<(), String> {
    for file in SDD_TEMPLATE_FILES {
        let path = dir.join(file.name);
        if path.exists() {
            continue;
        }
        fs::write(&path, file.content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn specs_seed_sdd_template(dir: String) -> Result<(), String> {
    seed_sdd_scaffold(Path::new(&dir))
}

/// Creates the directory (default or a previously chosen custom one) if needed and returns its
/// absolute path. Newly-created folders (never one that already existed) are seeded with the SDD
/// template.
#[tauri::command]
pub fn specs_resolve_dir(
    app: AppHandle,
    connection_id: String,
    namespace: String,
    custom_dir: Option<String>,
) -> Result<String, String> {
    let dir = match custom_dir.filter(|d| !d.trim().is_empty()) {
        Some(custom) => PathBuf::from(custom),
        None => default_specs_dir(&app, &connection_id, &namespace)?,
    };
    let already_existed = dir.exists();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if !already_existed {
        seed_sdd_scaffold(&dir)?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn specs_list(dir: String) -> Result<Vec<SpecFileEntry>, String> {
    let dir = PathBuf::from(dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.to_lowercase().ends_with(".md") {
            continue;
        }
        let modified_at = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        files.push(SpecFileEntry { name, path: path.to_string_lossy().into_owned(), modified_at });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

#[tauri::command]
pub fn specs_read(file_path: String) -> Result<String, String> {
    fs::read_to_string(file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn specs_write(file_path: String, content: String) -> Result<(), String> {
    fs::write(file_path, content).map_err(|e| e.to_string())
}

fn ensure_md_extension(name: &str) -> String {
    if name.to_lowercase().ends_with(".md") { name.to_string() } else { format!("{name}.md") }
}

/// Rejects anything but a bare file name — no `/`, `\`, or `..` segments — since the list this
/// backs is deliberately flat.
fn sanitize_file_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed == "."
        || trimmed == ".."
    {
        return Err(format!("Nome de arquivo inválido: \"{name}\"."));
    }
    Ok(trimmed.to_string())
}

/// Sanitizes a bare file name and ensures it ends in `.md` — shared by create/rename and the
/// agent's write tool (see `agent_bridge.rs`) so all three enforce the same "flat, .md-only" rule.
pub fn resolve_spec_file_name(name: &str) -> Result<String, String> {
    Ok(ensure_md_extension(&sanitize_file_name(name)?))
}

#[tauri::command]
pub fn specs_create(dir: String, name: String) -> Result<String, String> {
    let file_name = ensure_md_extension(&sanitize_file_name(&name)?);
    let path = PathBuf::from(&dir).join(&file_name);
    if path.exists() {
        return Err(format!("\"{file_name}\" já existe."));
    }
    fs::write(&path, "").map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn specs_delete(file_path: String) -> Result<(), String> {
    fs::remove_file(file_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn specs_rename(file_path: String, new_name: String) -> Result<String, String> {
    let file_name = ensure_md_extension(&sanitize_file_name(&new_name)?);
    let old_path = PathBuf::from(&file_path);
    let new_path = old_path.parent().unwrap_or(Path::new("")).join(&file_name);
    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn specs_choose_directory(
    app: AppHandle,
    current_dir: Option<String>,
) -> Result<Option<String>, String> {
    crate::dialogs::choose_directory(app, current_dir).await
}
