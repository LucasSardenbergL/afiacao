# Remoção do wrapper deprecated `useToast` — Design Spec

> **Data:** 2026-05-25
> **Status:** aprovado no brainstorming
> **Contexto:** §10 do CLAUDE.md lista "~100 callsites de useToast legados — migrar gradualmente". A migração já foi feita ao longo de vários PRs; resta **1 consumidor real**. Esta PR fecha o débito removendo o wrapper deprecated por completo (Sonner vira a única fonte de toast de fato).

## Goal

Remover o wrapper `@deprecated useToast`/`toast` e seu shim, migrando o único consumidor restante pra `sonner`. Zero mudança de comportamento visível (o wrapper já delegava pra Sonner). Verificável por build + suíte; sem QA humano, sem migration.

## Estado atual (confirmado)

- `src/hooks/use-toast.ts` — wrapper `@deprecated` que delega pra Sonner.
- `src/components/ui/use-toast.ts` — shim que re-exporta o wrapper. **Zero consumidores.**
- Consumidores de `@/hooks/use-toast`:
  - `src/pages/AdminVendorSipCredentials.tsx` — **único consumidor real** (`const { toast } = useToast()` + 6 chamadas `toast({...})`).
  - `src/App.tsx` — apenas um **comentário** menciona o wrapper (usa `Toaster as Sonner`).
  - `src/contexts/__tests__/WebRTCCallContext.test.tsx` e `src/hooks/__tests__/useWebRTCCall.test.tsx` — `vi.mock('@/hooks/use-toast', ...)` **vestigial**: o SUT (`WebRTCCallContext.tsx`) usa `sonner` direto (`import { toast } from 'sonner'`), não o wrapper.

## Mudanças

### 1. `src/pages/AdminVendorSipCredentials.tsx`

- Trocar `import { useToast } from '@/hooks/use-toast';` por `import { toast } from 'sonner';`
- Remover `const { toast } = useToast();`
- Remover `toast` da dependência do `useEffect` (`[isMaster, toast]` → `[isMaster]`) — `toast` do Sonner é import estável, não é dependência.
- Converter as 6 chamadas:
  | Atual | Novo |
  |---|---|
  | `toast({ title:'Erro ao carregar', description, variant:'destructive' })` | `toast.error('Erro ao carregar', { description })` |
  | `toast({ title:'Campos obrigatórios', description, variant:'destructive' })` | `toast.error('Campos obrigatórios', { description })` |
  | `toast({ title:'Credencial adicionada' })` | `toast.success('Credencial adicionada')` |
  | `toast({ title:'Erro ao adicionar', description, variant:'destructive' })` | `toast.error('Erro ao adicionar', { description })` |
  | `toast({ title:'Removido' })` | `toast.success('Removido')` |
  | `toast({ title:'Erro ao remover', description, variant:'destructive' })` | `toast.error('Erro ao remover', { description })` |

### 2. Testes — remover mocks vestigiais

Em `src/contexts/__tests__/WebRTCCallContext.test.tsx` e `src/hooks/__tests__/useWebRTCCall.test.tsx`, remover o bloco:
```ts
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));
```
(O SUT não importa `@/hooks/use-toast`, então o mock é no-op. Os testes devem continuar passando sem ele.)

### 3. Deletar o wrapper + shim

- `git rm src/components/ui/use-toast.ts` (shim, 0 consumidores)
- `git rm src/hooks/use-toast.ts` (wrapper, 0 consumidores após 1+2)

### 4. `src/App.tsx`

Atualizar o comentário (linhas ~5-6) que diz que `useToast` "continua existindo como wrapper", já que ele foi removido. Novo comentário: "Sistema de toast unificado em Sonner (Radix Toaster legado e wrapper useToast removidos)."

### 5. Docs

- CLAUDE.md §5 (Toast/feedback): remover a frase sobre `use-toast.ts` ser wrapper de compat e os "~100 callsites".
- CLAUDE.md §10: remover/atualizar o item "~100 callsites de useToast legados" → marcado como concluído (wrapper removido).

## Testing

- Suíte completa verde (1048+), com atenção aos 2 testes de WebRTC (devem passar sem o mock removido).
- `bun lint` sem erros novos; `bun run build` exit 0 (confirma zero import quebrado após as deleções).
- Grep final: `grep -rn "use-toast\|useToast" src/` → só restam menções em docs/comentários (nenhum import).

## Out-of-scope

- Qualquer mudança de comportamento de toast (Sonner já é a fonte).
- Refatorar mensagens/textos dos toasts migrados (mantidos verbatim).
