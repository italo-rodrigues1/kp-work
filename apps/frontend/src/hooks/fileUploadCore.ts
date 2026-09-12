export const DOCUMENT_MAX_BYTES = 100 * 1024 * 1024;
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
export const MAX_CONCURRENT_TRANSFERS = 3;
export const MAX_TRANSFER_RETRIES = 3;
export const UPLOAD_URL_EXPIRY_SAFETY_WINDOW_MS = 5_000;
export const CANCEL_REQUEST_TIMEOUT_MS = 5_000;

export type UploadCategory = "DOCUMENT" | "MEDIA";

export interface UploadFileCandidate {
  name: string;
  size: number;
  type: string;
}

export interface ReadyUploadCandidate {
  name: string;
  uploadSessionId?: string;
}

interface QueuedTransfer {
  run: () => void;
  cancel: () => void;
}

export function classifyUpload(
  file: Pick<UploadFileCandidate, "type">,
): UploadCategory {
  const contentType = file.type.trim().toLowerCase();
  return /^(image|audio|video)\//.test(contentType) ? "MEDIA" : "DOCUMENT";
}

export function validateUploadFile(file: UploadFileCandidate): string | null {
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return `${file.name}: o arquivo precisa ter pelo menos 1 byte.`;
  }

  const category = classifyUpload(file);
  const limit = category === "MEDIA" ? MEDIA_MAX_BYTES : DOCUMENT_MAX_BYTES;
  if (file.size > limit) {
    const formattedLimit = category === "MEDIA" ? "10 GiB" : "100 MiB";
    return `${file.name}: o limite para ${
      category === "MEDIA" ? "mídia" : "documentos"
    } é ${formattedLimit}.`;
  }

  return null;
}

export function buildUploadAttachmentPayload(
  attachments: ReadyUploadCandidate[],
): Array<{ uploadSessionId: string }> {
  if (attachments.length > MAX_ATTACHMENTS) {
    throw new Error(
      `Uma mensagem pode ter no máximo ${MAX_ATTACHMENTS} anexos.`,
    );
  }
  const sessionIds = new Set<string>();
  return attachments.map((attachment) => {
    if (!attachment.uploadSessionId) {
      throw new Error(`Upload do arquivo ${attachment.name} não foi concluído.`);
    }
    if (sessionIds.has(attachment.uploadSessionId)) {
      throw new Error(`O arquivo ${attachment.name} está duplicado.`);
    }
    sessionIds.add(attachment.uploadSessionId);
    return { uploadSessionId: attachment.uploadSessionId };
  });
}

export function calculateUploadProgress(
  uploadedPartBytes: Iterable<number>,
  totalBytes: number,
): number {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return 0;
  let uploadedBytes = 0;
  for (const bytes of uploadedPartBytes) {
    if (Number.isFinite(bytes) && bytes > 0) uploadedBytes += bytes;
  }
  return Math.min(100, Math.round((uploadedBytes / totalBytes) * 100));
}

export function hasUploadRetryRemaining(retriesUsed: number): boolean {
  return (
    Number.isSafeInteger(retriesUsed) &&
    retriesUsed >= 0 &&
    retriesUsed < MAX_TRANSFER_RETRIES
  );
}

export function isUploadUrlFresh(
  expiresAt: string | undefined,
  nowMs = Date.now(),
): boolean {
  if (!expiresAt) return true;
  const expiresAtMs = Date.parse(expiresAt);
  return (
    Number.isFinite(expiresAtMs) &&
    expiresAtMs - nowMs > UPLOAD_URL_EXPIRY_SAFETY_WINDOW_MS
  );
}

export function shouldRefreshSingleUploadUrl(
  uploadUrl: string | undefined,
  expiresAt: string | undefined,
  retriesUsed: number,
  nowMs = Date.now(),
): boolean {
  return (
    !uploadUrl ||
    retriesUsed > 0 ||
    !isUploadUrlFresh(expiresAt, nowMs)
  );
}

export function uploadScopeKey(workspaceId: string, threadId: string): string {
  return `${workspaceId}\u0000${threadId}`;
}

export async function withAbortTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export class TransferQueue {
  private activeCount = 0;
  private readonly pending: QueuedTransfer[] = [];
  private readonly concurrency: number;

  constructor(concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new Error("A concorrência da fila deve ser um inteiro positivo.");
    }
    this.concurrency = concurrency;
  }

  schedule<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let started = false;
      let settled = false;

      const rejectAsAborted = () => {
        if (settled || started) return;
        settled = true;
        reject(new DOMException("Upload cancelado.", "AbortError"));
      };

      const queued: QueuedTransfer = {
        cancel: rejectAsAborted,
        run: () => {
          if (settled || signal.aborted) {
            rejectAsAborted();
            return;
          }

          started = true;
          this.activeCount += 1;
          signal.removeEventListener("abort", queued.cancel);

          void Promise.resolve()
            .then(task)
            .then(resolve, reject)
            .finally(() => {
              settled = true;
              this.activeCount -= 1;
              this.pump();
            });
        },
      };

      if (signal.aborted) {
        rejectAsAborted();
        return;
      }

      signal.addEventListener("abort", queued.cancel, { once: true });
      this.pending.push(queued);
      this.pump();
    });
  }

  private pump(): void {
    while (this.activeCount < this.concurrency && this.pending.length > 0) {
      this.pending.shift()?.run();
    }
  }
}

const uploadTransferQueue = new TransferQueue(MAX_CONCURRENT_TRANSFERS);

export function scheduleUploadTransfer<T>(
  task: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return uploadTransferQueue.schedule(task, signal);
}
