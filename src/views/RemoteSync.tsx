import { Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { RemoteSyncPanel } from "../components/RemoteSyncPanel";

export function RemoteSync() {
  const { t } = useTranslation();
  return (
    <div className="app-page app-page-narrow">
      <div className="app-page-header">
        <h1 className="app-page-title flex items-center gap-2">
          <Server className="h-4 w-4 text-accent" />
          {t("sidebar.remoteSsh")}
        </h1>
      </div>
      <RemoteSyncPanel />
    </div>
  );
}
