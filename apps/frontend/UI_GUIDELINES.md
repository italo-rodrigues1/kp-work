# Padrão de interface

Este frontend segue uma arquitetura de UI em duas camadas:

1. `src/components/ui`: primitives shadcn. Concentram tokens, variantes, foco, estados desabilitados e acessibilidade.
2. `src/components/<feature>`: componentes de produto compostos apenas a partir das primitives de `ui`.

## Regras para novas implementações

- Use uma primitive shadcn antes de estilizar um elemento interativo diretamente. Exemplos: `Button`, `Input`, `Textarea`, `Select`, `Card`, `Badge` e `Avatar`.
- Se a primitive não existir, adicione-a em `components/ui` seguindo a API do shadcn e use `cn` para compor classes.
- Use tokens semânticos (`bg-background`, `text-foreground`, `bg-card`, `text-muted-foreground`, `border-input`) em vez de cores de paleta dentro das features.
- Mantenha estado e integrações nos componentes da feature; primitives devem ser visuais e sem regra de negócio.
- Toda ação por ícone deve ter `aria-label`. Estados de foco, carregamento e desabilitado são obrigatórios.
- A interface deve funcionar primeiro em telas pequenas e ganhar espaço nos breakpoints `sm`, `md` e `lg`.
- Evite CSS local por componente. Novos valores globais devem ser tokens em `index.css`; variações devem usar `class-variance-authority`.

## Estrutura de uma feature

```text
components/
├── ui/                 # primitives shadcn
└── chat/               # composições do domínio
    ├── ChatHeader.tsx
    ├── ChatInput.tsx
    ├── ChatMessage.tsx
    ├── ChatSidebar.tsx
    └── ChatWelcome.tsx
```

Antes de entregar uma tela, execute `pnpm --filter frontend lint` e `pnpm --filter frontend build`.
