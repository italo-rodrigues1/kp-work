import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiRequestError,
  UploadRequestError,
  cancelUploadSession,
  completeUploadSession,
  createUploadPartUrls,
  createUploadSession,
  refreshUploadUrl,
  uploadBlobToSignedUrl,
  type UploadSession,
} from "../lib/api";
import type { FileAttachment } from "../types/chat";
import {
  MAX_ATTACHMENTS,
  MAX_TRANSFER_RETRIES,
  CANCEL_REQUEST_TIMEOUT_MS,
  calculateUploadProgress,
  classifyUpload,
  hasUploadRetryRemaining,
  scheduleUploadTransfer,
  shouldRefreshSingleUploadUrl,
  uploadScopeKey,
  validateUploadFile,
  withAbortTimeout,
} from "./fileUploadCore";

export {
  DOCUMENT_MAX_BYTES,
  MAX_ATTACHMENTS,
  MAX_CONCURRENT_TRANSFERS,
  MAX_TRANSFER_RETRIES,
  CANCEL_REQUEST_TIMEOUT_MS,
  MEDIA_MAX_BYTES,
  calculateUploadProgress,
  classifyUpload,
  hasUploadRetryRemaining,
  isUploadUrlFresh,
  shouldRefreshSingleUploadUrl,
  uploadScopeKey,
  validateUploadFile,
  withAbortTimeout,
} from "./fileUploadCore";

interface UseFileUploadsOptions {
  workspaceId: string;
  threadId: string;
}

interface UseFileUploadsResult {
  attachments: FileAttachment[];
  validationError: string | null;
  attachmentsReady: boolean;
  addFiles: (files: FileList | File[]) => void;
  removeAttachment: (id: string) => void;
  retryAttachment: (id: string) => void;
  clearCompletedAttachments: () => void;
  clearValidationError: () => void;
}

function normalizedContentType(file: File): string {
  return file.type.trim() || "application/octet-stream";
}

function cancelUploadWithinTimeout(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  return withAbortTimeout(
    (signal) => cancelUploadSession(workspaceId, sessionId, signal),
    CANCEL_REQUEST_TIMEOUT_MS,
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Não foi possível enviar o arquivo.";
}

function isRetryable(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof UploadRequestError) {
    return (
      error.responseWasAmbiguous ||
      error.status === 403 ||
      error.status === 408 ||
      error.status === 412 ||
      error.status === 429 ||
      error.status >= 500
    );
  }
  if (error instanceof ApiRequestError) {
    return (
      error.status === 408 ||
      error.status === 429 ||
      (error.status === 409 && error.code === "UPLOAD_INVALID_STATE") ||
      error.status >= 500
    );
  }
  return true;
}

export function useFileUploads({
  workspaceId,
  threadId,
}: UseFileUploadsOptions): UseFileUploadsResult {
  const [attachments, setAttachmentsState] = useState<FileAttachment[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const attachmentsRef = useRef<FileAttachment[]>([]);
  const controllersRef = useRef(new Map<string, AbortController>());
  const sessionsRef = useRef(new Map<string, UploadSession>());
  const progressRef = useRef(new Map<string, Map<number, number>>());
  const completedPartsRef = useRef(new Map<string, Set<number>>());
  const mountedRef = useRef(true);
  const scopeKey = uploadScopeKey(workspaceId, threadId);
  const activeScopeKeyRef = useRef(scopeKey);
  activeScopeKeyRef.current = scopeKey;

  const updateAttachments = useCallback(
    (update: (current: FileAttachment[]) => FileAttachment[]) => {
      if (!mountedRef.current) return;
      setAttachmentsState((current) => {
        const next = update(current);
        attachmentsRef.current = next;
        return next;
      });
    },
    [],
  );

  const patchAttachment = useCallback(
    (id: string, patch: Partial<FileAttachment>) => {
      updateAttachments((current) =>
        current.map((attachment) =>
          attachment.id === id ? { ...attachment, ...patch } : attachment,
        ),
      );
    },
    [updateAttachments],
  );

  const updateProgress = useCallback(
    (id: string, partNumber: number, loadedBytes: number, totalBytes: number) => {
      const parts = progressRef.current.get(id) ?? new Map<number, number>();
      parts.set(partNumber, Math.max(0, Math.min(loadedBytes, totalBytes)));
      progressRef.current.set(id, parts);
      const progress = calculateUploadProgress(parts.values(), totalBytes);
      patchAttachment(id, { uploadProgress: progress });
    },
    [patchAttachment],
  );

  const completeWithRetry = useCallback(
    async (sessionId: string, signal: AbortSignal): Promise<UploadSession> => {
      let lastError: unknown;
      for (let attempt = 0; attempt <= MAX_TRANSFER_RETRIES; attempt += 1) {
        try {
          return await completeUploadSession(workspaceId, sessionId, signal);
        } catch (error) {
          if (isAbortError(error) || !isRetryable(error)) throw error;
          lastError = error;
        }
      }
      throw lastError;
    },
    [workspaceId],
  );

  const uploadSingle = useCallback(
    async (
      id: string,
      file: File,
      initialSession: UploadSession,
      signal: AbortSignal,
    ): Promise<UploadSession> => {
      let session = initialSession;
      let lastError: unknown;

      for (let attempt = 0; attempt <= MAX_TRANSFER_RETRIES; attempt += 1) {
        try {
          if (
            shouldRefreshSingleUploadUrl(
              session.uploadUrl,
              session.uploadUrlExpiresAt,
              attempt,
            )
          ) {
            session = await refreshUploadUrl(workspaceId, session.id, signal);
            sessionsRef.current.set(id, session);
          }

          if (!session.uploadUrl) {
            throw new Error("O backend não retornou a URL de upload.");
          }

          patchAttachment(id, { uploadStatus: "queued" });
          await scheduleUploadTransfer(
            () => {
              patchAttachment(id, { uploadStatus: "uploading" });
              return uploadBlobToSignedUrl(
                session.uploadUrl as string,
                file,
                session.uploadHeaders ?? {
                  "Content-Type": normalizedContentType(file),
                },
                (loaded) => updateProgress(id, 0, loaded, file.size),
                signal,
              );
            },
            signal,
          );
          updateProgress(id, 0, file.size, file.size);
          patchAttachment(id, { uploadStatus: "confirming" });
          return await completeWithRetry(session.id, signal);
        } catch (error) {
          if (isAbortError(error)) throw error;
          lastError = error;

          const possiblyStored =
            error instanceof UploadRequestError &&
            (error.responseWasAmbiguous || error.status === 412);
          if (possiblyStored) {
            patchAttachment(id, { uploadStatus: "confirming" });
            try {
              return await completeUploadSession(
                workspaceId,
                session.id,
                signal,
              );
            } catch (completionError) {
              if (isAbortError(completionError)) throw completionError;
              lastError = completionError;
            }
          }

          if (!hasUploadRetryRemaining(attempt) || !isRetryable(error)) {
            throw lastError;
          }
        }
      }

      throw lastError;
    },
    [completeWithRetry, patchAttachment, updateProgress, workspaceId],
  );

  const uploadMultipart = useCallback(
    async (
      id: string,
      file: File,
      session: UploadSession,
      signal: AbortSignal,
    ): Promise<UploadSession> => {
      const { partSize, partCount } = session;
      if (
        !Number.isSafeInteger(partSize) ||
        !partSize ||
        partSize <= 0 ||
        !Number.isSafeInteger(partCount) ||
        !partCount ||
        partCount <= 0
      ) {
        throw new Error("A sessão multipart retornou uma divisão inválida.");
      }

      const completedParts =
        completedPartsRef.current.get(id) ?? new Set<number>();
      completedPartsRef.current.set(id, completedParts);

      const uploadPart = async (partNumber: number): Promise<void> => {
        if (completedParts.has(partNumber)) return;
        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, file.size);
        const part = file.slice(start, end);
        let lastError: unknown;

        for (
          let attempt = 0;
          attempt <= MAX_TRANSFER_RETRIES;
          attempt += 1
        ) {
          try {
            if (attempt > 0) {
              updateProgress(id, partNumber, 0, file.size);
            }
            await scheduleUploadTransfer(async () => {
              patchAttachment(id, { uploadStatus: "uploading" });
              // A URL é solicitada somente depois que esta parte obtém uma das
              // três vagas globais de transferência.
              const response = await createUploadPartUrls(
                workspaceId,
                session.id,
                [partNumber],
                signal,
              );
              const signedPart = response.parts.find(
                (candidate) => candidate.partNumber === partNumber,
              );
              if (!signedPart) {
                throw new Error(
                  `O backend não retornou a URL da parte ${partNumber}.`,
                );
              }
              await uploadBlobToSignedUrl(
                signedPart.uploadUrl,
                part,
                signedPart.uploadHeaders,
                (loaded) => updateProgress(id, partNumber, loaded, file.size),
                signal,
              );
            }, signal);
            completedParts.add(partNumber);
            updateProgress(id, partNumber, part.size, file.size);
            return;
          } catch (error) {
            if (isAbortError(error)) throw error;
            lastError = error;
            if (!hasUploadRetryRemaining(attempt) || !isRetryable(error)) {
              throw error;
            }
          }
        }

        throw lastError;
      };

      patchAttachment(id, { uploadStatus: "queued" });
      const pendingParts = Array.from(
        { length: partCount },
        (_, index) => index + 1,
      ).filter((partNumber) => !completedParts.has(partNumber));
      const results = await Promise.allSettled(pendingParts.map(uploadPart));
      const failed = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failed) throw failed.reason;

      patchAttachment(id, { uploadStatus: "confirming" });
      return completeWithRetry(session.id, signal);
    },
    [completeWithRetry, patchAttachment, updateProgress, workspaceId],
  );

  const startUpload = useCallback(
    async (id: string, file: File) => {
      if (
        !mountedRef.current ||
        activeScopeKeyRef.current !== scopeKey
      ) {
        return;
      }
      const controller = new AbortController();
      controllersRef.current.set(id, controller);
      patchAttachment(id, {
        uploadSessionId: undefined,
        uploadStatus: "creating",
        uploadProgress: 0,
        uploadError: undefined,
        url: undefined,
        uploadMode: undefined,
      });

      try {
        const session = await createUploadSession(
          workspaceId,
          threadId,
          file,
          controller.signal,
        );
        sessionsRef.current.set(id, session);

        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          activeScopeKeyRef.current !== scopeKey
        ) {
          sessionsRef.current.delete(id);
          void cancelUploadWithinTimeout(workspaceId, session.id).catch(
            () => {},
          );
          return;
        }

        patchAttachment(id, {
          uploadSessionId: session.id,
          uploadMode: session.mode,
          uploadCategory: session.category,
          uploadStatus: "queued",
        });

        const completed =
          session.mode === "MULTIPART"
            ? await uploadMultipart(id, file, session, controller.signal)
            : await uploadSingle(id, file, session, controller.signal);
        if (
          controller.signal.aborted ||
          !mountedRef.current ||
          activeScopeKeyRef.current !== scopeKey
        ) {
          sessionsRef.current.delete(id);
          void cancelUploadWithinTimeout(workspaceId, completed.id).catch(
            () => {},
          );
          return;
        }
        sessionsRef.current.set(id, completed);
        patchAttachment(id, {
          uploadSessionId: completed.id,
          url: completed.downloadUrl,
          uploadStatus: "ready",
          uploadProgress: 100,
          uploadError: undefined,
          uploadMode: completed.mode,
          uploadCategory: completed.category,
        });
      } catch (error) {
        if (isAbortError(error)) return;
        patchAttachment(id, {
          uploadStatus: "error",
          uploadError: errorMessage(error),
        });
      } finally {
        if (controllersRef.current.get(id) === controller) {
          controllersRef.current.delete(id);
        }
      }
    },
    [
      patchAttachment,
      scopeKey,
      threadId,
      uploadMultipart,
      uploadSingle,
      workspaceId,
    ],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const selected = Array.from(files);
      const availableSlots = Math.max(
        0,
        MAX_ATTACHMENTS - attachmentsRef.current.length,
      );
      const accepted: FileAttachment[] = [];
      const errors: string[] = [];

      for (const file of selected) {
        if (accepted.length >= availableSlots) {
          errors.push(`O limite é de ${MAX_ATTACHMENTS} anexos por mensagem.`);
          break;
        }
        const validationMessage = validateUploadFile(file);
        if (validationMessage) {
          errors.push(validationMessage);
          continue;
        }
        accepted.push({
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          type: normalizedContentType(file),
          file,
          uploadStatus: "queued",
          uploadProgress: 0,
          uploadCategory: classifyUpload(file),
        });
      }

      setValidationError(errors.length > 0 ? errors.join(" ") : null);
      if (accepted.length === 0) return;
      updateAttachments((current) => [...current, ...accepted]);
      for (const attachment of accepted) {
        void startUpload(attachment.id, attachment.file as File);
      }
    },
    [startUpload, updateAttachments],
  );

  const removeAttachment = useCallback(
    (id: string) => {
      const attachment = attachmentsRef.current.find((item) => item.id === id);
      if (!attachment || attachment.uploadStatus === "cancelling") return;
      patchAttachment(id, { uploadStatus: "cancelling" });
      controllersRef.current.get(id)?.abort();
      const sessionId =
        sessionsRef.current.get(id)?.id ?? attachment.uploadSessionId;

      void (async () => {
        if (sessionId) {
          try {
            await cancelUploadWithinTimeout(workspaceId, sessionId);
          } catch (error) {
            console.warn("Não foi possível cancelar a sessão de upload:", error);
          }
        }
        sessionsRef.current.delete(id);
        progressRef.current.delete(id);
        completedPartsRef.current.delete(id);
        updateAttachments((current) =>
          current.filter((item) => item.id !== id),
        );
      })();
    },
    [patchAttachment, updateAttachments, workspaceId],
  );

  const retryAttachment = useCallback(
    (id: string) => {
      const attachment = attachmentsRef.current.find((item) => item.id === id);
      if (
        !attachment?.file ||
        attachment.uploadStatus !== "error" ||
        controllersRef.current.has(id)
      ) {
        return;
      }

      patchAttachment(id, { uploadStatus: "cancelling" });
      const sessionId =
        sessionsRef.current.get(id)?.id ?? attachment.uploadSessionId;
      void (async () => {
        if (sessionId) {
          try {
            await cancelUploadWithinTimeout(workspaceId, sessionId);
          } catch (error) {
            console.warn("Não foi possível limpar o upload anterior:", error);
          }
        }
        if (
          !mountedRef.current ||
          activeScopeKeyRef.current !== scopeKey
        ) {
          return;
        }
        sessionsRef.current.delete(id);
        progressRef.current.delete(id);
        completedPartsRef.current.delete(id);
        patchAttachment(id, {
          uploadSessionId: undefined,
          uploadStatus: "queued",
          uploadProgress: 0,
          uploadError: undefined,
          url: undefined,
          uploadMode: undefined,
        });
        await startUpload(id, attachment.file as File);
      })();
    },
    [patchAttachment, scopeKey, startUpload, workspaceId],
  );

  const clearCompletedAttachments = useCallback(() => {
    attachmentsRef.current = [];
    sessionsRef.current.clear();
    progressRef.current.clear();
    completedPartsRef.current.clear();
    setAttachmentsState([]);
    setValidationError(null);
  }, []);

  const clearValidationError = useCallback(() => {
    setValidationError(null);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const controllers = controllersRef.current;
    const sessions = sessionsRef.current;
    attachmentsRef.current = [];
    progressRef.current.clear();
    completedPartsRef.current.clear();
    setAttachmentsState([]);
    setValidationError(null);

    return () => {
      mountedRef.current = false;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      for (const session of sessions.values()) {
        void cancelUploadWithinTimeout(workspaceId, session.id).catch(() => {});
      }
      sessions.clear();
    };
  }, [scopeKey, workspaceId]);

  const attachmentsReady = attachments.every(
    (attachment) =>
      attachment.uploadStatus === "ready" &&
      Boolean(attachment.uploadSessionId),
  );

  return {
    attachments,
    validationError,
    attachmentsReady,
    addFiles,
    removeAttachment,
    retryAttachment,
    clearCompletedAttachments,
    clearValidationError,
  };
}
