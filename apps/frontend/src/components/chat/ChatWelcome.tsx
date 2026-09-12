import { ArrowUpRight, FileText, Lightbulb, MessageSquare, Search, WandSparkles } from "lucide-react";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

const prompts = [
  { icon: MessageSquare, title: "Criar uma mensagem", prompt: "Ajude-me a escrever uma mensagem clara e objetiva" },
  { icon: FileText, title: "Resumir um documento", prompt: "Resuma os pontos principais deste documento" },
  { icon: Lightbulb, title: "Explorar ideias", prompt: "Vamos explorar ideias para o meu próximo projeto" },
];

export function ChatWelcome({ onPrompt }: { onPrompt: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col justify-center px-5 py-10">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl border bg-card shadow-sm"><WandSparkles className="size-5 text-primary" /></div>
        <h1 className="font-serif text-3xl tracking-tight text-foreground md:text-4xl">Como posso ajudar hoje?</h1>
        <p className="mt-2 text-sm text-muted-foreground">Converse, crie e organize suas ideias em um só lugar.</p>
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        {prompts.map(({ icon: Icon, title, prompt }) => (
          <Card key={title} className="group bg-card/60 transition-colors hover:bg-accent/60">
            <Button variant="ghost" className="h-full w-full items-start justify-start whitespace-normal p-0 text-left" onClick={() => onPrompt(prompt)}>
              <CardHeader className="w-full p-4">
                <div className="flex items-center justify-between"><Icon className="size-4 text-muted-foreground" /><ArrowUpRight className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" /></div>
                <CardTitle className="pt-3 text-sm">{title}</CardTitle>
                <CardDescription className="text-xs leading-relaxed">{prompt}</CardDescription>
              </CardHeader>
            </Button>
          </Card>
        ))}
      </div>
      <Card className="mt-6 border-dashed bg-transparent">
        <CardContent className="flex items-center gap-2 p-3 text-xs text-muted-foreground"><Search className="size-3.5" />Dica: use Shift + Enter para quebrar uma linha.</CardContent>
      </Card>
    </div>
  );
}
