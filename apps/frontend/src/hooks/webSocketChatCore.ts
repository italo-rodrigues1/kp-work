export interface WsAttachmentPayload {
  uploadSessionId: string;
}

export interface WsAudioPayload {
  url: string;
  durationSeconds: number;
}

export type WsSendAck =
  | {
      ok: true;
      workspaceId: string;
      threadId: string;
      userMessage: { id: string };
    }
  | { ok: false; message: string };

export interface WsSendMessagePayload {
  workspaceId: string;
  threadId: string;
  message: string;
  model: string;
  attachments?: WsAttachmentPayload[];
  audio?: WsAudioPayload;
  hasAudio: boolean;
}

export function createWsSendMessagePayload(
  workspaceId: string,
  threadId: string,
  message: string,
  model: string,
  attachments?: WsAttachmentPayload[],
  audio?: WsAudioPayload,
): WsSendMessagePayload {
  return {
    workspaceId,
    threadId,
    message,
    model,
    attachments,
    audio,
    hasAudio: Boolean(audio),
  };
}

export function requireSuccessfulWsAck(
  ack: WsSendAck | undefined,
  workspaceId: string,
  threadId: string,
): Extract<WsSendAck, { ok: true }> {
  if (!ack?.ok) {
    throw new Error(ack?.message || "O servidor recusou a mensagem enviada.");
  }
  if (
    ack.workspaceId !== workspaceId ||
    ack.threadId !== threadId ||
    !ack.userMessage ||
    typeof ack.userMessage.id !== "string"
  ) {
    throw new Error(
      "O servidor confirmou a mensagem em um workspace ou conversa diferente.",
    );
  }
  return ack;
}

export function shouldClearComposerAfterSend(acknowledged: boolean): boolean {
  return acknowledged;
}
