use anyhow::{bail, Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use uuid::Uuid;
use walkdir::WalkDir;

use super::content_hash::list_content_files;
use super::tool_adapters::ToolAdapter;

const SSH_TIMEOUT: &str = "10";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ResolvedSshConfig {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: Option<String>,
    pub proxy_jump: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SkillComparison {
    pub name: String,
    pub state: String,
    pub local_hash: Option<String>,
    pub remote_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteStatusReport {
    pub ssh: ResolvedSshConfig,
    pub local_dir: String,
    pub remote_dir: String,
    pub skills: Vec<SkillComparison>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RemoteAgentDirectory {
    pub key: String,
    pub display_name: String,
    pub path: String,
    pub skill_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncItem {
    pub name: String,
    pub action: String,
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemoteSyncReport {
    pub direction: String,
    pub applied: bool,
    pub force: bool,
    pub local_dir: String,
    pub remote_dir: String,
    pub items: Vec<SyncItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncDirection {
    Pull,
    Push,
}

pub fn resolve_ssh_config(host: &str) -> Result<ResolvedSshConfig> {
    validate_host_alias(host)?;
    let output = Command::new("ssh")
        .args([
            "-G",
            "-o",
            "BatchMode=yes",
            "-o",
            &format!("ConnectTimeout={SSH_TIMEOUT}"),
            host,
        ])
        .output()
        .context("failed to run system ssh; install OpenSSH and ensure ssh is on PATH")?;
    if !output.status.success() {
        bail!(
            "failed to resolve SSH config for {host}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let mut values: BTreeMap<String, String> = BTreeMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some((key, value)) = line.split_once(' ') {
            values
                .entry(key.to_string())
                .or_insert_with(|| value.trim().to_string());
        }
    }
    Ok(ResolvedSshConfig {
        alias: host.to_string(),
        hostname: values.get("hostname").cloned(),
        user: values.get("user").cloned(),
        port: values.get("port").cloned(),
        proxy_jump: values
            .get("proxyjump")
            .filter(|value| value.as_str() != "none")
            .cloned(),
    })
}

pub fn list_ssh_config_hosts() -> Result<Vec<ResolvedSshConfig>> {
    let Some(home) = dirs::home_dir() else {
        bail!("cannot determine home directory");
    };
    let config = home.join(".ssh/config");
    if !config.is_file() {
        return Ok(Vec::new());
    }
    let mut aliases = BTreeSet::new();
    collect_ssh_aliases(&config, &mut BTreeSet::new(), &mut aliases)?;
    Ok(aliases
        .into_iter()
        .filter_map(|alias| resolve_ssh_config(&alias).ok())
        .collect())
}

fn collect_ssh_aliases(
    config: &Path,
    visited: &mut BTreeSet<PathBuf>,
    aliases: &mut BTreeSet<String>,
) -> Result<()> {
    let canonical = fs::canonicalize(config).unwrap_or_else(|_| config.to_path_buf());
    if !visited.insert(canonical) {
        return Ok(());
    }
    let content = fs::read_to_string(config)
        .with_context(|| format!("failed to read SSH config: {}", config.display()))?;
    let base = config.parent().unwrap_or(Path::new("."));
    for raw_line in content.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        let mut fields = line.split_whitespace();
        let Some(keyword) = fields.next() else {
            continue;
        };
        if keyword.eq_ignore_ascii_case("host") {
            for alias in fields {
                if !alias.contains(|ch| matches!(ch, '*' | '?' | '!'))
                    && validate_host_alias(alias).is_ok()
                {
                    aliases.insert(alias.to_string());
                }
            }
        } else if keyword.eq_ignore_ascii_case("include") {
            for pattern in fields {
                for included in expand_include_pattern(
                    pattern.trim_matches(|ch| matches!(ch, '\'' | '"')),
                    base,
                ) {
                    collect_ssh_aliases(&included, visited, aliases)?;
                }
            }
        }
    }
    Ok(())
}

fn expand_include_pattern(pattern: &str, base: &Path) -> Vec<PathBuf> {
    let expanded = if pattern == "~" {
        dirs::home_dir().unwrap_or_else(|| base.to_path_buf())
    } else if let Some(suffix) = pattern.strip_prefix("~/") {
        dirs::home_dir()
            .unwrap_or_else(|| base.to_path_buf())
            .join(suffix)
    } else {
        let path = PathBuf::from(pattern);
        if path.is_absolute() {
            path
        } else {
            base.join(path)
        }
    };
    let Some(name) = expanded.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    if !name.contains(|ch| matches!(ch, '*' | '?')) {
        return expanded.is_file().then_some(expanded).into_iter().collect();
    }
    // ponytail: OpenSSH allows wildcards in parent components too; support the
    // common config.d/*.conf form until a real-world config needs nested globs.
    let Some(parent) = expanded.parent() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut paths: Vec<_> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| wildcard_matches(name, value))
        })
        .collect();
    paths.sort();
    paths
}

fn wildcard_matches(pattern: &str, value: &str) -> bool {
    let (pattern, value) = (pattern.as_bytes(), value.as_bytes());
    let (mut p, mut v, mut star, mut retry) = (0, 0, None, 0);
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = v;
        } else if let Some(star_index) = star {
            p = star_index + 1;
            retry += 1;
            v = retry;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

pub fn status(host: &str, remote_dir: &str, local_dir: &Path) -> Result<RemoteStatusReport> {
    let ssh = resolve_ssh_config(host)?;
    validate_remote_root(remote_dir)?;
    let local = scan_local(local_dir)?;
    let remote = scan_remote(host, remote_dir)?;
    Ok(RemoteStatusReport {
        ssh,
        local_dir: local_dir.to_string_lossy().into_owned(),
        remote_dir: remote_dir.to_string(),
        skills: compare(&local, &remote),
    })
}

fn remote_adapter_dirs(adapter: &ToolAdapter, local_home: &Path) -> Option<(String, String)> {
    if let Some(path) = &adapter.override_skills_dir {
        if let Ok(relative) = Path::new(path).strip_prefix(local_home) {
            let relative = relative.to_string_lossy().trim_matches('/').to_string();
            if !relative.is_empty() {
                return Some((relative.clone(), relative));
            }
        }
        if adapter.is_custom {
            return None;
        }
    }
    if adapter.relative_skills_dir.is_empty() || adapter.relative_detect_dir.is_empty() {
        return None;
    }
    Some((
        adapter.relative_skills_dir.clone(),
        adapter.relative_detect_dir.clone(),
    ))
}

pub fn discover_agent_directories(
    host: &str,
    adapters: &[ToolAdapter],
) -> Result<Vec<RemoteAgentDirectory>> {
    resolve_ssh_config(host)?;
    let local_home = dirs::home_dir().context("cannot determine local home directory")?;
    let mut command = String::from("set -eu\n");
    for adapter in adapters {
        let Some((skills_dir, detect_dir)) = remote_adapter_dirs(adapter, &local_home) else {
            continue;
        };
        let remote_path = format!("~/{skills_dir}");
        validate_remote_root(&remote_path)?;
        let display_name = adapter.display_name.replace(['\t', '\n', '\r'], " ");
        command.push_str(&format!(
            "skills=\"$HOME\"/{skills}; detect=\"$HOME\"/{detect}; if [ -d \"$detect\" ]; then count=0; [ ! -d \"$skills\" ] || count=$(find \"$skills\" -type f -name SKILL.md 2>/dev/null | wc -l | tr -d ' '); printf '%s\\t%s\\t%s\\t%s\\n' {key} {name} {path} \"$count\"; fi\n",
            detect = shell_quote(&detect_dir),
            skills = shell_quote(&skills_dir),
            key = shell_quote(&adapter.key),
            name = shell_quote(&display_name),
            path = shell_quote(&remote_path),
        ));
    }
    let output = ssh_output(host, &command)?;
    if !output.status.success() {
        bail!(
            "remote Agent discovery failed for {host}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let mut agents = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() != 4 {
            bail!("invalid remote Agent discovery line: {line}");
        }
        validate_remote_root(fields[2])?;
        agents.push(RemoteAgentDirectory {
            key: fields[0].to_string(),
            display_name: fields[1].to_string(),
            path: fields[2].to_string(),
            skill_count: fields[3].parse().unwrap_or(0),
        });
    }
    Ok(agents)
}

pub fn sync(
    direction: SyncDirection,
    host: &str,
    remote_dir: &str,
    local_dir: &Path,
    skill: Option<&str>,
    apply: bool,
    force: bool,
) -> Result<RemoteSyncReport> {
    let report = status(host, remote_dir, local_dir)?;
    if let Some(skill) = skill {
        validate_skill_name(skill)?;
    }

    let mut items = Vec::new();
    for comparison in report
        .skills
        .iter()
        .filter(|item| skill.map_or(true, |selected| item.name == selected))
    {
        let (action, allowed) = planned_action(direction, &comparison.state, force);
        if action == "skip" {
            continue;
        }
        if !allowed {
            items.push(SyncItem {
                name: comparison.name.clone(),
                action: action.to_string(),
                result: "conflict".to_string(),
                backup_path: None,
            });
            continue;
        }
        if !apply {
            items.push(SyncItem {
                name: comparison.name.clone(),
                action: action.to_string(),
                result: "planned".to_string(),
                backup_path: None,
            });
            continue;
        }

        let backup_path = match direction {
            SyncDirection::Pull => pull_one(host, remote_dir, local_dir, &comparison.name, force)?,
            SyncDirection::Push => push_one(host, remote_dir, local_dir, &comparison.name, force)?,
        };
        items.push(SyncItem {
            name: comparison.name.clone(),
            action: action.to_string(),
            result: "applied".to_string(),
            backup_path,
        });
    }

    if let Some(skill) = skill {
        if !report.skills.iter().any(|item| item.name == skill) {
            bail!("skill not found locally or remotely: {skill}");
        }
    }
    Ok(RemoteSyncReport {
        direction: match direction {
            SyncDirection::Pull => "pull",
            SyncDirection::Push => "push",
        }
        .to_string(),
        applied: apply,
        force,
        local_dir: report.local_dir,
        remote_dir: report.remote_dir,
        items,
    })
}

fn planned_action(direction: SyncDirection, state: &str, force: bool) -> (&'static str, bool) {
    match (direction, state) {
        (_, "equal") => ("skip", true),
        (SyncDirection::Pull, "remote_only") => ("create_local", true),
        (SyncDirection::Push, "local_only") => ("create_remote", true),
        (SyncDirection::Pull, "different") => ("replace_local", force),
        (SyncDirection::Push, "different") => ("replace_remote", force),
        _ => ("skip", true),
    }
}

fn compare(
    local: &BTreeMap<String, String>,
    remote: &BTreeMap<String, String>,
) -> Vec<SkillComparison> {
    let names: BTreeSet<_> = local.keys().chain(remote.keys()).cloned().collect();
    names
        .into_iter()
        .map(|name| {
            let local_hash = local.get(&name).cloned();
            let remote_hash = remote.get(&name).cloned();
            let state = match (&local_hash, &remote_hash) {
                (Some(left), Some(right)) if left == right => "equal",
                (Some(_), Some(_)) => "different",
                (Some(_), None) => "local_only",
                (None, Some(_)) => "remote_only",
                (None, None) => unreachable!(),
            };
            SkillComparison {
                name,
                state: state.to_string(),
                local_hash,
                remote_hash,
            }
        })
        .collect()
}

fn scan_local(root: &Path) -> Result<BTreeMap<String, String>> {
    if !root.exists() {
        return Ok(BTreeMap::new());
    }
    if !root.is_dir() {
        bail!("local skills path is not a directory: {}", root.display());
    }
    let mut result = BTreeMap::new();
    for entry in fs::read_dir(root)
        .with_context(|| format!("failed to read local skills directory: {}", root.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() || !path.join("SKILL.md").is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        validate_skill_name(&name)?;
        result.insert(name, hash_local_skill(&path)?);
    }
    Ok(result)
}

fn hash_local_skill(path: &Path) -> Result<String> {
    let mut entries = Vec::new();
    for entry in list_content_files(path) {
        let content = fs::read(&entry.path)
            .with_context(|| format!("failed to read {}", entry.path.display()))?;
        let executable = entry.is_executable();
        entries.push((
            entry.relative_path,
            hex::encode(Sha256::digest(content)),
            executable,
        ));
    }
    Ok(hash_manifest(&entries))
}

fn scan_remote(host: &str, root: &str) -> Result<BTreeMap<String, String>> {
    let command = format!(
        r#"root={root}
case "$root" in "~") root="$HOME" ;; "~/"*) root="$HOME/${{root#??}}" ;; esac
[ -d "$root" ] || exit 0
cd "$root" || exit 1
if command -v sha256sum >/dev/null 2>&1; then hash_tool=sha256sum
elif command -v shasum >/dev/null 2>&1; then hash_tool=shasum
else printf '%s\n' 'remote requires sha256sum or shasum' >&2; exit 127
fi
for skill_md in ./*/SKILL.md; do
  [ -f "$skill_md" ] || continue
  skill_dir=${{skill_md%/SKILL.md}}
  skill=${{skill_dir#./}}
  find "$skill_dir" \( -name .git -o -name __pycache__ \) -prune -o -type f \
    ! -name .DS_Store ! -name Thumbs.db ! -name .gitignore ! -name '*.pyc' -print |
  LC_ALL=C sort |
  while IFS= read -r file; do
    if [ "$hash_tool" = sha256sum ]; then digest=$(sha256sum "$file"); else digest=$(shasum -a 256 "$file"); fi
    digest=${{digest%% *}}
    executable=0; [ -x "$file" ] && executable=1
    relative=${{file#"$skill_dir"/}}
    printf '%s\t%s\t%s\t%s\n' "$skill" "$relative" "$digest" "$executable"
  done
done"#,
        root = shell_quote(root)
    );
    let output = ssh_output(host, &command)?;
    if !output.status.success() {
        bail!(
            "remote scan failed for {host}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }

    let mut manifests: BTreeMap<String, Vec<(String, String, bool)>> = BTreeMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() != 4 {
            bail!("invalid remote manifest line: {line}");
        }
        validate_skill_name(fields[0])?;
        manifests.entry(fields[0].to_string()).or_default().push((
            fields[1].to_string(),
            fields[2].to_string(),
            fields[3] == "1",
        ));
    }
    Ok(manifests
        .into_iter()
        .map(|(name, entries)| (name, hash_manifest(&entries)))
        .collect())
}

fn hash_manifest(entries: &[(String, String, bool)]) -> String {
    let mut entries = entries.to_vec();
    entries.sort_by(|left, right| left.0.cmp(&right.0));
    let mut hasher = Sha256::new();
    for (path, file_hash, executable) in entries {
        hasher.update(path.as_bytes());
        hasher.update(file_hash.as_bytes());
        hasher.update([u8::from(executable)]);
    }
    hex::encode(hasher.finalize())
}

fn pull_one(
    host: &str,
    remote_root: &str,
    local_root: &Path,
    skill: &str,
    force: bool,
) -> Result<Option<String>> {
    validate_skill_name(skill)?;
    fs::create_dir_all(local_root)?;
    let staging = tempfile::tempdir_in(local_root)?;
    let source = format!("{host}:{remote_root}/{skill}");
    run_scp(&source, staging.path().as_os_str())?;
    let downloaded = staging.path().join(skill);
    if !downloaded.join("SKILL.md").is_file() {
        bail!("downloaded skill has no SKILL.md: {skill}");
    }
    reject_symlinks(&downloaded)?;

    let target = local_root.join(skill);
    let backup = if target.exists() {
        if !force {
            bail!("local skill already exists; review status and rerun with --force");
        }
        let backup = local_root.join(format!(
            ".skills-manager-backup-{skill}-{}",
            Uuid::new_v4().simple()
        ));
        fs::rename(&target, &backup)?;
        Some(backup)
    } else {
        None
    };
    if let Err(error) = fs::rename(&downloaded, &target) {
        if let Some(backup) = &backup {
            let _ = fs::rename(backup, &target);
        }
        return Err(error).with_context(|| format!("failed to install {}", target.display()));
    }
    Ok(backup.map(|path| path.to_string_lossy().into_owned()))
}

fn push_one(
    host: &str,
    remote_root: &str,
    local_root: &Path,
    skill: &str,
    force: bool,
) -> Result<Option<String>> {
    validate_skill_name(skill)?;
    let source = local_root.join(skill);
    if !source.join("SKILL.md").is_file() {
        bail!("local skill has no SKILL.md: {}", source.display());
    }
    reject_symlinks(&source)?;

    let nonce = Uuid::new_v4().simple().to_string();
    let temp_name = format!(".skills-manager-upload-{nonce}");
    let prepare = format!(
        r#"root={root}; case "$root" in "~") root="$HOME" ;; "~/"*) root="$HOME/${{root#??}}" ;; esac; mkdir -p "$root""#,
        root = shell_quote(remote_root)
    );
    ensure_ssh_success(host, &prepare, "prepare remote skills directory")?;
    let destination = format!("{host}:{remote_root}/{temp_name}");
    run_scp(source.as_os_str(), destination.as_str())?;

    let install = format!(
        r#"set -eu
root={root}; name={name}; temp_name={temp_name}; force={force}; nonce={nonce}
case "$root" in "~") root="$HOME" ;; "~/"*) root="$HOME/${{root#??}}" ;; esac
temp="$root/$temp_name"; target="$root/$name"; backup=""
test -f "$temp/SKILL.md"
if [ -e "$target" ]; then
  [ "$force" = 1 ] || {{ printf '%s\n' 'remote skill already exists' >&2; exit 3; }}
  backup="$root/.skills-manager-backup-$name-$nonce"
  mv "$target" "$backup"
fi
if ! mv "$temp" "$target"; then
  [ -z "$backup" ] || mv "$backup" "$target"
  exit 4
fi
printf '%s\n' "$backup""#,
        root = shell_quote(remote_root),
        name = shell_quote(skill),
        temp_name = shell_quote(&temp_name),
        force = if force { 1 } else { 0 },
        nonce = shell_quote(&nonce),
    );
    let output = ssh_output(host, &install)?;
    if !output.status.success() {
        bail!(
            "failed to install remote skill: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let backup = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!backup.is_empty()).then_some(backup))
}

fn run_scp(
    source: impl AsRef<std::ffi::OsStr>,
    destination: impl AsRef<std::ffi::OsStr>,
) -> Result<()> {
    let output = Command::new("scp")
        .args([
            "-r",
            "-o",
            "BatchMode=yes",
            "-o",
            &format!("ConnectTimeout={SSH_TIMEOUT}"),
        ])
        .arg(source)
        .arg(destination)
        .output()
        .context("failed to run system scp")?;
    if !output.status.success() {
        bail!(
            "scp failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

fn reject_symlinks(path: &Path) -> Result<()> {
    for entry in WalkDir::new(path).follow_links(false) {
        let entry = entry?;
        if entry.file_type().is_symlink() {
            bail!("refusing to sync symlink: {}", entry.path().display());
        }
    }
    Ok(())
}

fn ssh_output(host: &str, command: &str) -> Result<std::process::Output> {
    validate_host_alias(host)?;
    Command::new("ssh")
        .args([
            "-o",
            "BatchMode=yes",
            "-o",
            &format!("ConnectTimeout={SSH_TIMEOUT}"),
            host,
            command,
        ])
        .output()
        .with_context(|| format!("failed to connect with SSH config host '{host}'"))
}

fn ensure_ssh_success(host: &str, command: &str, action: &str) -> Result<()> {
    let output = ssh_output(host, command)?;
    if !output.status.success() {
        bail!(
            "failed to {action}: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn validate_host_alias(host: &str) -> Result<()> {
    if host.is_empty()
        || host.starts_with('-')
        || !host
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        bail!("SSH host must be a safe Host alias from ~/.ssh/config");
    }
    Ok(())
}

fn validate_remote_root(path: &str) -> Result<()> {
    if path.is_empty()
        || !path
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '~' | '/' | '.' | '_' | '-'))
    {
        bail!("remote skills directory must be a simple absolute or ~/ path");
    }
    Ok(())
}

fn validate_skill_name(name: &str) -> Result<()> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
    {
        bail!("skill name must be one safe directory segment: {name}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::tool_adapters::default_tool_adapters;
    use tempfile::tempdir;

    #[test]
    fn compares_all_sync_states() {
        let local = BTreeMap::from([
            ("equal".to_string(), "a".to_string()),
            ("local".to_string(), "b".to_string()),
            ("changed".to_string(), "c".to_string()),
        ]);
        let remote = BTreeMap::from([
            ("equal".to_string(), "a".to_string()),
            ("remote".to_string(), "d".to_string()),
            ("changed".to_string(), "e".to_string()),
        ]);
        let states: BTreeMap<_, _> = compare(&local, &remote)
            .into_iter()
            .map(|item| (item.name, item.state))
            .collect();
        assert_eq!(states["equal"], "equal");
        assert_eq!(states["local"], "local_only");
        assert_eq!(states["remote"], "remote_only");
        assert_eq!(states["changed"], "different");
    }

    #[test]
    fn local_hash_covers_supporting_files() {
        let temp = tempdir().unwrap();
        fs::write(temp.path().join("SKILL.md"), "hello").unwrap();
        let before = hash_local_skill(temp.path()).unwrap();
        fs::write(temp.path().join("script.sh"), "echo hi").unwrap();
        assert_ne!(before, hash_local_skill(temp.path()).unwrap());
    }

    #[test]
    fn rejects_option_and_path_injection() {
        assert_eq!(shell_quote("a'b"), "'a'\"'\"'b'");
        assert!(validate_host_alias("prod-box").is_ok());
        assert!(validate_host_alias("-oProxyCommand=bad").is_err());
        assert!(validate_remote_root("~/.codex/skills").is_ok());
        assert!(validate_remote_root("~/skills;rm").is_err());
        assert!(validate_skill_name("../../bad").is_err());
    }

    #[test]
    fn remote_agent_catalog_reuses_local_adapters() {
        let adapters = default_tool_adapters();
        assert!(adapters
            .iter()
            .any(|item| { item.key == "codex" && item.relative_skills_dir == ".codex/skills" }));
        assert!(adapters.iter().any(|item| {
            item.key == "openclaw" && item.relative_skills_dir == ".openclaw/skills"
        }));

        let mut codex = adapters
            .into_iter()
            .find(|item| item.key == "codex")
            .unwrap();
        assert_eq!(
            remote_adapter_dirs(&codex, Path::new("/Users/test")),
            Some((".codex/skills".into(), ".codex".into()))
        );
        codex.override_skills_dir = Some("/Users/test/.shared/skills".into());
        assert_eq!(
            remote_adapter_dirs(&codex, Path::new("/Users/test")),
            Some((".shared/skills".into(), ".shared/skills".into()))
        );
    }

    #[test]
    fn ssh_config_discovery_follows_includes_and_ignores_patterns() {
        let temp = tempdir().unwrap();
        let includes = temp.path().join("config.d");
        fs::create_dir(&includes).unwrap();
        fs::write(
            temp.path().join("config"),
            "Host prod *.internal !blocked\nInclude config.d/*.conf\n",
        )
        .unwrap();
        fs::write(includes.join("work.conf"), "Host work jump-box\n").unwrap();
        let mut aliases = BTreeSet::new();
        collect_ssh_aliases(
            &temp.path().join("config"),
            &mut BTreeSet::new(),
            &mut aliases,
        )
        .unwrap();
        assert_eq!(
            aliases,
            BTreeSet::from(["jump-box".into(), "prod".into(), "work".into()])
        );
        assert!(wildcard_matches("*.conf", "work.conf"));
    }
}
