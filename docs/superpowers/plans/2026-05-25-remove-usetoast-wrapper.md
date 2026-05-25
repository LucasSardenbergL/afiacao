# Remoção do wrapper deprecated `useToast` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remover o wrapper `@deprecated useToast` + shim, migrando o único consumidor real (`AdminVendorSipCredentials`) pra `sonner`. Comportamento idêntico (o wrapper já delegava pra Sonner).

**Architecture:** Migração mecânica de 1 arquivo + remoção de 2 mocks de teste vestigiais + deleção de 2 arquivos de wrapper. Verificação por suíte + build (não há comportamento novo a testar; é remoção de indireção).

**Tech Stack:** React + sonner + vitest. Sem migration, sem mudança de UI.

**Spec base:** [docs/superpowers/specs/2026-05-25-remove-usetoast-wrapper-design.md](../specs/2026-05-25-remove-usetoast-wrapper-design.md)

**Baseline:** vitest 1048+ passed (main). Não regredir.

---

## File Structure

**Editados:**
```
src/pages/AdminVendorSipCredentials.tsx              # useToast → sonner (6 chamadas)
src/contexts/__tests__/WebRTCCallContext.test.tsx    # remove vi.mock vestigial
src/hooks/__tests__/useWebRTCCall.test.tsx           # remove vi.mock vestigial
src/App.tsx                                          # atualiza comentário
CLAUDE.md                                            # §5 + §10
```

**Deletados:**
```
src/components/ui/use-toast.ts   # shim (0 consumidores)
src/hooks/use-toast.ts           # wrapper @deprecated (0 consumidores após migração)
```

---

### Task 1: Migrar `AdminVendorSipCredentials.tsx` pra sonner

**Files:**
- Modify: `src/pages/AdminVendorSipCredentials.tsx`

- [ ] **Step 1: Trocar o import**

Trocar (linha 7):
```ts
import { useToast } from '@/hooks/use-toast';
```
por:
```ts
import { toast } from 'sonner';
```

- [ ] **Step 2: Remover o hook + a dependência do useEffect**

Remover a linha 27:
```ts
  const { toast } = useToast();
```

Trocar a dep do `useEffect` (linha ~62):
```ts
  }, [isMaster, toast]);
```
por:
```ts
  }, [isMaster]);
```

> `toast` do Sonner é import estável (module-level), não é dependência de hook.

- [ ] **Step 3: Converter as 6 chamadas**

Trocar (carregar):
```ts
        toast({
          title: 'Erro ao carregar',
          description: err instanceof Error ? err.message : String(err),
          variant: 'destructive',
        });
```
por:
```ts
        toast.error('Erro ao carregar', {
          description: err instanceof Error ? err.message : String(err),
        });
```

Trocar (campos obrigatórios):
```ts
      toast({
        title: 'Campos obrigatórios',
        description: 'Usuário, SIP user e SIP pass são obrigatórios.',
        variant: 'destructive',
      });
```
por:
```ts
      toast.error('Campos obrigatórios', {
        description: 'Usuário, SIP user e SIP pass são obrigatórios.',
      });
```

Trocar `toast({ title: 'Credencial adicionada' });` por `toast.success('Credencial adicionada');`

Trocar (erro ao adicionar):
```ts
      toast({
        title: 'Erro ao adicionar',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
```
por:
```ts
      toast.error('Erro ao adicionar', {
        description: err instanceof Error ? err.message : String(err),
      });
```

Trocar `toast({ title: 'Removido' });` por `toast.success('Removido');`

Trocar (erro ao remover):
```ts
      toast({
        title: 'Erro ao remover',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
```
por:
```ts
      toast.error('Erro ao remover', {
        description: err instanceof Error ? err.message : String(err),
      });
```

- [ ] **Step 4: Lint + grep**

Run:
```bash
bunx eslint src/pages/AdminVendorSipCredentials.tsx
grep -n "useToast\|toast({" src/pages/AdminVendorSipCredentials.tsx || echo "limpo"
```
Expected: zero erros de lint; grep sem ocorrências de `useToast`/`toast({`.

- [ ] **Step 5: Commit**

```bash
git add src/pages/AdminVendorSipCredentials.tsx
git commit -m "refactor(toast): AdminVendorSipCredentials usa sonner direto (último consumidor do wrapper)"
```

---

### Task 2: Remover os `vi.mock('@/hooks/use-toast')` vestigiais

**Files:**
- Modify: `src/contexts/__tests__/WebRTCCallContext.test.tsx`
- Modify: `src/hooks/__tests__/useWebRTCCall.test.tsx`

- [ ] **Step 1: Remover o bloco em ambos os testes**

Em `src/contexts/__tests__/WebRTCCallContext.test.tsx` E em `src/hooks/__tests__/useWebRTCCall.test.tsx`, remover o bloco (incluindo a linha em branco que o segue):
```ts
vi.mock('@/hooks/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

```

> O SUT (`WebRTCCallContext.tsx`) usa `import { toast } from 'sonner'` direto — esse mock nunca interceptou nada. Removê-lo é seguro.

- [ ] **Step 2: Rodar os 2 testes**

Run: `bun run vitest run src/contexts/__tests__/WebRTCCallContext.test.tsx src/hooks/__tests__/useWebRTCCall.test.tsx`
Expected: ambos PASS (mesmo comportamento de antes — o mock era no-op).

- [ ] **Step 3: Commit**

```bash
git add src/contexts/__tests__/WebRTCCallContext.test.tsx src/hooks/__tests__/useWebRTCCall.test.tsx
git commit -m "test(toast): remove vi.mock vestigial de use-toast (SUT usa sonner)"
```

---

### Task 3: Deletar wrapper + shim + atualizar comentário do App

**Files:**
- Delete: `src/components/ui/use-toast.ts`
- Delete: `src/hooks/use-toast.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Confirmar zero importadores restantes**

Run:
```bash
grep -rn "hooks/use-toast\|ui/use-toast\|useToast" src/ --include='*.ts' --include='*.tsx' | grep -v "use-toast.ts"
```
Expected: só a linha do comentário em `src/App.tsx` (nenhum `import`). Se aparecer qualquer `import`, PARAR e migrar esse arquivo antes.

- [ ] **Step 2: Deletar os arquivos**

```bash
git rm src/components/ui/use-toast.ts src/hooks/use-toast.ts
```

- [ ] **Step 3: Atualizar o comentário do App.tsx**

Trocar (linhas ~5-6):
```ts
// Sistema de toast unificado em Sonner (o Radix Toaster legado foi desligado;
// o hook `useToast` continua existindo como wrapper que delega para Sonner — ver src/hooks/use-toast.ts).
```
por:
```ts
// Sistema de toast unificado em Sonner (Radix Toaster legado e wrapper useToast removidos).
```

- [ ] **Step 4: Build (confirma zero import quebrado)**

Run: `bun run build`
Expected: exit 0 (nenhum erro de módulo não encontrado).

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "chore(toast): remove wrapper useToast deprecated + shim (sonner é a única fonte)"
```

---

### Task 4: Docs (§5 + §10) + validação final

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Atualizar §5 (Toast / feedback)**

Em `CLAUDE.md` §5, localizar a parte que descreve `use-toast.ts` como "wrapper de compat (@deprecated)" e os "~100 callsites legados", e trocar por algo como:
```markdown
- **Sonner é o único sistema de toast.** O wrapper `useToast` (`use-toast.ts`) + shim foram **removidos** (2026-05-25) — todo código usa `import { toast } from 'sonner'` (`toast.success/error/info`).
```

- [ ] **Step 2: Atualizar §10**

Remover/atualizar o item "~100 callsites de `useToast` legados — migrar gradualmente" → marcar como ✅ concluído (wrapper removido; sonner único).

- [ ] **Step 3: Suíte + lint + build completos**

Run:
```bash
bun run test
bun lint
bun run build
```
Expected: vitest verde (1048+, sem regressão); lint sem erros novos; build exit 0.

- [ ] **Step 4: Grep final de sanidade**

Run: `grep -rn "use-toast\|useToast" src/`
Expected: **nenhum `import`** de `use-toast`/`useToast`. A única ocorrência aceitável é a menção textual no comentário do `src/App.tsx` ("wrapper useToast removidos"). Se aparecer qualquer `import` ou `from '...use-toast'`, investigar.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): §5/§10 marcam wrapper useToast como removido (sonner único)"
```

- [ ] **Step 6: Push + PR (com ok do founder)**

```bash
git push -u origin claude/remove-usetoast-wrapper
```
PR title: `chore(toast): remove wrapper useToast deprecated (sonner é a única fonte)`

---

## Critérios de "feito"

- [ ] `AdminVendorSipCredentials` usa `sonner` direto (6 chamadas convertidas; 4 error, 2 success).
- [ ] Mocks vestigiais removidos dos 2 testes; ambos passam.
- [ ] `src/hooks/use-toast.ts` e `src/components/ui/use-toast.ts` deletados.
- [ ] `grep -rn "use-toast\|useToast" src/` → zero ocorrências.
- [ ] vitest verde; lint sem erros novos; build exit 0; sem migration.
- [ ] CLAUDE.md §5/§10 atualizados.

## Out-of-scope

- Mudar texto/comportamento dos toasts (migração verbatim).
