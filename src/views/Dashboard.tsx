import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layers, CheckCircle2, Bot, Plus, Download, AlertTriangle, Loader2, RefreshCw, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "../context/AppContext";
import { AgentIcon } from "../components/AgentIcon";
import { getErrorMessage } from "../lib/error";
import { getFollowedRemoteDirectories, parseRemoteProfiles } from "../lib/remoteProfiles";
import * as api from "../lib/tauri";

interface RemoteDirectoryStatus {
  id: string;
  profileName: string;
  host: string;
  path: string;
  agentKey?: string;
  displayName?: string;
  localOnly: number;
  remoteOnly: number;
  conflicts: number;
  error?: string;
}

export function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { tools, projects, managedSkills, openSkillDetailById } = useApp();
  const [remoteStatuses, setRemoteStatuses] = useState<RemoteDirectoryStatus[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);

  const refreshRemoteStatuses = useCallback(async () => {
    setRemoteLoading(true);
    try {
      const profiles = parseRemoteProfiles(await api.getSettings("remote_sync_profiles"));
      const directories = profiles
        .filter((profile) => profile.host.trim())
        .flatMap((profile) => getFollowedRemoteDirectories(profile).map((directory) => ({
          id: `${profile.id}:${directory.path}`,
          profileName: profile.name,
          host: profile.host.trim(),
          path: directory.path,
          agentKey: directory.agentKey,
          displayName: directory.displayName,
          localOnly: 0,
          remoteOnly: 0,
          conflicts: 0,
        })));
      setRemoteStatuses(directories);
      const checked = await Promise.all(directories.map(async (directory): Promise<RemoteDirectoryStatus> => {
        try {
          const report = await api.remoteSkillStatus(directory.host, directory.path);
          return {
            ...directory,
            localOnly: report.skills.filter((skill) => skill.state === "local_only").length,
            remoteOnly: report.skills.filter((skill) => skill.state === "remote_only").length,
            conflicts: report.skills.filter((skill) => skill.state === "different").length,
          };
        } catch (error) {
          return { ...directory, error: getErrorMessage(error, t("dashboard.remoteConnectionFailed")) };
        }
      }));
      setRemoteStatuses(checked);
    } catch {
      setRemoteStatuses([]);
    } finally {
      setRemoteLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refreshRemoteStatuses();
  }, [refreshRemoteStatuses]);

  const enabledAgents = useMemo(
    () => tools.filter((tool) => tool.installed && tool.enabled),
    [tools]
  );

  const totalSkills = managedSkills.length;
  const syncedSkills = useMemo(
    () => managedSkills.filter((s) => s.targets.length > 0).length,
    [managedSkills]
  );

  const divergedCount = useMemo(
    () => projects.reduce((acc, p) => acc + p.sync_health.diverged, 0),
    [projects]
  );

  const recentSkills = useMemo(
    () => [...managedSkills].sort((a, b) => b.updated_at - a.updated_at).slice(0, 5),
    [managedSkills]
  );

  const coverageLabel = totalSkills === 0 ? "0" : `${syncedSkills}/${totalSkills}`;
  const syncCardIcon = divergedCount > 0 ? AlertTriangle : CheckCircle2;
  const syncCardColor = divergedCount > 0 ? "text-amber-400" : "text-emerald-400";
  const syncCardBg = divergedCount > 0 ? "bg-amber-500/[0.08]" : "bg-emerald-500/[0.08]";

  return (
    <div className="app-page app-page-narrow">
      <div className="app-page-header">
        <h1 className="app-page-title">{t("dashboard.greeting")}</h1>
        <p className="app-page-subtitle text-tertiary">
          {t("dashboard.summary", {
            skills: totalSkills,
            agents: enabledAgents.length,
            projects: projects.length,
          })}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3.5">
        {[
          {
            title: t("dashboard.librarySkills"),
            value: String(totalSkills),
            icon: Layers,
            color: "text-accent-light",
            bg: "bg-accent-bg",
          },
          {
            title: t("dashboard.syncCoverage"),
            value: coverageLabel,
            icon: syncCardIcon,
            color: syncCardColor,
            bg: syncCardBg,
          },
          {
            title: t("dashboard.connectedAgents"),
            value: String(enabledAgents.length),
            icon: Bot,
            color: "text-sky-400",
            bg: "bg-sky-500/[0.08]",
          },
        ].map((stat, i) => {
          const Icon = stat.icon;
          return (
            <div
              key={i}
              className="app-panel flex items-center justify-between px-4 py-4 transition-colors hover:border-border"
            >
              <div>
                <p className="app-section-title mb-1">
                  {stat.title}
                </p>
                <h3 className="text-xl font-semibold text-primary leading-none">{stat.value}</h3>
              </div>
              <div className={`p-2 rounded-md ${stat.bg} ${stat.color} border border-border-subtle`}>
                <Icon className="w-4 h-4" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={() => navigate("/install?tab=local")}
          className="app-button-primary flex-1"
        >
          <Download className="w-4 h-4" />
          {t("dashboard.scanImport")}
        </button>
        <button
          onClick={() => navigate("/install")}
          className="app-button-secondary flex-1"
        >
          <Plus className="w-4 h-4 text-tertiary" />
          {t("dashboard.installNew")}
        </button>
      </div>

      <section>
        <div className="mb-2.5 flex items-center justify-between gap-3">
          <div>
            <h2 className="app-section-title">{t("dashboard.remoteSkills")}</h2>
            <p className="mt-0.5 text-[11px] text-muted">{t("dashboard.remoteSkillsHint", { count: remoteStatuses.length })}</p>
          </div>
          <button
            type="button"
            onClick={refreshRemoteStatuses}
            disabled={remoteLoading}
            className="rounded-md border border-border p-1.5 text-muted outline-none transition-colors hover:bg-surface-hover hover:text-secondary focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
            title={t("dashboard.refreshRemote")}
          >
            {remoteLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="app-panel overflow-hidden divide-y divide-border-subtle">
          {remoteStatuses.length === 0 ? (
            <button type="button" onClick={() => navigate("/remote-ssh")} className="flex w-full items-center justify-center gap-2 px-4 py-6 text-[12px] text-muted transition-colors hover:bg-surface-hover hover:text-secondary">
              {remoteLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Server className="h-4 w-4" />}
              {remoteLoading ? t("dashboard.remoteChecking") : t("dashboard.remoteEmpty")}
            </button>
          ) : remoteStatuses.map((status) => {
            const inSync = !status.error && status.localOnly === 0 && status.remoteOnly === 0 && status.conflicts === 0;
            return (
              <div key={status.id} className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  {status.agentKey ? (
                    <AgentIcon agentKey={status.agentKey} displayName={status.displayName ?? status.profileName} className="h-6 w-6 shrink-0" />
                  ) : (
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-accent-bg text-accent-light"><Server className="h-3.5 w-3.5" /></span>
                  )}
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium text-secondary">{status.profileName}{status.displayName ? ` · ${status.displayName}` : ""}</p>
                    <p className="truncate font-mono text-[11px] text-muted" title={`${status.host}:${status.path}`}>{status.host}:{status.path}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  {remoteLoading ? (
                    <span className="rounded-full bg-surface-hover px-2 py-0.5 text-[11px] text-muted">{t("dashboard.remoteChecking")}</span>
                  ) : status.error ? (
                    <span title={status.error} className="rounded-full bg-red-500/10 px-2 py-0.5 text-[11px] text-red-600 dark:text-red-300">{t("dashboard.remoteConnectionFailed")}</span>
                  ) : inSync ? (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">{t("dashboard.remoteInSync")}</span>
                  ) : (
                    <>
                      {status.localOnly > 0 && <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[11px] text-blue-700 dark:text-blue-300">{t("dashboard.remoteLocalOnly", { count: status.localOnly })}</span>}
                      {status.remoteOnly > 0 && <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[11px] text-violet-700 dark:text-violet-300">{t("dashboard.remoteRemoteOnly", { count: status.remoteOnly })}</span>}
                      {status.conflicts > 0 && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">{t("dashboard.remoteConflicts", { count: status.conflicts })}</span>}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Recent skills */}
      {recentSkills.length > 0 && (
        <div>
          <h2 className="app-section-title mb-2.5">
            {t("dashboard.recentActivity")}
          </h2>
          <div className="app-panel overflow-hidden divide-y divide-border-subtle">
            {recentSkills.map((skill) => (
              <div
                key={skill.id}
                role="button"
                tabIndex={0}
                onClick={() => {
                  openSkillDetailById(skill.id);
                  navigate("/my-skills");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    openSkillDetailById(skill.id);
                    navigate("/my-skills");
                  }
                }}
                className="flex items-center justify-between px-3.5 py-2.5 hover:bg-surface-hover transition-colors cursor-pointer"
              >
                <div className="flex items-center gap-2.5">
                  <div className="w-6 h-6 rounded-[4px] flex items-center justify-center text-[13px] font-semibold bg-accent-bg text-accent-light shrink-0">
                    {skill.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <h4 className="text-[13px] text-secondary font-medium flex items-center gap-1.5">
                      {skill.name}
                      <span className="text-[9px] px-1.5 py-px rounded bg-surface-hover text-muted border border-border font-normal">
                        {skill.source_type}
                      </span>
                    </h4>
                    <p className="text-[13px] text-muted mt-px">
                      {skill.targets.length > 0
                        ? `${t("dashboard.synced")} → ${skill.targets.map((target) => target.tool).join(", ")}`
                        : t("dashboard.notSynced")}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
