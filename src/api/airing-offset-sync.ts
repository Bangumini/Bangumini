import {
  readAiringOffsetAccountState, setAiringOffsetAccount, subscribeAiringOffsetState, updateAiringOffsetAccountState,
} from "./airing-offset";
import { createAiringOffsetSyncManager } from "./airing-offset-sync-manager";
import { offsetSyncConfigStore } from "./offset-sync-config-store";
import { createOffsetSyncStorage, OffsetSyncPreconditionError, offsetSyncStorageErrorMessage } from "./offset-sync-storage";

export const offsetSync = createAiringOffsetSyncManager({
  setAccount: setAiringOffsetAccount,
  readLocal: readAiringOffsetAccountState,
  updateLocal: updateAiringOffsetAccountState,
  subscribeLocal: subscribeAiringOffsetState,
  configs: offsetSyncConfigStore,
  createStorage: createOffsetSyncStorage,
  isPreconditionError: error => error instanceof OffsetSyncPreconditionError,
  formatStorageError: offsetSyncStorageErrorMessage,
  newRevision: () => crypto.randomUUID(),
});
