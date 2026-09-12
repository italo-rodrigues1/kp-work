export class CreateUploadSessionDto {
  workspaceId?: string;
  threadId?: string;
  fileName?: string;
  name?: string;
  size?: number;
  contentType?: string;
}

export class UploadPartsDto {
  workspaceId?: string;
  partNumbers?: number[];
}

export type UploadModeValue = 'SINGLE' | 'MULTIPART';
export type UploadCategoryValue = 'DOCUMENT' | 'MEDIA';
export type UploadStatusValue =
  'PENDING' | 'COMPLETING' | 'COMPLETED' | 'ATTACHED' | 'DELETING';

export type UploadHeaders = Record<string, string>;

export interface UploadPartUrlResponse {
  partNumber: number;
  uploadUrl: string;
  uploadHeaders: UploadHeaders;
  uploadUrlExpiresAt: string;
}

export interface UploadPartsResponse {
  parts: UploadPartUrlResponse[];
  expiresAt: string;
}

export interface UploadSessionResponse {
  id: string;
  threadId: string;
  name: string;
  size: number;
  type: string;
  status: UploadStatusValue;
  mode: UploadModeValue;
  category: UploadCategoryValue;
  uploadUrl?: string;
  uploadHeaders?: UploadHeaders;
  uploadUrlExpiresAt?: string;
  partSize?: number;
  partCount?: number;
  downloadUrl?: string;
  expiresAt: string;
  completedAt?: string;
}

export const UploadErrorCode = {
  InvalidRequest: 'UPLOAD_INVALID_REQUEST',
  EmptyFile: 'UPLOAD_EMPTY_FILE',
  FileTooLarge: 'UPLOAD_FILE_TOO_LARGE',
  SessionLimit: 'UPLOAD_SESSION_LIMIT',
  SessionExpired: 'UPLOAD_SESSION_EXPIRED',
  InvalidState: 'UPLOAD_INVALID_STATE',
  Incomplete: 'UPLOAD_INCOMPLETE',
  SizeMismatch: 'UPLOAD_SIZE_MISMATCH',
  TypeMismatch: 'UPLOAD_TYPE_MISMATCH',
  InvalidParts: 'UPLOAD_INVALID_PARTS',
  NotFound: 'UPLOAD_NOT_FOUND',
} as const;
