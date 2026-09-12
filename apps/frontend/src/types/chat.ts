export type FileUploadStatus =
  | "queued"
  | "creating"
  | "uploading"
  | "confirming"
  | "ready"
  | "error"
  | "cancelling";

export type UploadMode = "SINGLE" | "MULTIPART";
export type UploadCategory = "DOCUMENT" | "MEDIA";

export interface FileAttachment {
  id: string;
  uploadSessionId?: string;
  name: string;
  size: number;
  type: string;
  url?: string;
  file?: File;
  uploadStatus?: FileUploadStatus | "completed";
  uploadProgress?: number;
  uploadError?: string;
  uploadMode?: UploadMode;
  uploadCategory?: UploadCategory;
}

export interface AudioAttachment {
  id: string;
  blob?: Blob;
  url: string;
  durationSeconds: number;
}

export interface Message {
  id: string;
  sender: "user" | "assistant";
  content: string;
  timestamp: string;
  attachments?: FileAttachment[];
  audio?: AudioAttachment;
  isStreaming?: boolean;
  model?: string;
}

export interface Thread {
  id: string;
  workspaceId: string;
  title: string;
  model: string;
  messages: Message[];
  createdAt: string;
  updatedAt?: string;
}
