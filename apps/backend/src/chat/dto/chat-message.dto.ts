export interface AttachmentDto {
  uploadSessionId: string;
}

export interface AudioDto {
  id?: string;
  url: string;
  durationSeconds: number;
}

export class SendMessageDto {
  workspaceId?: string;
  threadId?: string;
  message?: string;
  attachmentsCount?: number;
  hasAudio?: boolean;
  model?: string;
  attachments?: AttachmentDto[];
  audio?: AudioDto;
}
