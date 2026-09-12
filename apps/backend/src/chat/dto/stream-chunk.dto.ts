export class StreamChunkDto {
  workspaceId: string;
  threadId: string;
  userMessageId: string;
  chunk?: string;
  accumulated?: string;
  isDone?: boolean;
  model?: string;
  toolCalls?: Array<Record<string, unknown>>;
  workingMemoryContext?: Record<string, unknown>;
  error?: string;
}
