import type { Thread, Message, FileAttachment } from "../types/chat";
import type { Workspace } from "../types/workspace";
import type { Agent } from "../types/agent";

const API_ORIGIN = (
  import.meta.env.VITE_API_URL || "http://localhost:3001"
).replace(/\/+$/, "");
const API_BASE = `${API_ORIGIN}/api`;

export interface UploadSession {
  id: string;
  threadId: string;
  name: string;
  size: number;
  type: string;
  status: "PENDING" | "COMPLETING" | "COMPLETED" | "ATTACHED" | "DELETING";
  mode: "SINGLE" | "MULTIPART";
  category: "DOCUMENT" | "MEDIA";
  uploadUrl?: string;
  uploadHeaders?: Record<string, string>;
  uploadUrlExpiresAt?: string;
  partSize?: number;
  partCount?: number;
  downloadUrl?: string;
  expiresAt: string;
  completedAt?: string;
}

export interface UploadPartUrl {
  partNumber: number;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  uploadUrlExpiresAt?: string;
}

export interface UploadPartUrlsResponse {
  parts: UploadPartUrl[];
  expiresAt: string;
}

export class ApiRequestError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(
    message: string,
    status: number,
    code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

export class UploadRequestError extends Error {
  readonly status: number;
  readonly responseWasAmbiguous: boolean;

  constructor(
    message: string,
    status: number,
    responseWasAmbiguous = false,
  ) {
    super(message);
    this.name = "UploadRequestError";
    this.status = status;
    this.responseWasAmbiguous = responseWasAmbiguous;
  }
}

interface RawAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  url?: string;
}

interface RawAudio {
  id: string;
  url: string;
  durationSeconds: number;
}

interface RawMessage {
  id: string;
  sender: "user" | "assistant";
  content: string;
  createdAt: string;
  model?: string;
  attachments?: RawAttachment[];
  audio?: RawAudio;
}

interface RawThread {
  id: string;
  workspaceId: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt?: string;
  messages?: RawMessage[];
}

interface RawWorkspace {
  id: string;
  name: string;
  color: string;
  createdAt: string;
  updatedAt: string;
  _count?: { threads?: number };
}

function formatTimestamp(isoDate: string): string {
  if (!isoDate)
    return new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  const d = new Date(isoDate);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function getErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) return body.message.join(", ");
    return body.message || fallback;
  } catch {
    return fallback;
  }
}

async function createApiError(
  response: Response,
  fallback: string,
): Promise<ApiRequestError> {
  try {
    const body = (await response.json()) as {
      message?: string | string[];
      code?: string;
    };
    const message = Array.isArray(body.message)
      ? body.message.join(", ")
      : body.message || fallback;
    return new ApiRequestError(message, response.status, body.code);
  } catch {
    return new ApiRequestError(fallback, response.status);
  }
}

export function resolveApiUrl(url?: string): string | undefined {
  if (!url) return undefined;
  return new URL(url, `${API_ORIGIN}/`).toString();
}

export function mapRawMessage(msg: RawMessage): Message {
  return {
    id: msg.id,
    sender: msg.sender,
    content: msg.content,
    timestamp: formatTimestamp(msg.createdAt),
    model: msg.model,
    attachments: msg.attachments
      ? msg.attachments.map((att): FileAttachment => ({
          id: att.id,
          name: att.name,
          size: att.size,
          type: att.type,
          url: resolveApiUrl(att.url),
          uploadStatus: "completed",
        }))
      : [],
    audio: msg.audio
      ? {
          id: msg.audio.id,
          url: msg.audio.url,
          durationSeconds: msg.audio.durationSeconds,
        }
      : undefined,
  };
}

export function mapRawThread(thread: RawThread): Thread {
  return {
    id: thread.id,
    workspaceId: thread.workspaceId,
    title: thread.title,
    model: thread.model,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messages: thread.messages ? thread.messages.map(mapRawMessage) : [],
  };
}

function workspaceThreadsUrl(workspaceId: string): string {
  return `${API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/threads`;
}

function mapRawWorkspace(workspace: RawWorkspace): Workspace {
  return {
    id: workspace.id,
    name: workspace.name,
    color: workspace.color,
    threadCount: workspace._count?.threads ?? 0,
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

export async function fetchWorkspaces(
  signal?: AbortSignal,
): Promise<Workspace[]> {
  const res = await fetch(`${API_BASE}/workspaces`, { signal });
  if (!res.ok) throw new Error("Falha ao buscar workspaces");
  const rawWorkspaces = (await res.json()) as RawWorkspace[];
  return rawWorkspaces.map(mapRawWorkspace);
}

export async function createWorkspace(data: {
  name: string;
  color: string;
}): Promise<Workspace> {
  const res = await fetch(`${API_BASE}/workspaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    throw new Error(await getErrorMessage(res, "Falha ao criar workspace"));
  }
  return mapRawWorkspace((await res.json()) as RawWorkspace);
}

export async function fetchAgents(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<Agent[]> {
  const res = await fetch(
    `${API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/agents`,
    { signal },
  );
  if (!res.ok) throw new Error("Falha ao buscar agentes do workspace");
  return (await res.json()) as Agent[];
}

export async function createAgent(
  workspaceId: string,
  data: Omit<Agent, "id" | "createdAt">,
): Promise<Agent> {
  const res = await fetch(
    `${API_BASE}/workspaces/${encodeURIComponent(workspaceId)}/agents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  if (!res.ok) {
    throw new Error(await getErrorMessage(res, "Falha ao criar agente"));
  }
  return (await res.json()) as Agent;
}

export async function fetchThreads(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<Thread[]> {
  const res = await fetch(workspaceThreadsUrl(workspaceId), { signal });
  if (!res.ok) throw new Error("Falha ao buscar conversas no banco de dados");
  const rawThreads = (await res.json()) as RawThread[];
  return rawThreads.map(mapRawThread);
}

export async function fetchThread(
  workspaceId: string,
  id: string,
  signal?: AbortSignal,
): Promise<Thread> {
  const res = await fetch(
    `${workspaceThreadsUrl(workspaceId)}/${encodeURIComponent(id)}`,
    { signal },
  );
  if (!res.ok) throw new Error(`Falha ao buscar conversa com ID ${id}`);
  const rawThread = (await res.json()) as RawThread;
  return mapRawThread(rawThread);
}

export async function createThread(
  workspaceId: string,
  title?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<Thread> {
  const res = await fetch(workspaceThreadsUrl(workspaceId), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, model }),
    signal,
  });
  if (!res.ok) throw new Error("Falha ao criar conversa no banco de dados");
  const rawThread = (await res.json()) as RawThread;
  return mapRawThread(rawThread);
}

export async function updateThread(
  workspaceId: string,
  id: string,
  data: { title?: string; model?: string },
): Promise<Thread> {
  const res = await fetch(
    `${workspaceThreadsUrl(workspaceId)}/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
  );
  if (!res.ok) throw new Error(`Falha ao atualizar conversa ${id}`);
  const rawThread = (await res.json()) as RawThread;
  return mapRawThread(rawThread);
}

export async function deleteThread(
  workspaceId: string,
  id: string,
): Promise<void> {
  const res = await fetch(
    `${workspaceThreadsUrl(workspaceId)}/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) throw new Error(`Falha ao excluir conversa ${id}`);
}

export async function sendMessageHttp(payload: {
  workspaceId: string;
  threadId: string;
  message?: string;
  model: string;
  attachments?: Array<{ uploadSessionId: string }>;
  audio?: { url: string; durationSeconds: number };
}): Promise<{
  userMessage: Message;
  assistantMessage?: Message;
  threadId: string;
  status: string;
}> {
  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Falha ao enviar mensagem via HTTP");
  const data = (await res.json()) as {
    threadId: string;
    userMessage: RawMessage;
    assistantMessage?: RawMessage;
    status?: string;
  };
  return {
    threadId: data.threadId,
    userMessage: mapRawMessage(data.userMessage),
    assistantMessage: data.assistantMessage
      ? mapRawMessage(data.assistantMessage)
      : undefined,
    status:
      data.status ||
      (data.assistantMessage ? "success_fallback" : "dispatched"),
  };
}

export async function createUploadSession(
  workspaceId: string,
  threadId: string,
  file: File,
  signal?: AbortSignal,
): Promise<UploadSession> {
  const res = await fetch(`${API_BASE}/uploads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId,
      threadId,
      fileName: file.name,
      size: file.size,
      contentType: file.type || "application/octet-stream",
    }),
    signal,
  });
  if (!res.ok) {
    throw await createApiError(res, "Falha ao iniciar o upload.");
  }
  return (await res.json()) as UploadSession;
}

export function uploadBlobToSignedUrl(
  uploadUrl: string,
  body: Blob,
  uploadHeaders: Record<string, string> = {},
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();

    if (signal?.aborted) {
      reject(new DOMException("Upload cancelado.", "AbortError"));
      return;
    }

    xhr.open("PUT", uploadUrl);
    const abortUpload = () => xhr.abort();
    signal?.addEventListener("abort", abortUpload, { once: true });

    const cleanup = () => {
      signal?.removeEventListener("abort", abortUpload);
    };

    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress?.(event.loaded, event.total);
      }
    });
    xhr.addEventListener("load", () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(body.size, body.size);
        resolve();
      } else {
        reject(
          new UploadRequestError(
            `O armazenamento recusou o upload (${xhr.status}).`,
            xhr.status,
          ),
        );
      }
    });
    xhr.addEventListener("error", () => {
      cleanup();
      reject(
        new UploadRequestError(
          "Falha de rede durante o upload.",
          xhr.status,
          true,
        ),
      );
    });
    xhr.addEventListener("abort", () => {
      cleanup();
      reject(new DOMException("Upload cancelado.", "AbortError"));
    });

    for (const [name, value] of Object.entries(uploadHeaders)) {
      // Content-Length is controlled by the browser and cannot be set by JS.
      if (name.toLowerCase() !== "content-length") {
        xhr.setRequestHeader(name, value);
      }
    }
    xhr.send(body);
  });
}

export function uploadFileToSignedUrl(
  uploadUrl: string,
  file: File,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return uploadBlobToSignedUrl(
    uploadUrl,
    file,
    { "Content-Type": file.type || "application/octet-stream" },
    (loaded, total) => {
      onProgress(total > 0 ? Math.round((loaded / total) * 100) : 0);
    },
    signal,
  );
}

function uploadSessionUrl(id: string, suffix = ""): string {
  return `${API_BASE}/uploads/${encodeURIComponent(id)}${suffix}`;
}

function uploadWorkspaceParams(workspaceId: string): URLSearchParams {
  return new URLSearchParams({ workspaceId });
}

export async function refreshUploadUrl(
  workspaceId: string,
  id: string,
  signal?: AbortSignal,
): Promise<UploadSession> {
  const params = uploadWorkspaceParams(workspaceId);
  const res = await fetch(`${uploadSessionUrl(id, "/url")}?${params}`, {
    method: "POST",
    signal,
  });
  if (!res.ok) {
    throw await createApiError(res, "Falha ao renovar a URL de upload.");
  }
  return (await res.json()) as UploadSession;
}

export async function createUploadPartUrls(
  workspaceId: string,
  id: string,
  partNumbers: number[],
  signal?: AbortSignal,
): Promise<UploadPartUrlsResponse> {
  const params = uploadWorkspaceParams(workspaceId);
  const res = await fetch(`${uploadSessionUrl(id, "/parts")}?${params}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId, partNumbers }),
    signal,
  });
  if (!res.ok) {
    throw await createApiError(res, "Falha ao gerar as URLs das partes.");
  }
  return (await res.json()) as UploadPartUrlsResponse;
}

export async function completeUploadSession(
  workspaceId: string,
  id: string,
  signal?: AbortSignal,
): Promise<UploadSession> {
  const params = uploadWorkspaceParams(workspaceId);
  const res = await fetch(
    `${uploadSessionUrl(id, "/complete")}?${params}`,
    {
      method: "POST",
      signal,
    },
  );
  if (!res.ok) {
    throw await createApiError(res, "Falha ao confirmar o upload.");
  }
  const session = (await res.json()) as UploadSession;
  return { ...session, downloadUrl: resolveApiUrl(session.downloadUrl) };
}

export async function cancelUploadSession(
  workspaceId: string,
  id: string,
  signal?: AbortSignal,
): Promise<void> {
  const params = uploadWorkspaceParams(workspaceId);
  const res = await fetch(
    `${uploadSessionUrl(id)}?${params}`,
    { method: "DELETE", signal },
  );
  if (!res.ok && res.status !== 404) {
    throw await createApiError(res, "Falha ao cancelar o upload.");
  }
}
