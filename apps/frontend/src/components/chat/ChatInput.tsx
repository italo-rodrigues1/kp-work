import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mic,
  Paperclip,
  RotateCcw,
  Send,
  Square,
  X,
} from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";
import {
  MAX_ATTACHMENTS,
  useFileUploads,
} from "../../hooks/useFileUploads";
import { shouldClearComposerAfterSend } from "../../hooks/webSocketChatCore";
import type {
  AudioAttachment,
  FileAttachment,
  FileUploadStatus,
} from "../../types/chat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

interface ChatInputProps {
  workspaceId: string;
  threadId: string;
  onSendMessage: (
    content: string,
    attachments: FileAttachment[],
    audio?: AudioAttachment,
  ) => Promise<boolean>;
  disabled?: boolean;
  initialPrompt?: string;
}

const workingStatuses = new Set<FileUploadStatus>([
  "queued",
  "creating",
  "uploading",
  "confirming",
  "cancelling",
]);

function uploadStatusLabel(attachment: FileAttachment): string {
  switch (attachment.uploadStatus) {
    case "queued":
      return "Na fila";
    case "creating":
      return "Criando sessão";
    case "uploading":
      return `${attachment.uploadProgress ?? 0}%`;
    case "confirming":
      return "Confirmando";
    case "ready":
    case "completed":
      return "Pronto";
    case "cancelling":
      return "Cancelando";
    case "error":
      return "Falhou";
    default:
      return "Aguardando";
  }
}

export const ChatInput: React.FC<ChatInputProps> = ({
  workspaceId,
  threadId,
  onSendMessage,
  disabled = false,
  initialPrompt = "",
}) => {
  const [text, setText] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    attachments,
    validationError,
    attachmentsReady,
    addFiles,
    removeAttachment,
    retryAttachment,
    clearCompletedAttachments,
    clearValidationError,
  } = useFileUploads({ workspaceId, threadId });

  useEffect(() => {
    if (initialPrompt) setText(initialPrompt);
  }, [initialPrompt]);

  const {
    isRecording,
    recordingTime,
    startRecording,
    stopRecording,
    cancelRecording,
  } = useAudioRecorder();

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      setSubmitError(null);
      clearValidationError();
      addFiles(event.target.files);
    }
    event.target.value = "";
  };

  const submitMessage = async (
    content: string,
    audio?: AudioAttachment,
  ): Promise<boolean> => {
    if (
      isSubmitting ||
      disabled ||
      !attachmentsReady ||
      (!content.trim() && attachments.length === 0 && !audio)
    ) {
      return false;
    }

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const acknowledged = await onSendMessage(content, attachments, audio);
      if (!shouldClearComposerAfterSend(acknowledged)) {
        setSubmitError(
          "A mensagem não foi confirmada. O texto e os anexos foram preservados.",
        );
        return false;
      }
      setText("");
      clearCompletedAttachments();
      return true;
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Não foi possível confirmar o envio da mensagem.",
      );
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleMicClick = async () => {
    if (isRecording) {
      const audioAttachment = await stopRecording();
      if (audioAttachment) {
        await submitMessage("", audioAttachment);
      }
      return;
    }
    startRecording();
  };

  const handleSubmit = (event?: React.FormEvent) => {
    event?.preventDefault();
    void submitMessage(text);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const controlsDisabled = disabled || isSubmitting;
  const attachmentLimitReached = attachments.length >= MAX_ATTACHMENTS;

  return (
    <div className="w-full border-t bg-background/90 p-3 backdrop-blur md:px-6 md:py-4">
      {(validationError || submitError) && (
        <div
          role="alert"
          className="mx-auto mb-3 flex max-w-3xl items-start gap-2 rounded-lg border border-red-800/60 bg-red-950/40 px-3 py-2 text-xs text-red-200"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            {validationError || submitError}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0"
            onClick={() => {
              clearValidationError();
              setSubmitError(null);
            }}
            aria-label="Fechar aviso"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      )}

      {attachments.length > 0 && (
        <div
          className="mx-auto mb-3 flex max-w-3xl flex-wrap gap-2 px-1"
          aria-live="polite"
          aria-label="Uploads de arquivos"
        >
          {attachments.map((item) => {
            const isWorking =
              item.uploadStatus &&
              item.uploadStatus !== "completed" &&
              workingStatuses.has(item.uploadStatus);
            return (
              <div
                key={item.id}
                className="flex max-w-full items-center gap-2 rounded-lg border border-slate-700/80 bg-slate-800 px-3 py-1.5 text-xs text-slate-200"
              >
                {isWorking ? (
                  <Loader2
                    className="size-3.5 shrink-0 animate-spin text-blue-400"
                    aria-hidden="true"
                  />
                ) : item.uploadStatus === "error" ? (
                  <AlertCircle
                    className="size-3.5 shrink-0 text-red-400"
                    aria-hidden="true"
                  />
                ) : (
                  <CheckCircle2
                    className="size-3.5 shrink-0 text-emerald-400"
                    aria-hidden="true"
                  />
                )}
                <span className="min-w-0">
                  <span className="block max-w-[180px] truncate font-medium">
                    {item.name}
                  </span>
                  <span
                    className={
                      item.uploadStatus === "error"
                        ? "block max-w-[260px] truncate text-red-300"
                        : "block text-slate-400"
                    }
                    title={item.uploadError}
                  >
                    {item.uploadStatus === "error"
                      ? item.uploadError
                      : uploadStatusLabel(item)}
                  </span>
                </span>
                {item.uploadStatus === "uploading" && (
                  <progress
                    className="sr-only"
                    max={100}
                    value={item.uploadProgress ?? 0}
                    aria-label={`Progresso de ${item.name}`}
                  />
                )}
                {item.uploadStatus === "error" && item.file && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => retryAttachment(item.id)}
                    className="size-6 shrink-0"
                    aria-label={`Tentar upload de ${item.name} novamente`}
                    title="Tentar upload novamente"
                  >
                    <RotateCcw className="size-3.5" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeAttachment(item.id)}
                  disabled={item.uploadStatus === "cancelling"}
                  className="size-6 shrink-0"
                  aria-label={`Remover ${item.name}`}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {isRecording && (
        <div className="mx-auto mb-3 flex max-w-3xl items-center justify-between rounded-xl border border-red-800/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
          <div className="flex items-center gap-2">
            <span className="relative flex size-3" aria-hidden="true">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex size-3 rounded-full bg-red-500" />
            </span>
            <span className="font-semibold">
              Gravando áudio ({recordingTime}s)
            </span>
          </div>
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={cancelRecording}
          >
            Cancelar
          </Button>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="mx-auto flex max-w-3xl items-end gap-2"
      >
        <Input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          disabled={controlsDisabled || isRecording || attachmentLimitReached}
          onChange={handleFileChange}
        />

        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={controlsDisabled || isRecording || attachmentLimitReached}
          onClick={() => fileInputRef.current?.click()}
          title={
            attachmentLimitReached
              ? `Limite de ${MAX_ATTACHMENTS} anexos atingido`
              : "Anexar arquivo"
          }
          aria-label="Anexar arquivo"
          className="shrink-0 rounded-xl text-slate-400 hover:border-blue-500/50 hover:text-blue-400"
        >
          <Paperclip className="size-5" />
        </Button>

        <Textarea
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setSubmitError(null);
          }}
          onKeyDown={handleKeyDown}
          placeholder={
            isRecording ? "Gravando áudio..." : "Digite sua mensagem..."
          }
          disabled={controlsDisabled || isRecording}
          rows={1}
          className="min-h-10 max-h-32 flex-1 rounded-lg bg-card py-2.5"
        />

        <Button
          type="button"
          variant={isRecording ? "destructive" : "outline"}
          size="icon"
          disabled={controlsDisabled || !attachmentsReady}
          onClick={() => void handleMicClick()}
          title={isRecording ? "Parar gravação e enviar" : "Gravar áudio"}
          aria-label={
            isRecording ? "Parar gravação e enviar" : "Gravar áudio"
          }
          className={`shrink-0 rounded-xl transition-all ${
            isRecording
              ? "recording-pulse border-red-500 text-white"
              : "text-slate-400 hover:border-red-500/50 hover:text-red-400"
          }`}
        >
          {isRecording ? (
            <Square className="size-5 fill-current" />
          ) : (
            <Mic className="size-5" />
          )}
        </Button>

        <Button
          type="submit"
          disabled={
            controlsDisabled ||
            isRecording ||
            !attachmentsReady ||
            (!text.trim() && attachments.length === 0)
          }
          size="icon"
          className="shrink-0 rounded-xl bg-blue-600 text-white shadow-md shadow-blue-900/30 hover:bg-blue-500"
          title="Enviar mensagem"
          aria-label="Enviar mensagem"
        >
          {isSubmitting ? (
            <Loader2 className="size-5 animate-spin" />
          ) : (
            <Send className="size-5" />
          )}
        </Button>
      </form>
    </div>
  );
};
