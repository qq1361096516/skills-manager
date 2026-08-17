import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, Eye, EyeOff, Folder, Loader2, Plus, RefreshCw, Save, Server, Trash2 } from "lucide-react";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AgentIcon } from "./AgentIcon";
import { ToggleSwitch } from "./ToggleSwitch";
import * as api from "../lib/tauri";
import { getErrorMessage } from "../lib/error";
import { getFollowedRemoteDirectories, parseRemoteProfiles, type RemoteProfile } from "../lib/remoteProfiles";
import { cn } from "../utils";

const fieldClass = "h-8 rounded-md border border-border bg-background px-2.5 text-[13px] text-primary outline-none focus:border-accent";
const buttonClass = "inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] font-medium outline-none disabled:cursor-not-allowed disabled:opacity-50";

const createProfile = (name = "Remote 1"): RemoteProfile => ({
  id: crypto.randomUUID(),
  name,
  host: "",
  remoteDir: "~/.codex/skills",
  agents: [],
  customDirs: [],
  hiddenAgentKeys: [],
  disabledSyncPaths: [],
});

export function RemoteSyncPanel() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<RemoteProfile[]>(() => [createProfile()]);
  const [selectedId, setSelectedId] = useState("");
  const [activeTab, setActiveTab] = useState("add");
  const [sshHosts, setSshHosts] = useState<api.SshConfigHost[]>([]);
  const [manualOpen, setManualOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [customDirInput, setCustomDirInput] = useState("");
  const [force, setForce] = useState(false);
  const [report, setReport] = useState<api.RemoteStatusReport | null>(null);
  const [loading, setLoading] = useState<"hosts" | "agents" | "status" | "pull" | "push" | null>(null);
  const serverMenuRef = useRef<HTMLDetailsElement>(null);

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
      let saved = parseRemoteProfiles(raw);
      if (saved.length === 0) {
        saved = [{
          ...createProfile(),
          name: legacyHost?.trim() || "Remote 1",
          host: legacyHost?.trim() || "",
          remoteDir: legacyDir?.trim() || "~/.codex/skills",
        }];
      }
      setProfiles(saved);
      const initialId = saved.some((item) => item.id === savedId) ? savedId! : saved[0].id;
      setSelectedId(initialId);
      setActiveTab(saved.find((item) => item.id === initialId)?.host.trim() ? initialId : "add");
    }).catch(() => {});
  }, [loadSshHosts]);

  useEffect(() => setCustomDirInput(""), [selectedId]);

  const active = profiles.find((profile) => profile.id === selectedId) ?? profiles[0];
  const agents = active.agents ?? [];
  const hiddenAgentKeys = active.hiddenAgentKeys ?? [];
  const visibleAgents = agents.filter((agent) => !hiddenAgentKeys.includes(agent.key));
  const hiddenAgents = agents.filter((agent) => hiddenAgentKeys.includes(agent.key));
  const customDirs = Array.from(new Set([
    ...(active.customDirs ?? []),
    ...(active.remoteDir.trim() && !agents.some((agent) => agent.path === active.remoteDir.trim())
      ? [active.remoteDir.trim()]
      : []),
  ]));
  const availableSshHosts = sshHosts.filter((host) =>
    !profiles.some((profile) => profile.host === host.alias)
  );
  const savedProfiles = profiles.filter((profile) => profile.host.trim());

  const updateActive = (patch: Partial<RemoteProfile>) => {
    const nextPatch = patch.host !== undefined && patch.host !== active.host
      ? { ...patch, agents: [], hiddenAgentKeys: [] }
      : patch;
    setProfiles((current) => current.map((profile) =>
      profile.id === active.id ? { ...profile, ...nextPatch } : profile
    ));
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
    serverMenuRef.current?.removeAttribute("open");
    setActiveTab("add");
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
    setActiveTab(profile.id);
    setManualOpen(false);
    setAdvancedOpen(false);
    setReport(null);
    void persistProfiles(next, profile.id);
  };

  const selectServer = (value: string) => {
    serverMenuRef.current?.removeAttribute("open");
    if (value.startsWith("ssh:")) {
      addSshHost(value.slice(4));
      return;
    }
    if (!profiles.some((profile) => profile.id === value)) return;
    setSelectedId(value);
    setActiveTab(value);
    setManualOpen(false);
    setAdvancedOpen(false);
    setReport(null);
    void persistProfiles(profiles, value);
  };

  const removeProfile = async () => {
    if (!await confirm(t("settings.remoteSync.removeConfirm"))) return;
    const remaining = profiles.filter((profile) => profile.id !== active.id);
    const next = remaining.length > 0 ? remaining : [createProfile()];
    setProfiles(next);
    setSelectedId(next[0].id);
    setActiveTab(next[0].host.trim() ? next[0].id : "add");
    setManualOpen(false);
    setAdvancedOpen(false);
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
      const selectedPath = active.remoteDir.trim() || found[0]?.path || "";
      const nextProfiles = profiles.map((profile) =>
        profile.id === active.id
          ? { ...profile, agents: found, remoteDir: selectedPath }
          : profile
      );
      setProfiles(nextProfiles);
      await persistProfiles(nextProfiles, active.id);
      if (found.length === 0) {
        toast.info(t("settings.remoteSync.noAgents"));
      } else {
        toast.success(t("settings.remoteSync.agentsFound", { count: found.length }));
      }
      setReport(null);
    } catch (error) {
      toast.error(getErrorMessage(error, t("common.error")));
    } finally {
      setLoading(null);
    }
  };

  const saveProfiles = (next: RemoteProfile[]) => {
    setProfiles(next);
    void persistProfiles(next, active.id).catch((error) =>
      toast.error(getErrorMessage(error, t("common.error")))
    );
    setReport(null);
  };

  const selectRemoteDir = (remoteDir: string) => {
    saveProfiles(profiles.map((profile) =>
      profile.id === active.id ? { ...profile, remoteDir } : profile
    ));
  };

  const setAgentVisible = (key: string, visible: boolean) => {
    const hidden = new Set(hiddenAgentKeys);
    if (visible) hidden.delete(key); else hidden.add(key);
    const fallback = visible || !agents.some((agent) => agent.key === key && agent.path === active.remoteDir)
      ? active.remoteDir
      : visibleAgents.find((agent) => agent.key !== key)?.path ?? customDirs[0] ?? "";
    saveProfiles(profiles.map((profile) =>
      profile.id === active.id
        ? { ...profile, hiddenAgentKeys: [...hidden], remoteDir: fallback }
        : profile
    ));
  };

  const setPathEnabled = (path: string, enabled: boolean) => {
    const disabled = new Set(active.disabledSyncPaths);
    if (enabled) disabled.delete(path); else disabled.add(path);
    saveProfiles(profiles.map((profile) =>
      profile.id === active.id ? { ...profile, disabledSyncPaths: [...disabled] } : profile
    ));
  };

  const saveActiveProfile = async () => {
    const remoteDir = active.remoteDir.trim();
    const custom = remoteDir && !agents.some((agent) => agent.path === remoteDir)
      ? Array.from(new Set([...(active.customDirs ?? []), remoteDir]))
      : active.customDirs ?? [];
    const next = profiles.map((profile) =>
      profile.id === active.id ? { ...profile, remoteDir, customDirs: custom } : profile
    );
    setProfiles(next);
    await persistProfiles(next, active.id);
    setManualOpen(false);
    setAdvancedOpen(false);
    setActiveTab(active.id);
    toast.success(t("settings.remoteSync.saved"));
  };

  const removeCustomDir = (path: string) => {
    const remaining = customDirs.filter((item) => item !== path);
    const remoteDir = active.remoteDir === path ? visibleAgents[0]?.path ?? remaining[0] ?? "" : active.remoteDir;
    saveProfiles(profiles.map((profile) =>
      profile.id === active.id ? { ...profile, customDirs: remaining, remoteDir } : profile
    ));
  };

  const addCustomDir = () => {
    const path = customDirInput.trim();
    if (!/^(~\/|\/)[A-Za-z0-9._/-]+$/.test(path)) {
      toast.error(t("settings.remoteSync.invalidCustomDir"));
      return;
    }
    saveProfiles(profiles.map((profile) =>
      profile.id === active.id
        ? { ...profile, customDirs: Array.from(new Set([...profile.customDirs, path])), remoteDir: path }
        : profile
    ));
    setCustomDirInput("");
  };

  const runBatch = async (direction: "pull" | "push", batchProfiles: RemoteProfile[]) => {
    const targets = batchProfiles.flatMap((profile) =>
      getFollowedRemoteDirectories(profile).map((directory) => ({
        host: profile.host.trim(),
        path: directory.path,
      }))
    ).filter((target) => target.host);
    if (targets.length === 0) {
      toast.info(t("settings.remoteSync.noEnabledDirs"));
      return;
    }
    const accepted = await confirm(t(`settings.remoteSync.confirm.${direction}`), {
      title: t("settings.remoteSync.title"),
      kind: "warning",
    });
    if (!accepted) return;
    setLoading(direction);
    let applied = 0;
    let conflicts = 0;
    let failed = 0;
    try {
      for (const target of targets) {
        try {
          const result = await api.remoteSkillSync(direction, target.host, target.path, force);
          applied += result.items.filter((item) => item.result === "applied").length;
          conflicts += result.items.filter((item) => item.result === "conflict").length;
        } catch {
          failed += 1;
        }
      }
      const message = t("settings.remoteSync.batchDone", { directories: targets.length, applied, conflicts, failed });
      if (failed > 0) toast.warning(message); else toast.success(message);
      if (batchProfiles.some((profile) => profile.id === active.id) && active.remoteDir.trim()) {
        setReport(await api.remoteSkillStatus(active.host.trim(), active.remoteDir.trim()).catch(() => null));
      }
    } finally {
      setLoading(null);
    }
  };

  const enabledProfilePathCount = getFollowedRemoteDirectories(active).length;
  const enabledGlobalPathCount = savedProfiles.reduce(
    (count, profile) => count + getFollowedRemoteDirectories(profile).length,
    0
  );

  return (
    <section>
      <h2 className="app-section-title mb-3">{t("settings.remoteSync.title")}</h2>
      <div className="mb-3 flex flex-col gap-3 border-b border-border-subtle lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 gap-5 overflow-x-auto">
          <button
            type="button"
            onClick={() => { setActiveTab("add"); setManualOpen(false); setAdvancedOpen(false); setReport(null); }}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-b-2 px-1 pb-2 text-[13px] font-medium outline-none transition-colors",
              activeTab === "add" ? "border-accent text-accent" : "border-transparent text-muted hover:text-tertiary"
            )}
          >
            <Plus className="h-3.5 w-3.5" />
            {t("settings.remoteSync.addRemoteTab")}
          </button>
          {savedProfiles.map((profile) => (
            <button
              key={profile.id}
              type="button"
              onClick={() => selectServer(profile.id)}
              className={cn(
                "flex max-w-44 shrink-0 items-center gap-1.5 border-b-2 px-1 pb-2 text-[13px] font-medium outline-none transition-colors",
                activeTab === profile.id ? "border-accent text-accent" : "border-transparent text-muted hover:text-tertiary"
              )}
            >
              <Server className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{profile.name}</span>
            </button>
          ))}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 pb-2">
          <label className="mr-1 flex items-center gap-1.5 text-[11px] text-muted">
            <input type="checkbox" checked={force} onChange={(event) => setForce(event.target.checked)} />
            {t("settings.remoteSync.forceShort")}
          </label>
          <button type="button" disabled={enabledGlobalPathCount === 0 || !!loading} onClick={() => runBatch("pull", savedProfiles)} className={cn(buttonClass, "border-border bg-surface-hover text-tertiary hover:bg-surface-active")}>
            {loading === "pull" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />}
            {t("settings.remoteSync.pullAll")}
          </button>
          <button type="button" disabled={enabledGlobalPathCount === 0 || !!loading} onClick={() => runBatch("push", savedProfiles)} className={cn(buttonClass, "border-accent bg-accent text-white hover:opacity-90")}>
            {loading === "push" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
            {t("settings.remoteSync.pushAll")}
          </button>
        </div>
      </div>
      <div className="app-panel overflow-hidden divide-y divide-border-faint">
        {activeTab === "add" && (<>
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

          <details ref={serverMenuRef} className="group mt-3">
            <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 rounded-xl border border-border-faint bg-surface px-3 py-2.5 shadow-card outline-none transition-colors hover:border-border hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent/20 [&::-webkit-details-marker]:hidden">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border-subtle bg-accent-bg text-accent-light">
                <Server className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-primary">
                  {t("settings.remoteSync.selectServer")}
                </span>
                <span className="block truncate text-[11px] text-muted">{t("settings.remoteSync.selectServerHint")}</span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted transition-transform group-open:rotate-180" />
            </summary>

            <div className="mt-2 max-h-80 overflow-y-auto rounded-xl border border-border-faint bg-surface p-2 shadow-card">
              {availableSshHosts.length > 0 && (
                <div>
                  <p className="px-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{t("settings.remoteSync.configHosts", { count: availableSshHosts.length })}</p>
                  <div className="grid gap-2">
                    {availableSshHosts.map((host) => (
                      <button
                        key={host.alias}
                        type="button"
                        onClick={() => selectServer(`ssh:${host.alias}`)}
                        className="flex w-full items-center gap-3 rounded-lg border border-border-faint bg-background px-3 py-3 text-left outline-none transition-colors hover:border-border hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent/20"
                      >
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-hover text-muted"><Plus className="h-4 w-4" /></span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-primary">{host.alias}</span>
                          <span className="block truncate font-mono text-[11px] text-muted">{host.user}@{host.hostname}:{host.port}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {availableSshHosts.length === 0 && (
                <p className="px-3 py-4 text-center text-[12px] text-muted">{t("settings.remoteSync.noSshHosts")}</p>
              )}
            </div>
          </details>
          {sshHosts.length === 0 && loading !== "hosts" && (
            <p className="mt-2 text-[11px] text-muted">{t("settings.remoteSync.noSshHosts")}</p>
          )}
        </div>
        </>)}

        {((activeTab !== "add" && active.host.trim()) || manualOpen) && (
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
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={discoverAgents} disabled={!!loading} className={cn(buttonClass, "border-border bg-surface-hover text-tertiary hover:bg-surface-active")}>
                      {loading === "agents" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      {t("settings.remoteSync.connectAndScan")}
                    </button>
                    <button type="button" disabled={enabledProfilePathCount === 0 || !!loading} onClick={() => runBatch("pull", [active])} className={cn(buttonClass, "border-border bg-surface-hover text-tertiary hover:bg-surface-active")}>
                      {loading === "pull" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowDownToLine className="h-3.5 w-3.5" />}
                      {t("settings.remoteSync.pullServer")}
                    </button>
                    <button type="button" disabled={enabledProfilePathCount === 0 || !!loading} onClick={() => runBatch("push", [active])} className={cn(buttonClass, "border-accent bg-accent text-white hover:opacity-90")}>
                      {loading === "push" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpFromLine className="h-3.5 w-3.5" />}
                      {t("settings.remoteSync.pushServer")}
                    </button>
                  </div>
                </div>

                <div className="mt-4">
                  <h4 className="text-[12px] font-medium text-tertiary">{t("settings.remoteSync.chooseAgent")}</h4>
                  <div className="mt-2 rounded-lg border border-border-faint bg-background p-2.5">
                    <p className="text-[11px] text-muted">{t("settings.remoteSync.customDirHint")}</p>
                    <div className="mt-2 flex gap-2">
                      <input
                        value={customDirInput}
                        onChange={(event) => setCustomDirInput(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter") addCustomDir(); }}
                        placeholder="~/.my-agent/skills"
                        aria-label={t("settings.remoteSync.addCustomDir")}
                        className={cn(fieldClass, "min-w-0 flex-1 font-mono")}
                      />
                      <button type="button" onClick={addCustomDir} className={cn(buttonClass, "border-border bg-surface-hover text-tertiary hover:bg-surface-active")}>
                        <Plus className="h-3.5 w-3.5" />
                        {t("settings.remoteSync.addCustomDir")}
                      </button>
                    </div>
                  </div>
                  {agents.length === 0 && customDirs.length === 0 ? (
                    <div className="mt-2 rounded-lg border border-dashed border-border px-4 py-5 text-center text-[12px] text-muted">{t("settings.remoteSync.scanHint")}</div>
                  ) : (
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {visibleAgents.map((agent) => (
                        <div
                          key={`${agent.key}:${agent.path}`}
                          className={cn(
                            "flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2.5",
                            active.remoteDir === agent.path ? "border-accent bg-accent/5" : "border-border-faint bg-background hover:bg-surface-hover"
                          )}
                        >
                          <button type="button" onClick={() => selectRemoteDir(agent.path)} className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none">
                            <AgentIcon agentKey={agent.key} displayName={agent.display_name} className="h-5 w-5 shrink-0" />
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] font-medium text-primary">{agent.display_name} · {agent.skill_count} Skills</span>
                              <span className="block truncate font-mono text-[11px] text-muted">{agent.path}</span>
                            </span>
                          </button>
                          <button type="button" onClick={() => setAgentVisible(agent.key, false)} className="p-1 text-muted hover:text-secondary" title={t("settings.remoteSync.hideAgent")}><EyeOff className="h-3.5 w-3.5" /></button>
                          <ToggleSwitch
                            checked={!active.disabledSyncPaths.includes(agent.path)}
                            onChange={() => setPathEnabled(agent.path, active.disabledSyncPaths.includes(agent.path))}
                            title={active.disabledSyncPaths.includes(agent.path) ? t("settings.remoteSync.enablePathSync") : t("settings.remoteSync.disablePathSync")}
                          />
                        </div>
                      ))}
                      {customDirs.map((path) => (
                        <div key={path} className={cn("flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2.5", active.remoteDir === path ? "border-accent bg-accent/5" : "border-border-faint bg-background hover:bg-surface-hover")}>
                          <button type="button" onClick={() => selectRemoteDir(path)} className="flex min-w-0 flex-1 items-center gap-3 text-left outline-none">
                            <Folder className={cn("h-5 w-5 shrink-0", active.remoteDir === path ? "text-accent" : "text-muted")} />
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] font-medium text-primary">{t("settings.remoteSync.manualPath")}</span>
                              <span className="block truncate font-mono text-[11px] text-muted">{path}</span>
                            </span>
                          </button>
                          <ToggleSwitch
                            checked={!active.disabledSyncPaths.includes(path)}
                            onChange={() => setPathEnabled(path, active.disabledSyncPaths.includes(path))}
                            title={active.disabledSyncPaths.includes(path) ? t("settings.remoteSync.enablePathSync") : t("settings.remoteSync.disablePathSync")}
                          />
                          <button type="button" onClick={() => removeCustomDir(path)} className="p-1 text-muted hover:text-red-500" title={t("common.delete")}><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      ))}
                    </div>
                  )}
                  {hiddenAgents.length > 0 && (
                    <details className="mt-2 rounded-lg border border-border-faint bg-background px-3 py-2">
                      <summary className="cursor-pointer text-[12px] font-medium text-muted">{t("settings.remoteSync.hiddenAgents", { count: hiddenAgents.length })}</summary>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {hiddenAgents.map((agent) => (
                          <div key={`${agent.key}:${agent.path}`} className="flex min-w-0 items-center gap-3 rounded-lg bg-surface-hover px-3 py-2">
                            <AgentIcon agentKey={agent.key} displayName={agent.display_name} className="h-5 w-5 shrink-0 opacity-60" />
                            <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{agent.display_name}</span>
                            <button type="button" onClick={() => setAgentVisible(agent.key, true)} className="p-1 text-muted hover:text-accent" title={t("settings.remoteSync.restoreAgent")}><Eye className="h-3.5 w-3.5" /></button>
                          </div>
                        ))}
                      </div>
                    </details>
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
              <p className="mt-2 text-[11px] text-muted">{t("settings.remoteSync.advancedHint")}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,.8fr)_minmax(0,1fr)_minmax(0,1.4fr)]">
                <label className="grid gap-1">
                  <span className="text-[12px] font-medium text-secondary">{t("settings.remoteSync.profileName")}</span>
                  <input value={active.name} onChange={(event) => updateActive({ name: event.target.value })} placeholder={t("settings.remoteSync.profileDefault", { count: 1 })} className={cn(fieldClass, "w-full")} />
                  <span className="text-[10px] leading-4 text-muted">{t("settings.remoteSync.profileNameHint")}</span>
                </label>
                <label className="grid gap-1">
                  <span className="text-[12px] font-medium text-secondary">{t("settings.remoteSync.host")}</span>
                  <input value={active.host} onChange={(event) => updateActive({ host: event.target.value })} placeholder={t("settings.remoteSync.hostPlaceholder")} className={cn(fieldClass, "w-full font-mono")} />
                  <span className="text-[10px] leading-4 text-muted">{t("settings.remoteSync.hostHint")}</span>
                </label>
                <label className="grid gap-1">
                  <span className="text-[12px] font-medium text-secondary">{t("settings.remoteSync.remoteDir")}</span>
                  <input value={active.remoteDir} onChange={(event) => updateActive({ remoteDir: event.target.value })} placeholder="~/.codex/skills" className={cn(fieldClass, "w-full font-mono")} />
                  <span className="text-[10px] leading-4 text-muted">{t("settings.remoteSync.remoteDirHint")}</span>
                </label>
              </div>
              <div className="mt-3 flex justify-between gap-2">
                <button type="button" onClick={removeProfile} className={cn(buttonClass, "border-border bg-surface-hover text-red-500 hover:bg-surface-active")}>
                  <Trash2 className="h-3.5 w-3.5" />
                  {t("common.delete")}
                </button>
                <button type="button" onClick={saveActiveProfile} disabled={!active.host.trim() || !!loading} className={cn(buttonClass, "border-border bg-surface-hover text-tertiary hover:bg-surface-active")}>
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
          </div>
        )}
      </div>
    </section>
  );
}
