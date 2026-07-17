/**
 * StorageBackend — pluggable interface for binary file storage.
 *
 * GBrain is agnostic about where files live. The setup skill picks
 * the backend (Supabase Storage or S3/R2/MinIO), gbrain doesn't care.
 */

export interface StorageBackend {
  upload(path: string, data: Buffer, mime?: string): Promise<void>;
  download(path: string): Promise<Buffer>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  getUrl(path: string): Promise<string>;
}

export interface StorageConfig {
  backend: 's3' | 'supabase' | 'local';
  bucket: string;
  region?: string;
  endpoint?: string;
  // S3 credentials
  accessKeyId?: string;
  secretAccessKey?: string;
  // Supabase credentials
  projectUrl?: string;
  serviceRoleKey?: string;
  // Local (for testing)
  localPath?: string;
}

/**
 * Physical object key for a newly uploaded source-owned file.
 *
 * `files.storage_path` is the source-local logical path exposed by the CLI
 * and MCP operations. Object stores are global to the configured bucket, so
 * using that logical path directly lets two sources overwrite each other's
 * bytes. Keep the source namespace in the physical key and persist that key
 * in files.metadata for backward-compatible reads of legacy unscoped rows.
 */
export function sourceScopedStorageKey(sourceId: string, storagePath: string): string {
  const encodedSource = Buffer.from(sourceId, 'utf8').toString('base64url');
  return `.gbrain/sources/${encodedSource}/${storagePath}`;
}

/** Resolve the physical key for a file row, preserving legacy unscoped rows. */
export function storedObjectKey(
  row: { storage_path: string; metadata?: Record<string, unknown> | null },
): string {
  const key = row.metadata?.storage_object_key;
  return typeof key === 'string' && key.length > 0 ? key : row.storage_path;
}

/**
 * Create a StorageBackend from config.
 */
export async function createStorage(config: StorageConfig): Promise<StorageBackend> {
  switch (config.backend) {
    case 's3': {
      const { S3Storage } = await import('./storage/s3.ts');
      return new S3Storage(config);
    }
    case 'supabase': {
      const { SupabaseStorage } = await import('./storage/supabase.ts');
      return new SupabaseStorage(config);
    }
    case 'local': {
      const { LocalStorage } = await import('./storage/local.ts');
      return new LocalStorage(config.localPath || '/tmp/gbrain-storage');
    }
    default:
      throw new Error(`Unknown storage backend: ${config.backend}`);
  }
}
