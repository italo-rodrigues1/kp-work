import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { createPortal } from "react-dom";
import { Layers3, Loader2, Plus, Sparkles, X } from "lucide-react";
import type { Workspace } from "../../types/workspace";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Input } from "../ui/input";

interface WorkspaceRailProps {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onSelect: (workspaceId: string) => void;
  onCreate: (data: { name: string; color: string }) => Promise<void>;
}

const workspaceColors = [
  "#f97316",
  "#8b5cf6",
  "#06b6d4",
  "#22c55e",
  "#ec4899",
  "#3b82f6",
];

function workspaceInitials(name: string) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

export function WorkspaceRail({
  workspaces,
  activeWorkspaceId,
  onSelect,
  onCreate,
}: WorkspaceRailProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(workspaceColors[0]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const createButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const closeDialog = useCallback(() => {
    if (submitting) return;
    setDialogOpen(false);
    requestAnimationFrame(() => createButtonRef.current?.focus());
  }, [submitting]);

  useEffect(() => {
    if (!dialogOpen) return;

    const appRoot = document.getElementById("root");
    const rootWasInert = appRoot?.hasAttribute("inert") ?? false;
    const previousOverflow = document.body.style.overflow;
    appRoot?.setAttribute("inert", "");
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        closeDialog();
        return;
      }

      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) || [],
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (!rootWasInert) appRoot?.removeAttribute("inert");
      document.body.style.overflow = previousOverflow;
    };
  }, [closeDialog, dialogOpen, submitting]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || submitting) return;

    setSubmitting(true);
    setError("");
    try {
      await onCreate({ name: name.trim(), color });
      setName("");
      setColor(workspaceColors[0]);
      setDialogOpen(false);
      requestAnimationFrame(() => createButtonRef.current?.focus());
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Não foi possível criar o workspace.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <aside className="flex w-16 shrink-0 flex-col items-center border-r border-workspace-rail-border bg-workspace-rail py-3 text-workspace-rail-foreground">
        <div className="mb-3 flex size-9 items-center justify-center rounded-xl border border-white/10 bg-white/5">
          <Sparkles className="size-4" aria-hidden="true" />
          <span className="sr-only">Rune AI</span>
        </div>

        <div className="mb-3 h-px w-8 bg-workspace-rail-border" />

        <nav
          className="flex min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto px-2"
          aria-label="Workspaces"
        >
          {workspaces.map((workspace) => {
            const active = workspace.id === activeWorkspaceId;
            return (
              <Button
                key={workspace.id}
                type="button"
                variant="ghost"
                size="icon"
                className={`relative size-10 shrink-0 rounded-xl p-1 text-white hover:bg-white/10 hover:text-white ${
                  active
                    ? "bg-workspace-active ring-1 ring-workspace-active-ring"
                    : "opacity-75 hover:opacity-100"
                }`}
                onClick={() => onSelect(workspace.id)}
                aria-label={`Abrir workspace ${workspace.name}`}
                aria-current={active ? "page" : undefined}
                title={workspace.name}
              >
                <span
                  className="flex size-8 items-center justify-center rounded-lg text-[11px] font-bold tracking-wide text-white shadow-sm"
                  style={{ backgroundColor: workspace.color }}
                  aria-hidden="true"
                >
                  {workspaceInitials(workspace.name) || (
                    <Layers3 className="size-4" />
                  )}
                </span>
                {active && (
                  <span className="absolute -left-2 h-5 w-1 rounded-r-full bg-workspace-indicator" />
                )}
              </Button>
            );
          })}

          <Button
            ref={createButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 rounded-xl border border-dashed border-white/20 text-workspace-rail-muted hover:border-white/35 hover:bg-white/10 hover:text-white"
            onClick={() => {
              setError("");
              setDialogOpen(true);
            }}
            aria-label="Criar workspace"
            title="Criar workspace"
          >
            <Plus className="size-4" />
          </Button>
        </nav>
      </aside>

      {dialogOpen &&
        createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4"
            role="presentation"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !submitting) {
                closeDialog();
              }
            }}
          >
            <Card
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="new-workspace-title"
              className="max-h-[calc(100dvh-1rem)] w-full max-w-md overflow-y-auto rounded-b-none shadow-2xl sm:max-h-[90dvh] sm:rounded-xl"
            >
              <CardHeader className="flex-row items-start justify-between">
                <div>
                  <CardTitle id="new-workspace-title">
                    Criar workspace
                  </CardTitle>
                  <CardDescription className="mt-1">
                    Conversas e agentes ficam separados neste espaço.
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  disabled={submitting}
                  onClick={closeDialog}
                  aria-label="Fechar"
                >
                  <X className="size-4" />
                </Button>
              </CardHeader>
              <CardContent>
                <form onSubmit={submit} className="space-y-5">
                  <label className="block space-y-1.5">
                    <span className="text-sm font-medium">Nome</span>
                    <Input
                      required
                      autoFocus
                      maxLength={60}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Ex.: Marketing"
                    />
                  </label>

                  <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">Cor</legend>
                    <div className="flex flex-wrap gap-2">
                      {workspaceColors.map((option) => (
                        <Button
                          key={option}
                          type="button"
                          variant="ghost"
                          size="icon"
                          className={`size-9 rounded-full p-1 ${
                            color === option
                              ? "ring-2 ring-ring ring-offset-2 ring-offset-background"
                              : ""
                          }`}
                          onClick={() => setColor(option)}
                          aria-label={`Usar cor ${option}`}
                          aria-pressed={color === option}
                        >
                          <span
                            className="size-7 rounded-full"
                            style={{ backgroundColor: option }}
                          />
                        </Button>
                      ))}
                    </div>
                  </fieldset>

                  {error && (
                    <p role="alert" className="text-sm text-destructive">
                      {error}
                    </p>
                  )}

                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={submitting}
                      onClick={closeDialog}
                    >
                      Cancelar
                    </Button>
                    <Button type="submit" disabled={!name.trim() || submitting}>
                      {submitting && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      Criar workspace
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          </div>,
          document.body,
        )}
    </>
  );
}
