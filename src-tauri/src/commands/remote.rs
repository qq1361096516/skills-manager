use crate::core::{central_repo, error::AppError, remote_sync};

#[tauri::command]
pub async fn ssh_config_hosts() -> Result<Vec<remote_sync::ResolvedSshConfig>, AppError> {
    tokio::task::spawn_blocking(|| remote_sync::list_ssh_config_hosts().map_err(AppError::internal))
        .await?
}

#[tauri::command]
pub async fn remote_agent_directories(
    host: String,
) -> Result<Vec<remote_sync::RemoteAgentDirectory>, AppError> {
    tokio::task::spawn_blocking(move || {
        remote_sync::discover_agent_directories(host.trim()).map_err(AppError::internal)
    })
    .await?
}

#[tauri::command]
pub async fn remote_skill_status(
    host: String,
    remote_dir: String,
) -> Result<remote_sync::RemoteStatusReport, AppError> {
    let local_dir = central_repo::skills_dir();
    tokio::task::spawn_blocking(move || {
        remote_sync::status(host.trim(), remote_dir.trim(), &local_dir).map_err(AppError::internal)
    })
    .await?
}

#[tauri::command]
pub async fn remote_skill_sync(
    direction: String,
    host: String,
    remote_dir: String,
    force: bool,
) -> Result<remote_sync::RemoteSyncReport, AppError> {
    let direction = match direction.as_str() {
        "pull" => remote_sync::SyncDirection::Pull,
        "push" => remote_sync::SyncDirection::Push,
        _ => return Err(AppError::invalid_input("direction must be pull or push")),
    };
    let local_dir = central_repo::skills_dir();
    tokio::task::spawn_blocking(move || {
        remote_sync::sync(
            direction,
            host.trim(),
            remote_dir.trim(),
            &local_dir,
            None,
            true,
            force,
        )
        .map_err(AppError::internal)
    })
    .await?
}
