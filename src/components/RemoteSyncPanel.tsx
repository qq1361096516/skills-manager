import { useCallback, useEffect, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Bot, Loader2, Plus, RefreshCw, Save, Server, Trash2 } from "lucide-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import * as api from "../lib/tauri";
import { getErrorMessage } from "../lib/error";
import { cn } from "../utils";

const fieldClass = "h-8 rounded-md border border-border bg-background px-2.5 text-[13px] text-primary outline-none focus:border-accent";
const buttonClass = "inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium outline-none disabled:cursor-not-allowed disabled:opacity-50";

interface RemoteProfile {
  id: string;
  name: string;
  host: string;
  remoteDir: string;
}

const createProfile = (name = "Remote 1"): RemoteProfile => ({
  id: crypto.randomUUID(),
  name,
  host: "",
  remoteDir: "~/.codex/skills",
});

export function RemoteSyncPanel() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<RemoteProfile[]>(() => [createProfile()]);
  const [selectedId, setSelectedId] = useState("");
  const [sshHosts, setSshHosts] = useState<api.SshConfigHost[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [force, setForce] = useState(false);
  const [agents, setAgents] = useState<api.RemoteAgentDirectory[]>([]);
  const [report, setReport] = useState<api.RemoteStatusReport | null>(null);
  const [loading, setLoading] = useState<"hosts" | "agents" | "status" | "pull" | "push" | null>(null);

  const loadSshHosts = useCallback(async () => {
    setLoading("hosts");
    try {
      const hosts = await api.sshConfigHosts();
      setSshHosts(hosts);
    } catch (error) {
      toast.error(getErrorMessage(error, t("common.error")));
    } finally {
      setLoading(null);
    }
  }, [t]);

  useEffect(() => {
    void loadSshHosts();
    Promise.all([
      api.getSettings("remote_sync_profiles"),
      api.getSettings("remote_sync_selected"),
      api.getSettings("remote_sync_host"),
      api.getSettings("remote_sync_dir"),
    ]).then(([raw, savedId, legacyHost, legacyDir]) => {
      let saved: RemoteProfile[] = [];
      try {
        const parsed = JSON.parse(raw || "[]");
        if (Array.isArray(parsed)) {
          saved = parsed.filter((item): item is RemoteProfile =>
            typeof item?.id === "string" && typeof item?.name === "string" &&
            typeof item?.host === "string" && typeof item?.remoteDir === "string"
          );
        }
      } catch { /* use the legacy single profile */ }
      if (saved.length === 0) {
        saved = [{
          ...createProfile(),
          name: legacyHost?.trim() || "Remote 1",
          host: legacyHost?.trim() || "",
          remoteDir: legacyDir?.trim() || "~/.codex/skills",
        }];
      }
      setProfiles(saved);
      setSelectedId(saved.some((item) => item.id === savedId) ? savedId! : saved[0].id);
    }).catch(() => {});
  }, [loadSshHosts]);

  const active = profiles.find((profile) => profile.id === selectedId) ?? profiles[0];
  const availableSshHosts = sshHosts.filter((host) =>
    !profiles.some((profile) => profile.host === host.alias)
  );
  const savedProfiles = profiles.filter((profile) => profile.host.trim());

  const updateActive = (patch: Partial<RemoteProfile>) => {
    setProfiles((current) => current.map((profile) =>
      profile.id === active.id ? { ...profile, ...patch } : profile
    ));
    if (patch.host !== undefined) setAgents([]);
    setReport(null);
  };

  const persistProfiles = async (next = profiles, nextSelectedId = active.id) => {
    const selected = next.find((profile) => profile.id === nextSelectedId) ?? next[0];
    await Promise.all([
      api.setSettings("remote_sync_profiles", JSON.stringify(next)),
      api.setSettings("remote_sync_selected", selected.id),
      api.setSettings("remote_sync_host", selected.host.trim()),
      api.setSettings("remote_sync_dir", selected.remoteDir.trim()),
    ]);
  };

  const addManualProfile = () => {
    const blank = profiles.find((profile) => !profile.host.trim());
    if (blank) {
      setSelectedId(blank.id);
      setManualOpen(true);
      setAdvancedOpen(true);
      return;
    }
    const profile = createProfile(t("settings.remoteSync.profileDefault", { count: profiles.length + 1 }));
    setProfiles((current) => [...current, profile]);
    setSelectedId(profile.id);
    setManualOpen(true);
    setAdvancedOpen(true);
    setAgents([]);
    setReport(null);
  };

  const addSshHost = (alias: string) => {
    const host = sshHosts.find((item) => item.alias === alias);
    if (!host || profiles.some((profile) => profile.host === host.alias)) return;
    const profile = { ...createProfile(host.alias), host: host.alias };
    const replaceBlank = profiles.length === 1 && !profiles[0].host.trim();
    const next = replaceBlank ? [profile] : [...profiles, profile];
    setProfiles(next);
    setSelectedId(profile.id);
    setManualOpen(false);
    setAdvancedOpen(false);
    setAgents([]);
    setReport(null);
    void persistProfiles(next, profile.id);
  };

  const removeProfile = async () => {
    if (!await confirm(t("settings.remoteSync.removeConfirm"))) return;
    const remaining = profiles.filter((profile) => profile.id !== active.id);
    const next = remaining.length > 0 ? remaining : [createProfile()];
    setProfiles(next);
    setSelectedId(next[0].id);
    setManualOpen(false);
    setAdvancedOpen(false);
    setAgents([]);
    setReport(null);
    await persistProfiles(next, next[0].id);
  };

  const refresh = async () => {
    if (!active.host.trim() || !active.remoteDir.trim()) return;
    setLoading("status");
    try {
      await persistProfiles();
      const next = await api.remoteSkillStatus(active.host.trim(), active.remoteDir.trim());
      setReport(next);
    } catch (error) {
      toast.error(getErrorMessage(error, t("common.error")));
    } finally {
      setLoading(null);
    }
  };

  const discoverAgents = async () => {
    if (!active.host.trim()) return;
    setLoading("agents");
    try {
      const found = await api.remoteAgentDirectories(active.host.trim());
      setAgents(found);
      if (found.length === 0) {
        toast.info(t("settings.remoteSync.noAgents"));
      } else {
        const selectedPath = found.some((agent) => agent.path === active.remoteDir)
          ? active.remoteDir
          : found[0].path;
        const nextProfiles = profiles.map((profile) =>
          profile.id === active.id ? { ...profile, remoteDir: selectedPath } : profile
        );
        setProfiles(nextProfiles);
        await persistProfiles(nextProfiles, active.id);
        toast.success(t("settings.remoteSync.agentsFound", { count: found.length }));
      }
      setReport(null);
    } catch (error) {
      toast.error(getErrorMessage(error, t("common.error")));
    } finally {
      setLoading(null);
    }
  };

  const runSync = async (direction: "pull" | "push") => {
    const accepted = await confirm(t(`settings.remoteSync.confirm.${direction}`), {
      title: t("settings.remoteSync.title"),
      kind: "warning",
    });
    if (!accepted) return;
    setLoading(direction);
    try {
      const result = await api.remoteSkillSync(direction, active.host.trim(), active.remoteDir.trim(), force);
      const applied = result.items.filter((item) => item.result === "applied").length;
      const conflicts = result.items.filter((item) => item.result === "conflict").length;
      toast.success(t("settings.remoteSync.done", { applied, conflicts }));
      setReport(await api.remoteSkillStatus(active.host.trim(), active.remoteDir.trim()));
    } catch (error) {
      toast.error(getErrorMessage(error, t("common.error")));
    } finally {
      setLoading(null);
    }
  };

  const canSync = report && !loading;

  return (
    <section>
      <h2 className="app-section-title mb-3">{t("settings.remoteSync.title")}</h2>
      <div className="app-panel overflow-hidden divide-y divide-border-faint">
        <div className="px-4 py-3">
          <div className="flex items-start gap-2">
            <Server className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <div>
              <h3 className="text-[14px] font-semibold text-primary">{t("settings.remoteSync.subtitle")}</h3>
              <p className="mt-0.5 text-[12px] text-muted">{t("settings.remoteSync.description")}</p>
            </div>
          </div>
        </div>

        <div className="px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-[13px] font-semibold text-primary">{t("settings.remoteSync.servers")}</h3>
              <p className="mt-0.5 text-[12px] text-muted">{t("settings.remoteSync.serversHint")}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={addManualProfile} className={cn(buttonClass, "border-border bg-surface-hover text-tertiary hover:bg-surface-active")}>
                <Plus className="h-3.5 w-3.5" />
                {t("settings.remoteSync.manualAdd")}
              </button>
              <button type="button" onClick={loadSshHosts} disabled={!!loading} title={t("settings.remoteSync.refreshSshHosts")} className={cn(buttonClass, "border-border bg-surface-hover px-2 text-tertiary hover:bg-surface-active")}>
                {loading === "hosts" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          {savedProfiles.length > 0 && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {savedProfiles.map((profile) => (
                <button
                  key={profile.id}
                  type="button"
                  onClick={() => { setSelectedId(profile.id); setManualOpen(false); setAdvancedOpen(false); setAgents([]); setReport(null); }}
                  className={cn(
                    "flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                    profile.id === active.id ? "border-accent bg-accent/5" : "border-border-faint bg-background hover:bg-surface-hover"
                  )}
                >
                  <Server className={cn("h-4 w-4 shrink-0", profile.id === active.id ? "text-accent" : "text-muted")} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-primary">{profile.name}</span>
                    <span className="block truncate font-mono text-[11px] text-muted">{profile.host}</span>
                  </span>
                </button>
              ))}
            </div>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <p className="text-[12px] font-medium text-tertiary">{t("settings.remoteSync.configHosts", { count: sshHosts.length })}</p>
            {sshHosts.length === 0 && loading !== "hosts" && <span className="text-[11px] text-muted">{t("settings.remoteSync.noSshHosts")}</span>}
          </div>
          {availableSshHosts.length > 0 && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {availableSshHosts.map((host) => (
                <div key={host.alias} className="flex min-w-0 items-center gap-3 rounded-lg border border-border-faint bg-background px-3 py-2.5">
                  <Server className="h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-primary">{host.alias}</p>
                    <p className="truncate font-mono text-[11px] text-muted">{host.user}@{host.hostname}:{host.port}</p>
                  </div>
                  <button type="button" onClick={() => addSshHost(host.alias)} disabled={!!loading} className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-tertiary hover:bg-surface-hover">
                    {t("settings.remoteSync.addSshHost")}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {(active.host.trim() || manualOpen) && (
          <div className="px-4 py-3">
            {active.host.trim() && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="rounded-lg bg-accent/10 p-2"><Server className="h-4 w-4 text-accent" /></span>
                    <div className="min-w-0">
                      <h3 className="truncate text-[14px] font-semibold text-primary">{active.name}</h3>
                      <p className="truncate font-mono text-[11px] text-muted">ssh {active.host}</p>
                    </div>
                  </div>
                  <button type="button" onClick={discoverAgents} disabled={!!loading} className={cn(buttonClass, "border-accent bg-accent text-white hover:opacity-90")}>
                    {loading === "agents" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    {t("settings.remoteSync.connectAndScan")}
                  </button>
                </div>

                <div className="mt-4">
                  <h4 className="text-[12px] font-medium text-tertiary">{t("settings.remoteSync.chooseAgent")}</h4>
                  {agents.length === 0 ? (
                    <div className="mt-2 rounded-lg border border-dashed border-border px-4 py-5 text-center text-[12px] text-muted">{t("settings.remoteSync.scanHint")}</div>
                  ) : (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {agents.map((agent) => (
                        <button
                          key={`${agent.key}:${agent.path}`}
                          type="button"
                          onClick={() => updateActive({ remoteDir: agent.path })}
                          className={cn(
                            "flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left",
                            active.remoteDir === agent.path ? "border-accent bg-accent/5" : "border-border-faint bg-background hover:bg-surface-hover"
                          )}
                        >
                          <Bot className={cn("h-4 w-4 shrink-0", active.remoteDir === agent.path ? "text-accent" : "text-muted")} />
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] font-medium text-primary">{agent.display_name} · {agent.skill_count} Skills</span>
                            <span className="block truncate font-mono text-[11px] text-muted">{agent.path}</span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="mt-3 flex justify-end">
                  <button type="button" onClick={refresh} disabled={!active.remoteDir.trim() || !!loading} className={cn(buttonClass, "border-border bg-surface-hover text-tertiary hover:bg-surface-active")}>
                    {loading === "status" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    {t("settings.remoteSync.compare")}
                  </button>
                </div>
              </>
            )}

            <details open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)} className="mt-3 rounded-lg border border-border-faint bg-background px-3 py-2">
              <summary className="cursor-pointer text-[12px] font-medium text-tertiary">{t("settings.remoteSync.advanced")}</summary>
              <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,.8fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
                <input value={active.name} onChange={(event) => updateActive({ name: event.target.value })} placeholder={t("settings.remoteSync.profileName")} aria-label={t("settings.remoteSync.profileName")} className={fieldClass} />
                <input value={active.host} onChange={(event) => updateActive({ host: event.target.value })} placeholder={t("settings.remoteSync.hostPlaceholder")} aria-label={t("settings.remoteSync.host")} className={cn(fieldClass, "font-mono")} />
                <input value={active.remoteDir} onChange={(event) => updateActive({ remoteDir: event.target.value })} placeholder="~/.codex/skills" aria-label={t("settings.remoteSync.remoteDir")} className={cn(fieldClass, "font-mono")} />
              </div>
              <div className="mt-3 flex justify-between gap-2">
                <button type="button" onClick={removeProfile} className={cn(buttonClass, "border-border bg-surface-hover text-red-500 hover:bg-surface-active")}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("common.delete")}
                </button>
                <button type="button" onClick={async () => { await persistProfiles(); setManualOpen(false); setAdvancedOpen(false); toast.success(t("settings.remoteSync.saved")); }} disabled={!active.host.trim() || !!loading} className={cn(buttonClass, "border-border bg-surface-hover text-tertiary hover:bg-surface-active")}>
                  <Save className="h-3.5 w-3.5" />
                  {t("common.save")}
                </button>
              </div>
            </details>
          </div>
        )}

        {report && (
          <div className="px-4 py-3">
            <p className="mb-2 text-[12px] text-muted">
              {report.ssh.user}@{report.ssh.hostname}:{report.ssh.port}
              {report.ssh.proxy_jump ? ` · ProxyJump ${report.ssh.proxy_jump}` : ""}
            </p>
            <div className="max-h-56 overflow-auto rounded-md border border-border-faint">
              {report.skills.length === 0 ? (
                <p className="p-3 text-[13px] text-muted">{t("settings.remoteSync.empty")}</p>
              ) : report.skills.map((skill) => (
                <div key={skill.name} className="flex items-center justify-between gap-3 border-b border-border-faint px-3 py-2 last:border-b-0">
                  <span className="truncate font-mono text-[13px] text-primary">{skill.name}</span>
                  <span className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
                    skill.state === "equal" && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                    skill.state === "different" && "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                    skill.state !== "equal" && skill.state !== "different" && "bg-blue-500/10 text-blue-700 dark:text-blue-300",
                  )}>
                    {t(`settings.remoteSync.state.${skill.state}`)}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-[12px] text-muted">
                <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
                {t("settings.remoteSync.force")}
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!canSync}
                  onClick={() => runSync("pull")}
                  className={cn(buttonClass, "border-border bg-surface-hover text-tertiary hover:bg-surface-active")}
                >
                  {loading === "pull" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />}
                  {t("settings.remoteSync.pull")}
                </button>
                <button
                  type="button"
                  disabled={!canSync}
                  onClick={() => runSync("push")}
                  className={cn(buttonClass, "border-accent bg-accent text-white hover:opacity-90")}
                >
                  {loading === "push" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
                  {t("settings.remoteSync.push")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
