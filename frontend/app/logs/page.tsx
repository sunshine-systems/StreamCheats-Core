"use client";

import { useEffect } from "react";

import LogStream from "../../components/LogStream";
import PageHeader from "../../components/ui/PageHeader";
import { markLogsSeen } from "../../lib/hooks/useUnseenLogCount";

export default function LogsPage() {
  useEffect(() => {
    markLogsSeen();
  }, []);

  return (
    <div
      className="
        px-5 sm:px-8 py-8
        flex flex-col gap-6
        min-h-screen
      "
    >
      <PageHeader eyebrow="system · logs" title="Logs" />
      <div className="flex-1 min-h-0 flex flex-col">
        <LogStream />
      </div>
    </div>
  );
}
