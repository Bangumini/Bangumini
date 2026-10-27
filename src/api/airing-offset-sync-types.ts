import type { OffsetSyncConflict } from "../../shared/airing-offset-sync.ts";
import type { OffsetSyncConfig } from "../../shared/offset-sync-config.ts";

export type OffsetSyncStatus = {
  account: string | null;
  ready: boolean;
  enabled: boolean;
  configured: boolean;
  autoSync: boolean;
  phase: "idle" | "syncing" | "conflict" | "error";
  conflicts: readonly OffsetSyncConflict[];
  lastSyncedAt: number | null;
  error: string | null;
};

export interface AiringOffsetSyncManager {
  getSnapshot(): OffsetSyncStatus;
  subscribe(listener: () => void): () => void;
  setAccount(account: string | null): Promise<void>;
  setAppActive(active: boolean): void;
  setEnabled(enabled: boolean): Promise<void>;
  getConfig(): Promise<OffsetSyncConfig | null>;
  saveConfig(config: OffsetSyncConfig): Promise<void>;
  disconnect(): Promise<void>;
  syncNow(): Promise<void>;
  testConnection(config: OffsetSyncConfig): Promise<{ exists: boolean }>;
  resolveConflict(subjectId: number, choice: "local" | "remote"): Promise<void>;
}
