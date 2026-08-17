import type { RemoteAgentDirectory } from "./tauri";

export interface RemoteProfile {
  id: string;
  name: string;
  host: string;
  remoteDir: string;
  agents: RemoteAgentDirectory[];
  customDirs: string[];
  hiddenAgentKeys: string[];
  disabledSyncPaths: string[];
}

export interface FollowedRemoteDirectory {
  path: string;
  agentKey?: string;
  displayName?: string;
}

const isAgent = (value: unknown): value is RemoteAgentDirectory => {
  if (typeof value !== "object" || value === null) return false;
  const agent = value as Record<string, unknown>;
  return typeof agent.key === "string" && typeof agent.display_name === "string" &&
    typeof agent.path === "string" && typeof agent.skill_count === "number";
};

export function parseRemoteProfiles(raw: string | null): RemoteProfile[] {
  try {
    const parsed: unknown = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const item = value as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.name !== "string" ||
        typeof item.host !== "string" || typeof item.remoteDir !== "string") return [];
      return [{
        id: item.id,
        name: item.name,
        host: item.host,
        remoteDir: item.remoteDir,
        agents: Array.isArray(item.agents) ? item.agents.filter(isAgent) : [],
        customDirs: Array.isArray(item.customDirs)
          ? item.customDirs.filter((path): path is string => typeof path === "string")
          : [],
        hiddenAgentKeys: Array.isArray(item.hiddenAgentKeys)
          ? item.hiddenAgentKeys.filter((key): key is string => typeof key === "string")
          : [],
        disabledSyncPaths: Array.isArray(item.disabledSyncPaths)
          ? item.disabledSyncPaths.filter((path): path is string => typeof path === "string")
          : [],
      }];
    });
  } catch {
    return [];
  }
}

export function getFollowedRemoteDirectories(profile: RemoteProfile): FollowedRemoteDirectory[] {
  const directories = new Map<string, FollowedRemoteDirectory>();
  for (const agent of profile.agents) {
    if (!profile.hiddenAgentKeys.includes(agent.key) && agent.path.trim()) {
      directories.set(agent.path, {
        path: agent.path,
        agentKey: agent.key,
        displayName: agent.display_name,
      });
    }
  }
  for (const path of [...profile.customDirs, profile.remoteDir]) {
    if (path.trim() && !directories.has(path)) directories.set(path, { path });
  }
  return [...directories.values()].filter((directory) => !profile.disabledSyncPaths.includes(directory.path));
}
