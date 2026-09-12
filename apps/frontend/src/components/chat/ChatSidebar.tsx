import {
  Bot,
  History,
  MessageSquare,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import type { MouseEvent } from "react";
import type { Thread } from "../../types/chat";
import type { Workspace } from "../../types/workspace";
import { WorkspaceRail } from "../workspaces/WorkspaceRail";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";

interface ChatSidebarProps {
  threads: Thread[];
  activeThreadId: string;
  open: boolean;
  onClose: () => void;
  onCreate: () => void;
  isCreatingThread: boolean;
  disableThreadCreation?: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string, event: MouseEvent) => void;
  activeView: "chat" | "agents";
  onNavigate: (view: "chat" | "agents") => void;
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onSelectWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (data: { name: string; color: string }) => Promise<void>;
}

const modelName = (model: string) =>
  model.split("/").at(-1)?.replaceAll("-", " ") || "AI";

export function ChatSidebar({
  threads,
  activeThreadId,
  open,
  onClose,
  onCreate,
  isCreatingThread,
  disableThreadCreation = false,
  onSelect,
  onDelete,
  activeView,
  onNavigate,
  workspaces,
  activeWorkspaceId,
  onSelectWorkspace,
  onCreateWorkspace,
}: ChatSidebarProps) {
  const activeWorkspace = workspaces.find(
    (workspace) => workspace.id === activeWorkspaceId,
  );

  return (
    <>
      {open && (
        <Button
          aria-label="Fechar menu"
          variant="ghost"
          className="fixed inset-0 z-30 h-auto w-auto rounded-none bg-black/70 md:hidden"
          onClick={onClose}
        />
      )}
      <div
        className={`fixed inset-y-0 left-0 z-40 flex transition-transform md:relative md:visible md:translate-x-0 ${open ? "visible translate-x-0" : "invisible -translate-x-full"}`}
      >
        <WorkspaceRail
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelect={(workspaceId) => {
            onSelectWorkspace(workspaceId);
            onClose();
          }}
          onCreate={async (data) => {
            await onCreateWorkspace(data);
            onClose();
          }}
        />
        <aside className="flex w-[calc(100vw-4rem)] max-w-72 flex-col border-r bg-sidebar text-sidebar-foreground md:w-72">
          <div className="flex h-14 items-center justify-between px-4">
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Sparkles className="size-4" />
              </div>
              <span className="truncate">
                {activeWorkspace?.name || "Workspace"}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              onClick={onClose}
              aria-label="Fechar menu"
            >
              <X className="size-4" />
            </Button>
          </div>
          <Separator />
          <div className="p-3">
            <Button
              disabled={isCreatingThread || disableThreadCreation}
              aria-busy={isCreatingThread}
              onClick={() => {
                onCreate();
                onNavigate("chat");
              }}
              className="w-full justify-start"
            >
              <Plus className="size-4" />
              {isCreatingThread ? "Criando..." : "Nova conversa"}
            </Button>
          </div>
          <nav className="space-y-1 px-2 pb-3" aria-label="Navegação principal">
            <Button
              variant={activeView === "agents" ? "secondary" : "ghost"}
              className="w-full justify-start"
              onClick={() => {
                onNavigate("agents");
                onClose();
              }}
            >
              <Bot className="size-4" />
              Agentes
            </Button>
          </nav>
          <Separator />
          <nav
            className="min-h-0 flex-1 overflow-y-auto px-2 pb-3"
            aria-label="Histórico de conversas"
          >
            <div className="mb-2 flex items-center gap-2 px-2 text-xs font-medium text-muted-foreground">
              <History className="size-3.5" />
              Recentes
            </div>
            <div className="space-y-1">
              {threads.map((thread) => {
                const active = thread.id === activeThreadId;
                return (
                  <div key={thread.id} className="group relative">
                    <Button
                      variant={
                        active && activeView === "chat" ? "secondary" : "ghost"
                      }
                      className="h-auto w-full justify-start px-3 py-2.5 pr-10 text-left"
                      onClick={() => {
                        onSelect(thread.id);
                        onNavigate("chat");
                        onClose();
                      }}
                    >
                      <MessageSquare className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">
                          {thread.title}
                        </span>
                        <span className="mt-1 block truncate text-[10px] font-normal text-muted-foreground">
                          {modelName(thread.model)}
                        </span>
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="absolute right-1 top-1/2 size-7 -translate-y-1/2 opacity-100 md:pointer-events-none md:opacity-0 md:group-hover:pointer-events-auto md:group-hover:opacity-100 md:focus:pointer-events-auto md:focus:opacity-100"
                      onClick={(event) => onDelete(thread.id, event)}
                      aria-label={`Excluir ${thread.title}`}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </nav>
          <Separator />
          <div className="flex items-center gap-3 p-3">
            <Avatar>
              <AvatarFallback>IM</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">Italo Moura</p>
              <p className="truncate text-xs text-muted-foreground">
                {activeWorkspace?.name || "Workspace pessoal"}
              </p>
            </div>
            <Badge variant="outline" className="px-1.5">
              Pro
            </Badge>
          </div>
        </aside>
      </div>
    </>
  );
}
