import React, { useEffect, useState } from "react";
import { Menu, Pencil, Radio, Sparkles } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select } from "../ui/select";

interface ChatHeaderProps { selectedModel: string; onModelChange: (model: string) => void; threadTitle: string; onRenameThread: (title: string) => void; onToggleSidebar?: () => void; wsConnected?: boolean; sseConnected?: boolean; }

export const ChatHeader: React.FC<ChatHeaderProps> = ({ selectedModel, onModelChange, threadTitle, onRenameThread, onToggleSidebar, wsConnected = false, sseConnected = false }) => {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(threadTitle);
  useEffect(() => setTitle(threadTitle), [threadTitle]);
  const saveTitle = () => { setEditing(false); if (title.trim() && title.trim() !== threadTitle) onRenameThread(title.trim()); };

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-background/80 px-3 backdrop-blur md:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onToggleSidebar} aria-label="Abrir menu"><Menu className="size-4" /></Button>
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-card"><Sparkles className="size-3.5 text-primary" /></div>
        {editing ? <Input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={saveTitle} onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()} autoFocus className="h-8 w-40 md:w-60" /> : <Button variant="ghost" className="min-w-0 justify-start px-2" onClick={() => setEditing(true)} title="Renomear conversa"><span className="truncate">{threadTitle}</span><Pencil className="size-3 text-muted-foreground" /></Button>}
      </div>
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="hidden gap-1.5 sm:flex"><Radio className={`size-3 ${wsConnected ? "text-emerald-500" : "text-amber-500"}`} />{wsConnected ? "Online" : sseConnected ? "Parcial" : "Offline"}</Badge>
        <Select value={selectedModel} onChange={(event) => onModelChange(event.target.value)} className="w-40 md:w-52" aria-label="Modelo de IA">
          <option value="openai/gpt-4o">GPT-4o</option><option value="openai/gpt-4o-mini">GPT-4o Mini</option><option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</option><option value="google/gemini-2.5-flash">Gemini 2.5 Flash</option><option value="meta-llama/llama-3.3-70b-instruct">Llama 3.3 70B</option><option value="deepseek/deepseek-chat">DeepSeek V3</option><option value="qwen/qwen-2.5-72b-instruct">Qwen 2.5 72B</option>
        </Select>
      </div>
    </header>
  );
};
