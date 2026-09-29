import { PostgresStorage } from "./postgres.mjs";
import { SQLiteStorage } from "./sqlite.mjs";

// Selects the storage backend declared by workflows.mbt.json
// (`storage.type`: "sqlite" default, or "postgres" with `storage.url`).
export function openStorage(config) {
  if (config.storageType === "postgres") {
    return new PostgresStorage(config.storageUrl, {
      schema: config.storageSchema ?? null,
    });
  }
  return new SQLiteStorage(config.storagePath);
}
