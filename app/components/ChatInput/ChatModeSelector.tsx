"use client";

import { useState } from "react";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { ModeSelectorTrigger, ModeSelectorContent } from "./ModeSelectorMenu";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { AgentUpgradeDialog } from "./AgentUpgradeDialog";
import { navigateToAuth, useTauri } from "@/app/hooks/useTauri";
import { isCloudAgentUnlockedForFree } from "@/lib/experiments/solider-cloud-agent";

export interface ChatModeSelectorProps {
  className?: string;
}

export function ChatModeSelector({ className }: ChatModeSelectorProps) {
  const {
    chatMode,
    setChatMode,
    subscription,
    hasLocalSandbox,
    desktopBridgeStatus,
    retryDesktopBridge,
    defaultLocalSandboxPreference,
    sandboxPreference,
    setSandboxPreference,
    selectedModel,
    setSelectedModel,
  } = useGlobalState();
  const { user } = useAuth();
  const { isTauri } = useTauri();
  const [agentUpgradeDialogOpen, setAgentUpgradeDialogOpen] = useState(false);

  const enableLocalAgentMode = () => {
    setChatMode("agent");
    if (
      (sandboxPreference === "e2b" || !sandboxPreference) &&
      defaultLocalSandboxPreference
    ) {
      setSandboxPreference(defaultLocalSandboxPreference);
    }
    if (selectedModel !== "auto") {
      setSelectedModel("auto");
    }
    setAgentUpgradeDialogOpen(false);
  };

  const handleAgentModeClick = () => {
    if (!user) {
      navigateToAuth("/signup", { preferSignInForReturningUser: true });
      return;
    }
    // Solider.uz change: this fork has no payments, so "free" never
    // upgrades. See lib/experiments/solider-cloud-agent.ts.
    if (subscription !== "free" || isCloudAgentUnlockedForFree()) {
      setChatMode("agent");
    } else if (hasLocalSandbox) {
      enableLocalAgentMode();
    } else {
      setAgentUpgradeDialogOpen(true);
    }
  };

  return (
    <>
      <div
        className={`flex items-center gap-1.5 min-w-0 overflow-hidden ${className ?? ""}`}
      >
        <DropdownMenu>
          <ModeSelectorTrigger
            chatMode={chatMode}
            isPaid={subscription !== "free"}
          />
          <ModeSelectorContent
            setChatMode={setChatMode}
            onAgentModeClick={handleAgentModeClick}
          />
        </DropdownMenu>
      </div>

      <AgentUpgradeDialog
        open={agentUpgradeDialogOpen}
        onOpenChange={setAgentUpgradeDialogOpen}
        isDesktopEnvironment={isTauri}
        desktopBridgeStatus={desktopBridgeStatus}
        onRetryDesktopBridge={retryDesktopBridge}
        onUseConnectedDesktop={enableLocalAgentMode}
      />
    </>
  );
}
