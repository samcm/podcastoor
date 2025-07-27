export interface StorageProviderConfig {
  type: 'local';
  baseDirectory: string;
  publicUrl?: string;
}

export interface UploadOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  acl?: 'private' | 'public-read' | 'public-read-write';
  storageClass?: string;
}

export interface DownloadOptions {
  range?: {
    start: number;
    end: number;
  };
  versionId?: string;
}

export interface StorageStats {
  totalObjects: number;
  totalSize: number;
  oldestObject?: Date;
  newestObject?: Date;
}

export interface MultipartUpload {
  uploadId: string;
  key: string;
  parts: Array<{
    partNumber: number;
    etag: string;
  }>;
}