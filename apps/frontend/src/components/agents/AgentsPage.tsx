import { useMemo, useState, type FormEvent } from "react";
import {
  Bot,
  CalendarDays,
  Grid2X2,
  List,
  Menu,
  Plus,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import type { Agent } from "../../types/agent";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Textarea } from "../ui/textarea";

interface AgentsPageProps {
  agents: Agent[];
  onCreate: (
    agent: Omit<Agent, "id" | "createdAt">,
  ) => void | Promise<void>;
  onToggleSidebar: () => void;
}

const emptyForm = {
  name: "",
  description: "",
  instructions: "",
  model: "openai/gpt-4o",
  tools: "Pesquisa web",
};

function AgentCard({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  const date = new Intl.DateTimeFormat("pt-BR").format(new Date(agent.createdAt));

  return (
    <Card className={`group transition-colors hover:border-foreground/20 ${compact ? "flex items-center" : ""}`}>
      <CardHeader className={compact ? "min-w-0 flex-1 flex-row items-center gap-4" : "pb-3"}>
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-foreground">
          <Bot className="size-5" />
        </div>
        <div className="min-w-0 space-y-1">
          <CardTitle className="truncate text-base">{agent.name}</CardTitle>
          <CardDescription className={compact ? "truncate" : "line-clamp-2 min-h-10"}>
            {agent.description}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className={compact ? "flex shrink-0 items-center gap-4 p-5" : "space-y-4"}>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{agent.model.split("/").at(-1)}</Badge>
          {agent.tools.slice(0, compact ? 1 : 2).map((tool) => <Badge key={tool} variant="secondary">{tool}</Badge>)}
        </div>
        <div className={`flex items-center gap-1.5 text-xs text-muted-foreground ${compact ? "hidden sm:flex" : ""}`}>
          <CalendarDays className="size-3.5" />Criado em {date}
        </div>
      </CardContent>
    </Card>
  );
}

export function AgentsPage({ agents, onCreate, onToggleSidebar }: AgentsPageProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const visibleAgents = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return agents
      .filter((agent) => !normalized || `${agent.name} ${agent.description} ${agent.tools.join(" ")}`.toLowerCase().includes(normalized))
      .toSorted((a, b) => sort === "name" ? a.name.localeCompare(b.name) : +new Date(b.createdAt) - +new Date(a.createdAt));
  }, [agents, query, sort]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form.name.trim() || !form.description.trim()) return;
    onCreate({
      name: form.name.trim(),
      description: form.description.trim(),
      instructions: form.instructions.trim(),
      model: form.model,
      tools: form.tools.split(",").map((tool) => tool.trim()).filter(Boolean),
    });
    setForm(emptyForm);
    setDialogOpen(false);
  };

  return (
    <section className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
        <header className="mb-7 flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <Button variant="ghost" size="icon" className="shrink-0 md:hidden" onClick={onToggleSidebar} aria-label="Abrir menu"><Menu className="size-5" /></Button>
            <div>
              <div className="flex items-center gap-2"><Bot className="size-5" /><h1 className="text-xl font-semibold tracking-tight">Agentes</h1></div>
              <p className="mt-1 text-sm text-muted-foreground">Crie e gerencie agentes de IA com instruções e ferramentas personalizadas.</p>
            </div>
          </div>
          <Button onClick={() => setDialogOpen(true)} className="shrink-0"><Plus className="size-4" /><span className="hidden sm:inline">Novo agente</span></Button>
        </header>

        <div className="mb-3 flex flex-col gap-3 sm:flex-row">
          <div className="relative flex-1"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" placeholder="Buscar agentes..." aria-label="Buscar agentes" /></div>
          <Select value={sort} onChange={(e) => setSort(e.target.value)} className="sm:w-40" aria-label="Ordenar agentes"><option value="recent">Mais recentes</option><option value="name">Nome (A–Z)</option></Select>
          <div className="flex rounded-md border border-input p-0.5">
            <Button variant={view === "grid" ? "secondary" : "ghost"} size="icon" className="size-8" onClick={() => setView("grid")} aria-label="Visualizar em grade"><Grid2X2 className="size-4" /></Button>
            <Button variant={view === "list" ? "secondary" : "ghost"} size="icon" className="size-8" onClick={() => setView("list")} aria-label="Visualizar em lista"><List className="size-4" /></Button>
          </div>
        </div>
        <p className="mb-5 text-xs text-muted-foreground">Exibindo {visibleAgents.length} de {agents.length} agentes</p>

        {visibleAgents.length ? (
          <div className={view === "grid" ? "grid gap-4 sm:grid-cols-2 xl:grid-cols-3" : "space-y-3"}>
            {visibleAgents.map((agent) => <AgentCard key={agent.id} agent={agent} compact={view === "list"} />)}
          </div>
        ) : (
          <Card className="flex min-h-64 flex-col items-center justify-center border-dashed p-8 text-center">
            <div className="mb-4 rounded-full bg-secondary p-4"><Sparkles className="size-6" /></div>
            <h2 className="font-medium">Nenhum agente encontrado</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">Ajuste sua busca ou crie um novo agente para começar.</p>
            <Button className="mt-5" onClick={() => setDialogOpen(true)}><Plus className="size-4" />Criar agente</Button>
          </Card>
        )}
      </div>

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setDialogOpen(false); }}>
          <Card role="dialog" aria-modal="true" aria-labelledby="new-agent-title" className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-b-none sm:rounded-xl">
            <CardHeader className="flex-row items-start justify-between">
              <div><CardTitle id="new-agent-title">Criar novo agente</CardTitle><CardDescription className="mt-1">Defina como seu agente deve se comportar.</CardDescription></div>
              <Button type="button" variant="ghost" size="icon" className="size-8" onClick={() => setDialogOpen(false)} aria-label="Fechar"><X className="size-4" /></Button>
            </CardHeader>
            <CardContent>
              <form onSubmit={submit} className="space-y-4">
                <label className="block space-y-1.5"><span className="text-sm font-medium">Nome</span><Input required autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ex.: Especialista em conteúdo" /></label>
                <label className="block space-y-1.5"><span className="text-sm font-medium">Descrição</span><Input required value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="O que este agente faz?" /></label>
                <label className="block space-y-1.5"><span className="text-sm font-medium">Instruções</span><Textarea value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Explique o papel, tom e regras do agente..." /></label>
                <label className="block space-y-1.5"><span className="text-sm font-medium">Modelo</span><Select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}><option value="openai/gpt-4o">GPT-4o</option><option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</option><option value="google/gemini-pro">Gemini Pro</option></Select></label>
                <label className="block space-y-1.5"><span className="text-sm font-medium">Ferramentas</span><Input value={form.tools} onChange={(e) => setForm({ ...form, tools: e.target.value })} placeholder="Separe por vírgulas" /><span className="text-xs text-muted-foreground">Separe múltiplas ferramentas por vírgulas.</span></label>
                <div className="flex justify-end gap-2 pt-2"><Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>Cancelar</Button><Button type="submit">Criar agente</Button></div>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </section>
  );
}
