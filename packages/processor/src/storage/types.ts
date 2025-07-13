export interface StorageProviderConfig {
  type: 'minio' | 'r2' | 's3';
  endpoint: string;
  region?: string;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
  };
  bucket: string;
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