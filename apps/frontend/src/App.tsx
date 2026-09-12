import { useState, useRef, useEffect, useCallback } from "react";
import type {
  Message,
  FileAttachment,
  AudioAttachment,
  Thread,
} from "./types/chat";
import { ChatHeader } from "./components/chat/ChatHeader";
import { ChatMessage } from "./components/chat/ChatMessage";
import { ChatInput } from "./components/chat/ChatInput";
import { ChatSidebar } from "./components/chat/ChatSidebar";
import { ChatWelcome } from "./components/chat/ChatWelcome";
import { AgentsPage } from "./components/agents/AgentsPage";
import type { Agent } from "./types/agent";
import type { Workspace } from "./types/workspace";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { useWebSocketChat } from "./hooks/useWebSocketChat";
import { buildUploadAttachmentPayload } from "./hooks/fileUploadCore";
import { useSSENotifications } from "./hooks/useSSENotifications";
import {
  fetchThreads,
  fetchThread,
  fetchWorkspaces,
  createWorkspace as apiCreateWorkspace,
  createThread as apiCreateThread,
  updateThread as apiUpdateThread,
  deleteThread as apiDeleteThread,
  sendMessageHttp,
  fetchAgents,
  createAgent as apiCreateAgent,
} from "./lib/api";
import { Bell, Loader2, X } from "lucide-react";

const defaultAgents: Agent[] = [
  {
    id: "content-agent",
    name: "Criador de conteúdo",
    description: "Planeja e escreve conteúdos para redes sociais e campanhas.",
    instructions: "Crie conteúdo claro e envolvente.",
    model: "openai/gpt-4o",
    tools: ["Pesquisa web", "Imagens"],
    createdAt: new Date().toISOString(),
  },
  {
    id: "research-agent",
    name: "Analista de pesquisa",
    description:
      "Pesquisa fontes, compara informações e produz resumos objetivos.",
    instructions: "Sempre cite as fontes utilizadas.",
    model: "openai/gpt-4o",
    tools: ["Pesquisa web"],
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: "code-agent",
    name: "Assistente de código",
    description:
      "Ajuda a desenvolver, revisar e explicar código com boas práticas.",
    instructions: "Priorize soluções simples e seguras.",
    model: "anthropic/claude-3.5-sonnet",
    tools: ["Terminal", "Arquivos"],
    createdAt: new Date(Date.now() - 172800000).toISOString(),
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgent(value: unknown): value is Agent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.instructions === "string" &&
    typeof value.model === "string" &&
    typeof value.createdAt === "string" &&
    Array.isArray(value.tools) &&
    value.tools.every((tool) => typeof tool === "string")
  );
}

function readLegacyAgents(workspaceId: string): Agent[] {
  const saved = localStorage.getItem("chat_ai_agents_by_workspace");
  if (saved) {
    try {
      const parsed: unknown = JSON.parse(saved);
      if (isRecord(parsed)) {
        const scopedAgents = parsed[workspaceId];
        if (Array.isArray(scopedAgents)) {
          return scopedAgents.filter(isAgent);
        }
      }
    } catch {
      // Fall through to the pre-workspace legacy key for the default space.
    }
  }

  if (workspaceId !== "workspace-default") return [];
  const legacySaved = localStorage.getItem("chat_ai_agents");
  if (!legacySaved) return defaultAgents;
  try {
    const parsed: unknown = JSON.parse(legacySaved);
    return Array.isArray(parsed) ? parsed.filter(isAgent) : defaultAgents;
  } catch {
    return defaultAgents;
  }
}

function dispatchKey(workspaceId: string, threadId: string): string {
  return `${workspaceId}:${threadId}`;
}

function mergeCompletedAssistant(
  messages: Message[],
  completedMessage: Message,
): Message[] {
  const nextMessages = [...messages];
  const existingIndex = nextMessages.findIndex(
    (message) => message.id === completedMessage.id,
  );
  let streamingIndex = -1;

  for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
    const message = nextMessages[index];
    if (message.sender === "assistant" && message.isStreaming) {
      streamingIndex = index;
      break;
    }
  }

  if (existingIndex >= 0) {
    nextMessages[existingIndex] = {
      ...nextMessages[existingIndex],
      ...completedMessage,
      isStreaming: false,
    };
    return nextMessages;
  }

  if (streamingIndex >= 0) {
    nextMessages[streamingIndex] = completedMessage;
    return nextMessages;
  }

  return [...nextMessages, completedMessage];
}

function mergePersistedUser(
  messages: Message[],
  temporaryMessageId: string,
  persistedMessage: Message,
): Message[] {
  const nextMessages = [...messages];
  const temporaryIndex = nextMessages.findIndex(
    (message) => message.id === temporaryMessageId,
  );
  const persistedIndex = nextMessages.findIndex(
    (message) => message.id === persistedMessage.id,
  );

  if (persistedIndex >= 0) {
    nextMessages[persistedIndex] = {
      ...nextMessages[persistedIndex],
      ...persistedMessage,
    };
    if (temporaryIndex >= 0 && temporaryIndex !== persistedIndex) {
      nextMessages.splice(temporaryIndex, 1);
    }
    return nextMessages;
  }

  if (temporaryIndex >= 0) {
    nextMessages[temporaryIndex] = persistedMessage;
    return nextMessages;
  }

  const streamingIndex = nextMessages.findIndex(
    (message) => message.sender === "assistant" && message.isStreaming,
  );
  nextMessages.splice(
    streamingIndex >= 0 ? streamingIndex : nextMessages.length,
    0,
    persistedMessage,
  );
  return nextMessages;
}

function hasAssistantAfterUser(thread: Thread, userMessageId: string): boolean {
  const userMessageIndex = thread.messages.findIndex(
    (message) => message.id === userMessageId,
  );
  return (
    userMessageIndex >= 0 &&
    thread.messages
      .slice(userMessageIndex + 1)
      .some((message) => message.sender === "assistant")
  );
}

function withPendingAssistant(
  thread: Thread,
  userMessageId: string,
): Thread {
  if (
    thread.messages.some(
      (message) => message.sender === "assistant" && message.isStreaming,
    )
  ) {
    return thread;
  }

  return {
    ...thread,
    messages: [
      ...thread.messages,
      {
        id: `ai-pending-${userMessageId}`,
        sender: "assistant",
        content: "",
        timestamp: new Date().toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        isStreaming: true,
        model: thread.model,
      },
    ],
  };
}

export function App() {
  const [activeView, setActiveView] = useState<"chat" | "agents">("chat");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("");
  const [agents, setAgents] = useState<Agent[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>("");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isThreadsLoading, setIsThreadsLoading] = useState(false);
  const [suggestedPrompt, setSuggestedPrompt] = useState("");
  const [toastNotification, setToastNotification] = useState<{
    title?: string;
    message: string;
  } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  const activeThreadIdRef = useRef(activeThreadId);
  const threadsRef = useRef(threads);
  const loadingTargetRef = useRef<{
    workspaceId: string;
    threadId: string;
  } | null>(null);
  const pendingDispatchesRef = useRef(new Map<string, string>());
  const dispatchPollControllersRef = useRef(new Map<string, AbortController>());
  const isCreatingThreadRef = useRef(false);
  const createThreadControllerRef = useRef<AbortController | null>(null);
  const [isCreatingThread, setIsCreatingThread] = useState(false);

  activeWorkspaceIdRef.current = activeWorkspaceId;
  activeThreadIdRef.current = activeThreadId;
  threadsRef.current = threads;

  const finishLoading = useCallback((workspaceId: string, threadId: string) => {
    const target = loadingTargetRef.current;
    if (
      activeWorkspaceIdRef.current !== workspaceId ||
      target?.workspaceId !== workspaceId ||
      target.threadId !== threadId
    ) {
      return;
    }

    loadingTargetRef.current = null;
    setIsLoading(false);
  }, []);

  const stopDispatchReconciliation = useCallback(
    (workspaceId: string, threadId: string) => {
      const key = dispatchKey(workspaceId, threadId);
      dispatchPollControllersRef.current.get(key)?.abort();
      dispatchPollControllersRef.current.delete(key);
      pendingDispatchesRef.current.delete(key);
    },
    [],
  );

  const startDispatchReconciliation = useCallback(
    (
      workspaceId: string,
      threadId: string,
      persistedUserMessageId: string,
    ) => {
      const key = dispatchKey(workspaceId, threadId);
      dispatchPollControllersRef.current.get(key)?.abort();
      dispatchPollControllersRef.current.delete(key);

      const reconciliationToken =
        persistedUserMessageId ||
        pendingDispatchesRef.current.get(key);
      if (!reconciliationToken) return;
      pendingDispatchesRef.current.set(key, reconciliationToken);

      // Keep the pending dispatch metadata while another workspace is active.
      // Its loader/poller is restored when this workspace is selected again.
      if (activeWorkspaceIdRef.current !== workspaceId) return;

      const controller = new AbortController();
      dispatchPollControllersRef.current.set(key, controller);

      const releaseController = () => {
        if (dispatchPollControllersRef.current.get(key) === controller) {
          dispatchPollControllersRef.current.delete(key);
        }
      };

      void (async () => {
        for (let attempt = 0; attempt < 45; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (
            controller.signal.aborted ||
            activeWorkspaceIdRef.current !== workspaceId ||
            pendingDispatchesRef.current.get(key) !== reconciliationToken
          ) {
            releaseController();
            return;
          }

          try {
            const updatedThread = await fetchThread(
              workspaceId,
              threadId,
              controller.signal,
            );
            const hasAssistantResponse = hasAssistantAfterUser(
              updatedThread,
              persistedUserMessageId,
            );

            if (!hasAssistantResponse) continue;
            if (activeWorkspaceIdRef.current !== workspaceId) {
              releaseController();
              return;
            }

            setThreads((current) =>
              activeWorkspaceIdRef.current === workspaceId
                ? current.map((thread) =>
                    thread.id === threadId ? updatedThread : thread,
                  )
                : current,
            );
            stopDispatchReconciliation(workspaceId, threadId);
            finishLoading(workspaceId, threadId);
            return;
          } catch (error) {
            if (controller.signal.aborted) {
              releaseController();
              return;
            }
            if (attempt === 44) {
              console.warn("Falha ao reconciliar resposta despachada:", error);
            }
          }
        }

        if (activeWorkspaceIdRef.current !== workspaceId) {
          releaseController();
          return;
        }
        setThreads((current) =>
          activeWorkspaceIdRef.current === workspaceId
            ? current.map((thread) =>
                thread.id === threadId
                  ? {
                      ...thread,
                      messages: thread.messages.filter(
                        (message) =>
                          !(
                            message.sender === "assistant" &&
                            message.isStreaming
                          ),
                      ),
                    }
                  : thread,
              )
            : current,
        );
        stopDispatchReconciliation(workspaceId, threadId);
        finishLoading(workspaceId, threadId);
        setToastNotification({
          title: "Resposta ainda não recebida",
          message:
            "A tarefa continua no servidor. Reabra a conversa para buscar a resposta mais recente.",
        });
      })();
    },
    [finishLoading, stopDispatchReconciliation],
  );

  useEffect(
    () => () => {
      for (const controller of dispatchPollControllersRef.current.values()) {
        controller.abort();
      }
      dispatchPollControllersRef.current.clear();
      pendingDispatchesRef.current.clear();
    },
    [],
  );

  const handleCreateAgent = async (
    agent: Omit<Agent, "id" | "createdAt">,
  ) => {
    const workspaceId = activeWorkspaceIdRef.current;
    if (!workspaceId) return;
    try {
      const createdAgent = await apiCreateAgent(workspaceId, agent);
      if (activeWorkspaceIdRef.current === workspaceId) {
        setAgents((current) => [createdAgent, ...current]);
      }
    } catch (error) {
      console.error("Erro ao criar agente:", error);
      if (activeWorkspaceIdRef.current === workspaceId) {
        setToastNotification({
          title: "Erro",
          message: "Não foi possível criar o agente neste workspace.",
        });
      }
    }
  };

  const activeThread =
    threads.find((t) => t.id === activeThreadId) || threads[0];

  // Load available workspaces before requesting any scoped content.
  useEffect(() => {
    const controller = new AbortController();
    let isMounted = true;

    async function loadWorkspaces() {
      try {
        const fetchedWorkspaces = await fetchWorkspaces(controller.signal);
        if (!isMounted) return;

        setWorkspaces(fetchedWorkspaces);
        const savedWorkspaceId = localStorage.getItem(
          "chat_active_workspace_id",
        );
        const selectedWorkspace =
          fetchedWorkspaces.find(
            (workspace) => workspace.id === savedWorkspaceId,
          ) || fetchedWorkspaces[0];

        if (!selectedWorkspace) {
          throw new Error("Nenhum workspace disponível.");
        }

        activeWorkspaceIdRef.current = selectedWorkspace.id;
        setActiveWorkspaceId(selectedWorkspace.id);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("Erro ao carregar conversas do backend:", err);
        setToastNotification({
          title: "Erro de Conexão",
          message: "Não foi possível carregar os workspaces do servidor.",
        });
        setIsInitializing(false);
      }
    }

    void loadWorkspaces();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, []);

  // Reload only the conversations that belong to the selected workspace.
  useEffect(() => {
    if (!activeWorkspaceId) return;

    const controller = new AbortController();
    let isMounted = true;

    setIsThreadsLoading(true);
    setThreads([]);
    activeThreadIdRef.current = "";
    setActiveThreadId("");

    async function loadWorkspaceThreads() {
      try {
        const fetchedThreads = await fetchThreads(
          activeWorkspaceId,
          controller.signal,
        );
        if (!isMounted) return;

        if (fetchedThreads.length > 0) {
          const savedActive = localStorage.getItem(
            `chat_active_thread_id:${activeWorkspaceId}`,
          );
          const selectedThreadId =
            savedActive &&
            fetchedThreads.some((thread) => thread.id === savedActive)
              ? savedActive
              : fetchedThreads[0].id;
          const unresolvedDispatches: Array<{
            threadId: string;
            userMessageId: string;
          }> = [];
          const hydratedThreads = fetchedThreads.map((thread) => {
            const pendingUserMessageId = pendingDispatchesRef.current.get(
              dispatchKey(activeWorkspaceId, thread.id),
            );
            if (!pendingUserMessageId) return thread;
            if (hasAssistantAfterUser(thread, pendingUserMessageId)) {
              stopDispatchReconciliation(activeWorkspaceId, thread.id);
              return thread;
            }

            unresolvedDispatches.push({
              threadId: thread.id,
              userMessageId: pendingUserMessageId,
            });
            return withPendingAssistant(thread, pendingUserMessageId);
          });

          setThreads(hydratedThreads);
          activeThreadIdRef.current = selectedThreadId;
          setActiveThreadId(selectedThreadId);
          const selectedDispatchPending = unresolvedDispatches.some(
            (dispatch) => dispatch.threadId === selectedThreadId,
          );
          loadingTargetRef.current = selectedDispatchPending
            ? { workspaceId: activeWorkspaceId, threadId: selectedThreadId }
            : null;
          setIsLoading(selectedDispatchPending);
          for (const dispatch of unresolvedDispatches) {
            startDispatchReconciliation(
              activeWorkspaceId,
              dispatch.threadId,
              dispatch.userMessageId,
            );
          }
          return;
        }

        const newThread = await apiCreateThread(
          activeWorkspaceId,
          "Nova Conversa",
          "openai/gpt-4o",
          controller.signal,
        );
        if (!isMounted) return;
        activeThreadIdRef.current = newThread.id;
        setThreads([newThread]);
        setActiveThreadId(newThread.id);
      } catch (err) {
        if (controller.signal.aborted) return;
        console.error("Erro ao carregar conversas do backend:", err);
        setToastNotification({
          title: "Erro de Conexão",
          message: "Não foi possível carregar as conversas deste workspace.",
        });
      } finally {
        if (isMounted) {
          setIsThreadsLoading(false);
          setIsInitializing(false);
        }
      }
    }

    void loadWorkspaceThreads();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [
    activeWorkspaceId,
    startDispatchReconciliation,
    stopDispatchReconciliation,
  ]);

  // Agents are persisted in the workspace database. Legacy browser data is
  // imported once so existing local agents are not lost during the upgrade.
  useEffect(() => {
    if (!activeWorkspaceId) return;

    const workspaceId = activeWorkspaceId;
    const controller = new AbortController();
    let isMounted = true;
    setAgents([]);

    async function loadWorkspaceAgents() {
      try {
        const persistedAgents = await fetchAgents(
          workspaceId,
          controller.signal,
        );
        if (!isMounted || activeWorkspaceIdRef.current !== workspaceId) return;

        const migrationKey = `chat_ai_agents_db_migrated:${workspaceId}`;
        if (
          persistedAgents.length === 0 &&
          localStorage.getItem(migrationKey) !== "true"
        ) {
          const legacyAgents = readLegacyAgents(workspaceId);
          const migratedAgents: Agent[] = [];
          for (const legacyAgent of legacyAgents) {
            migratedAgents.push(
              await apiCreateAgent(workspaceId, {
                name: legacyAgent.name,
                description: legacyAgent.description,
                instructions: legacyAgent.instructions,
                model: legacyAgent.model,
                tools: legacyAgent.tools,
              }),
            );
          }
          localStorage.setItem(migrationKey, "true");
          if (isMounted && activeWorkspaceIdRef.current === workspaceId) {
            setAgents(migratedAgents.toReversed());
          }
          return;
        }

        localStorage.setItem(migrationKey, "true");
        setAgents(persistedAgents);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("Erro ao carregar agentes:", error);
        if (activeWorkspaceIdRef.current === workspaceId) {
          setToastNotification({
            title: "Erro de Conexão",
            message: "Não foi possível carregar os agentes deste workspace.",
          });
        }
      }
    }

    void loadWorkspaceAgents();
    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (activeWorkspaceId) {
      localStorage.setItem("chat_active_workspace_id", activeWorkspaceId);
    }
  }, [activeWorkspaceId]);

  // Remember an independent active conversation for every workspace.
  useEffect(() => {
    if (activeWorkspaceId && activeThreadId) {
      localStorage.setItem(
        `chat_active_thread_id:${activeWorkspaceId}`,
        activeThreadId,
      );
    }
  }, [activeWorkspaceId, activeThreadId]);

  // SSE Notifications hook
  const { isConnected: sseConnected, lastNotification } =
    useSSENotifications(activeWorkspaceId);

  // Handle incoming SSE Notifications
  useEffect(() => {
    if (
      lastNotification &&
      lastNotification.type !== "ping" &&
      (!lastNotification.workspaceId ||
        lastNotification.workspaceId === activeWorkspaceIdRef.current)
    ) {
      setToastNotification({
        title: lastNotification.title || "Notificação do Sistema",
        message: lastNotification.message,
      });
      const timer = setTimeout(() => setToastNotification(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [lastNotification]);

  // A completion notification is also a reconciliation path when a socket
  // event was missed (for example, while the browser was reconnecting).
  useEffect(() => {
    if (
      lastNotification?.title !== "Resposta do Agente Concluída" ||
      !lastNotification.workspaceId ||
      !lastNotification.threadId ||
      lastNotification.workspaceId !== activeWorkspaceIdRef.current
    ) {
      return;
    }

    const controller = new AbortController();
    const workspaceId = lastNotification.workspaceId;
    const threadId = lastNotification.threadId;

    void fetchThread(workspaceId, threadId, controller.signal)
      .then((updatedThread) => {
        if (
          controller.signal.aborted ||
          activeWorkspaceIdRef.current !== workspaceId
        ) {
          return;
        }
        setThreads((current) => {
          if (activeWorkspaceIdRef.current !== workspaceId) return current;
          return current.map((thread) =>
            thread.id === threadId ? updatedThread : thread,
          );
        });
        stopDispatchReconciliation(workspaceId, threadId);
        finishLoading(workspaceId, threadId);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.warn("Falha ao reconciliar a resposta concluída:", error);
        }
      });

    return () => controller.abort();
  }, [finishLoading, lastNotification, stopDispatchReconciliation]);

  // WebSocket Chat callbacks
  const handleWsChunk = useCallback(
    (
      workspaceId: string,
      threadId: string,
      _chunk: string,
      accumulated: string,
    ) => {
      if (activeWorkspaceIdRef.current !== workspaceId) return;
      setThreads((prev) =>
        activeWorkspaceIdRef.current === workspaceId
          ? prev.map((t) => {
              if (t.id !== threadId) return t;
              const streamingIndex = t.messages.findLastIndex(
                (message) =>
                  message.sender === "assistant" && message.isStreaming,
              );
              if (streamingIndex < 0) return t;
              const updatedMessages = [...t.messages];
              updatedMessages[streamingIndex] = {
                ...updatedMessages[streamingIndex],
                content: accumulated,
              };
              return { ...t, messages: updatedMessages };
            })
          : prev,
      );
    },
    [],
  );

  const handleWsComplete = useCallback(
    (workspaceId: string, threadId: string, message: Message) => {
      if (activeWorkspaceIdRef.current !== workspaceId) return;
      setThreads((prev) =>
        activeWorkspaceIdRef.current === workspaceId
          ? prev.map((thread) =>
              thread.id === threadId
                ? {
                    ...thread,
                    messages: mergeCompletedAssistant(thread.messages, message),
                  }
                : thread,
            )
          : prev,
      );
      stopDispatchReconciliation(workspaceId, threadId);
      finishLoading(workspaceId, threadId);
    },
    [finishLoading, stopDispatchReconciliation],
  );

  const handleWsTyping = useCallback(
    (workspaceId: string, threadId: string, isTyping: boolean) => {
      if (!isTyping) {
        finishLoading(workspaceId, threadId);
      }
    },
    [finishLoading],
  );

  // WebSocket hook integration
  const { isConnected: wsConnected, sendWebSocketMessage } = useWebSocketChat({
    activeWorkspaceId,
    activeThreadId,
    onMessageChunk: handleWsChunk,
    onMessageComplete: handleWsComplete,
    onTypingStatus: handleWsTyping,
  });

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeThread?.messages]);

  const handleSelectWorkspace = (workspaceId: string) => {
    if (workspaceId === activeWorkspaceIdRef.current) return;
    createThreadControllerRef.current?.abort();
    createThreadControllerRef.current = null;
    isCreatingThreadRef.current = false;
    setIsCreatingThread(false);
    for (const controller of dispatchPollControllersRef.current.values()) {
      controller.abort();
    }
    dispatchPollControllersRef.current.clear();
    activeWorkspaceIdRef.current = workspaceId;
    activeThreadIdRef.current = "";
    loadingTargetRef.current = null;
    setActiveWorkspaceId(workspaceId);
    setThreads([]);
    setAgents([]);
    setActiveThreadId("");
    setSuggestedPrompt("");
    setIsLoading(false);
    setToastNotification(null);
  };

  const handleCreateWorkspace = async (data: {
    name: string;
    color: string;
  }) => {
    const workspace = await apiCreateWorkspace(data);
    setWorkspaces((current) => [...current, workspace]);
    handleSelectWorkspace(workspace.id);
  };

  const handleSelectThread = (threadId: string) => {
    const workspaceId = activeWorkspaceIdRef.current;
    activeThreadIdRef.current = threadId;
    const selectedThread = threadsRef.current.find(
      (thread) => thread.id === threadId,
    );
    const pendingUserMessageId = pendingDispatchesRef.current.get(
      dispatchKey(workspaceId, threadId),
    );
    const pendingResponse = Boolean(
      selectedThread &&
        pendingUserMessageId &&
        !hasAssistantAfterUser(selectedThread, pendingUserMessageId),
    );

    if (pendingUserMessageId && selectedThread && !pendingResponse) {
      stopDispatchReconciliation(workspaceId, threadId);
    } else if (pendingUserMessageId && pendingResponse) {
      setThreads((current) =>
        current.map((thread) =>
          thread.id === threadId
            ? withPendingAssistant(thread, pendingUserMessageId)
            : thread,
        ),
      );
      startDispatchReconciliation(
        workspaceId,
        threadId,
        pendingUserMessageId,
      );
    }

    const isSelectedThreadLoading =
      pendingResponse ||
      Boolean(
      selectedThread?.messages.some(
        (message) => message.sender === "assistant" && message.isStreaming,
      ),
      );
    loadingTargetRef.current = isSelectedThreadLoading
      ? { workspaceId, threadId }
      : null;
    setIsLoading(isSelectedThreadLoading);
    setActiveThreadId(threadId);
  };

  const handleCreateThread = async () => {
    const workspaceId = activeWorkspaceIdRef.current;
    if (!workspaceId || isCreatingThreadRef.current) return;

    const controller = new AbortController();
    createThreadControllerRef.current = controller;
    isCreatingThreadRef.current = true;
    setIsCreatingThread(true);
    try {
      const currentModel = activeThread?.model || "openai/gpt-4o";
      const newThread = await apiCreateThread(
        workspaceId,
        "Nova Conversa",
        currentModel,
        controller.signal,
      );
      if (activeWorkspaceIdRef.current !== workspaceId) return;
      setThreads((prev) =>
        activeWorkspaceIdRef.current === workspaceId
          ? [newThread, ...prev]
          : prev,
      );
      activeThreadIdRef.current = newThread.id;
      setActiveThreadId(newThread.id);
      setSidebarOpen(false);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error("Erro ao criar conversa:", err);
      if (activeWorkspaceIdRef.current === workspaceId) {
        setToastNotification({
          title: "Erro",
          message: "Falha ao criar nova conversa no servidor.",
        });
      }
    } finally {
      if (createThreadControllerRef.current === controller) {
        createThreadControllerRef.current = null;
        isCreatingThreadRef.current = false;
        setIsCreatingThread(false);
      }
    }
  };

  const handleModelChange = async (model: string) => {
    if (!activeThread || !activeWorkspaceId) return;
    const workspaceId = activeWorkspaceId;
    const threadId = activeThread.id;
    try {
      const updated = await apiUpdateThread(workspaceId, threadId, {
        model,
      });
      if (activeWorkspaceIdRef.current !== workspaceId) return;
      setThreads((prev) =>
        activeWorkspaceIdRef.current === workspaceId
          ? prev.map((thread) =>
              thread.id === threadId
                ? {
                    ...thread,
                    model: updated.model,
                    updatedAt: updated.updatedAt,
                  }
                : thread,
            )
          : prev,
      );
    } catch (err) {
      console.error("Erro ao atualizar modelo:", err);
    }
  };

  const handleRenameThread = async (newTitle: string) => {
    if (!activeThread || !activeWorkspaceId) return;
    const workspaceId = activeWorkspaceId;
    const threadId = activeThread.id;
    try {
      const updated = await apiUpdateThread(workspaceId, threadId, {
        title: newTitle,
      });
      if (activeWorkspaceIdRef.current !== workspaceId) return;
      setThreads((prev) =>
        activeWorkspaceIdRef.current === workspaceId
          ? prev.map((thread) =>
              thread.id === threadId
                ? {
                    ...thread,
                    title: updated.title,
                    updatedAt: updated.updatedAt,
                  }
                : thread,
            )
          : prev,
      );
    } catch (err) {
      console.error("Erro ao renomear conversa:", err);
    }
  };

  const handleDeleteThread = async (id: string, e: React.MouseEvent) => {
    const workspaceId = activeWorkspaceIdRef.current;
    if (!workspaceId) return;
    e.stopPropagation();
    let replacementController: AbortController | null = null;
    try {
      await apiDeleteThread(workspaceId, id);
      if (activeWorkspaceIdRef.current !== workspaceId) return;

      const updatedThreads = threadsRef.current.filter(
        (thread) => thread.id !== id,
      );
      setThreads((current) =>
        activeWorkspaceIdRef.current === workspaceId
          ? current.filter((thread) => thread.id !== id)
          : current,
      );

      if (updatedThreads.length === 0) {
        if (isCreatingThreadRef.current) return;
        replacementController = new AbortController();
        createThreadControllerRef.current = replacementController;
        isCreatingThreadRef.current = true;
        setIsCreatingThread(true);
        const newThread = await apiCreateThread(
          workspaceId,
          "Nova Conversa",
          "openai/gpt-4o",
          replacementController.signal,
        );
        if (activeWorkspaceIdRef.current !== workspaceId) return;
        setThreads((current) =>
          activeWorkspaceIdRef.current === workspaceId && current.length === 0
            ? [newThread]
            : current,
        );
        activeThreadIdRef.current = newThread.id;
        setActiveThreadId(newThread.id);
      } else {
        if (activeThreadIdRef.current === id) {
          activeThreadIdRef.current = updatedThreads[0].id;
          setActiveThreadId(updatedThreads[0].id);
        }
      }
    } catch (err) {
      if (replacementController?.signal.aborted) return;
      console.error("Erro ao excluir conversa:", err);
      if (activeWorkspaceIdRef.current === workspaceId) {
        setToastNotification({
          title: "Erro",
          message: "Não foi possível excluir a conversa no servidor.",
        });
      }
    } finally {
      if (
        replacementController &&
        createThreadControllerRef.current === replacementController
      ) {
        createThreadControllerRef.current = null;
        isCreatingThreadRef.current = false;
        setIsCreatingThread(false);
      }
    }
  };

  const handleSendMessage = async (
    content: string,
    attachments: FileAttachment[],
    audio?: AudioAttachment,
  ): Promise<boolean> => {
    if (!activeThread || !activeWorkspaceId) return false;

    const workspaceId = activeWorkspaceId;
    const threadId = activeThread.id;
    const activeModel = activeThread.model;
    let attachmentsPayload: Array<{ uploadSessionId: string }>;

    try {
      attachmentsPayload = buildUploadAttachmentPayload(attachments);
    } catch (error) {
      if (activeWorkspaceIdRef.current === workspaceId) {
        setToastNotification({
          title: "Upload pendente",
          message:
            error instanceof Error
              ? error.message
              : "Aguarde a conclusão dos uploads.",
        });
      }
      return false;
    }

    const timestamp = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const userMessageId = `user-temp-${Date.now()}`;

    const userMessage: Message = {
      id: userMessageId,
      sender: "user",
      content,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        uploadSessionId: attachment.uploadSessionId,
        name: attachment.name,
        size: attachment.size,
        type: attachment.type,
        url: attachment.url,
        uploadStatus: "completed",
      })),
      audio,
      timestamp,
    };

    // Auto rename thread if title is default
    const isFirstUserMsg =
      activeThread.messages.filter((m) => m.sender === "user").length === 0;
    let updatedTitle = activeThread.title;
    if (
      isFirstUserMsg &&
      activeThread.title === "Nova Conversa" &&
      content.trim()
    ) {
      updatedTitle =
        content.length > 25 ? content.substring(0, 25) + "..." : content;
      void apiUpdateThread(workspaceId, threadId, {
        title: updatedTitle,
      }).catch((error: unknown) => {
        console.warn("Falha ao atualizar o título da conversa:", error);
      });
    }

    const aiMessageId = `ai-temp-${Date.now()}`;
    const initialAiMessage: Message = {
      id: aiMessageId,
      sender: "assistant",
      content: "",
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
      isStreaming: true,
      model: activeModel,
    };

    // Optimistically update frontend state
    setThreads((prev) =>
      activeWorkspaceIdRef.current === workspaceId
        ? prev.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  title: updatedTitle,
                  messages: [...thread.messages, userMessage, initialAiMessage],
                }
              : thread,
          )
        : prev,
    );

    loadingTargetRef.current = { workspaceId, threadId };
    setIsLoading(true);

    const audioPayload = audio
      ? {
          url: audio.url,
          durationSeconds: audio.durationSeconds,
        }
      : undefined;

    // Only clear the composer after the server acknowledges persistence.
    try {
      const websocketResult = await sendWebSocketMessage(
        threadId,
        content,
        activeModel,
        attachmentsPayload,
        audioPayload,
      );

      if (websocketResult.status === "acknowledged") {
        const persistedUserMessage: Message = {
          ...userMessage,
          id: websocketResult.ack.userMessage.id,
        };
        if (activeWorkspaceIdRef.current === workspaceId) {
          setThreads((current) =>
            current.map((thread) =>
              thread.id === threadId
                ? {
                    ...thread,
                    messages: mergePersistedUser(
                      thread.messages,
                      userMessageId,
                      persistedUserMessage,
                    ),
                  }
                : thread,
            ),
          );
        }
        startDispatchReconciliation(
          workspaceId,
          threadId,
          persistedUserMessage.id,
        );
        return true;
      }
    } catch (err) {
      console.error("Erro ao confirmar mensagem via WebSocket:", err);
      if (activeWorkspaceIdRef.current === workspaceId) {
        setToastNotification({
          title: "Mensagem não confirmada",
          message:
            err instanceof Error
              ? err.message
              : "O servidor não confirmou a mensagem.",
        });
        setThreads((prev) =>
          prev.map((thread) =>
            thread.id === threadId
              ? {
                  ...thread,
                  messages: thread.messages.filter(
                    (message) =>
                      message.id !== userMessageId && message.id !== aiMessageId,
                  ),
                }
              : thread,
          ),
        );
      }
      stopDispatchReconciliation(workspaceId, threadId);
      finishLoading(workspaceId, threadId);
      return false;
    }

    // Fallback to HTTP API if WebSocket is offline
    try {
      const res = await sendMessageHttp({
        workspaceId,
        threadId,
        message: content,
        model: activeModel,
        attachments: attachmentsPayload,
        audio: audioPayload,
      });

      if (activeWorkspaceIdRef.current === workspaceId) {
        setThreads((current) =>
          current.map((thread) => {
            if (thread.id !== threadId) return thread;
            const messagesWithPersistedUser = mergePersistedUser(
              thread.messages,
              userMessageId,
              res.userMessage,
            );
            return {
              ...thread,
              messages: res.assistantMessage
                ? mergeCompletedAssistant(
                    messagesWithPersistedUser,
                    res.assistantMessage,
                  )
                : messagesWithPersistedUser,
            };
          }),
        );
      }

      if (res.status === "dispatched" && !res.assistantMessage) {
        startDispatchReconciliation(workspaceId, threadId, res.userMessage.id);
        return true;
      }

      if (activeWorkspaceIdRef.current === workspaceId) {
        finishLoading(workspaceId, threadId);
      }
      return true;
    } catch (err) {
      console.error("Erro ao enviar mensagem via HTTP:", err);
      if (activeWorkspaceIdRef.current !== workspaceId) return false;
      setToastNotification({
        title: "Erro de Comunicação",
        message: "Não foi possível enviar a mensagem para o servidor.",
      });
      // Remove temporary messages on failure
      setThreads((prev) =>
        activeWorkspaceIdRef.current === workspaceId
          ? prev.map((thread) =>
              thread.id === threadId
                ? {
                    ...thread,
                    messages: thread.messages.filter(
                      (message) =>
                        message.id !== userMessageId &&
                        message.id !== aiMessageId,
                    ),
                  }
                : thread,
            )
          : prev,
      );
      stopDispatchReconciliation(workspaceId, threadId);
      finishLoading(workspaceId, threadId);
      return false;
    }
  };

  if (isInitializing) {
    return (
      <div className="flex h-dvh items-center justify-center gap-3 bg-background text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span className="text-sm">Carregando conversas...</span>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background text-foreground">
      {toastNotification && (
        <Card
          role="status"
          className="fixed right-4 top-4 z-50 flex max-w-sm items-start gap-3 p-3 shadow-xl"
        >
          <div className="rounded-md bg-muted p-2">
            <Bell className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            {toastNotification.title && (
              <h4 className="text-sm font-medium">{toastNotification.title}</h4>
            )}
            <p className="text-xs text-muted-foreground">
              {toastNotification.message}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => setToastNotification(null)}
            aria-label="Fechar notificação"
          >
            <X className="size-4" />
          </Button>
        </Card>
      )}
      <ChatSidebar
        threads={threads}
        activeThreadId={activeThreadId}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onCreate={handleCreateThread}
        isCreatingThread={isCreatingThread}
        disableThreadCreation={isThreadsLoading || !activeWorkspaceId}
        onSelect={handleSelectThread}
        onDelete={handleDeleteThread}
        activeView={activeView}
        onNavigate={setActiveView}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
        onSelectWorkspace={handleSelectWorkspace}
        onCreateWorkspace={handleCreateWorkspace}
      />
      {activeView === "agents" ? (
        <AgentsPage
          agents={agents}
          onCreate={handleCreateAgent}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        />
      ) : (
        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <ChatHeader
            selectedModel={activeThread?.model || "gpt-4o"}
            onModelChange={handleModelChange}
            threadTitle={activeThread?.title || "Nova Conversa"}
            onRenameThread={handleRenameThread}
            onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
            wsConnected={wsConnected}
            sseConnected={sseConnected}
          />
          <div className="flex-1 overflow-y-auto">
            {isThreadsLoading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Carregando workspace...
              </div>
            ) : !activeThread || activeThread.messages.length === 0 ? (
              <ChatWelcome
                onPrompt={(prompt) => setSuggestedPrompt(`${prompt} `)}
              />
            ) : (
              <div className="mx-auto w-full max-w-3xl py-6">
                {activeThread.messages.map((message) => (
                  <ChatMessage key={message.id} message={message} />
                ))}
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
          {activeThread && !isThreadsLoading && (
            <ChatInput
              key={`${activeWorkspaceId}-${activeThread.id}`}
              workspaceId={activeWorkspaceId}
              threadId={activeThread.id}
              onSendMessage={handleSendMessage}
              disabled={isLoading}
              initialPrompt={suggestedPrompt}
            />
          )}
        </main>
      )}
    </div>
  );
}

export default App;
