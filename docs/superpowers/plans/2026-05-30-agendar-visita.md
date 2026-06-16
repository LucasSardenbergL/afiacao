# Agendar visita — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao vendedor uma fila persistente de visitas agendadas (datadas) a clientes da carteira dele — criada do Customer 360, vista numa agenda "Próximas visitas" no route planner, com navegação (Waze) e check-in 1-toque que fecha a agenda automaticamente.

**Architecture:** Tabela nova `visitas_agendadas` (owner-scoped, RLS endurecida por GRANT-por-coluna + carteira) + trigger de reconciliação no `route_visits` (check-in fecha a agenda). Front-end: helpers puros (`navLink`, `deriveVisitaStatus`), módulo de acesso tipado, hook `useVisitasAgendadas` (TanStack Query, optimistic), `AgendarVisitaDialog` (2 entradas) e `ScheduledVisitsPanel` (agenda + Waze + check-in 1-toque). Backend aplicado **manualmente via Lovable**.

**Tech Stack:** React 18 + TypeScript, Vite, vitest, Supabase (Postgres + RLS), TanStack Query. Spec: `docs/superpowers/specs/2026-05-30-agendar-visita-design.md`.

---

## Fases

- **Fase 1 (núcleo shippable) — Tasks 1–7:** banco + helpers + hook + dialog + agenda no route planner + check-in 1-toque. Entrega sozinha valor testável: o vendedor agenda, vê a agenda, navega e faz check-in (que fecha a agenda).
- **Fase 2 (fast-follow) — Task 8:** integrar agendadas de hoje como **parada no mapa** do route planner (4ª fonte em `useRoutePlanner`). É a parte mais pesada (toca o god-hook); pode ser plano/PR separado.

---

## File Structure

| Arquivo | Responsabilidade | Ação |
| --- | --- | --- |
| `supabase/migrations/20260530NNNNNN_visitas_agendadas.sql` | Tabela + constraints + índices + RLS/grants + trigger reconciliação + updated_at | Criar (apply manual Lovable) |
| `src/lib/visitas/visita-status.ts` | Helper puro `deriveVisitaStatus` | Criar |
| `src/lib/visitas/__tests__/visita-status.test.ts` | Testes do helper | Criar |
| `src/lib/maps/nav-link.ts` | Helper puro `navLink` (Waze/Maps) | Criar |
| `src/lib/maps/__tests__/nav-link.test.ts` | Testes do helper | Criar |
| `src/hooks/useRoutePlanner.ts` | Refatorar `openInWaze` p/ usar `navLink` (DRY) | Modificar |
| `src/integrations/supabase/visitasAgendadas.ts` | Tipo `VisitaAgendadaRow` + acesso tipado à tabela nova | Criar |
| `src/hooks/useVisitasAgendadas.ts` | Query + mutations (agendar/remarcar/cancelar) + check-in | Criar |
| `src/components/visitas/AgendarVisitaDialog.tsx` | Dialog de agendar | Criar |
| `src/components/adminCustomers/Customer360View.tsx` | Ligar o item "Agendar visita" do dropdown | Modificar |
| `src/components/customer360/CustomerHero.tsx` | Botão "Agendar visita" no header | Modificar |
| `src/components/reposicao/routePlanner/ScheduledVisitsPanel.tsx` | Painel "Próximas visitas" | Criar |
| `src/pages/AdminRoutePlanner.tsx` | Montar o painel | Modificar |

**Validações canônicas (CLAUDE.md §2/§13):** `heavy bun run test` · `heavy bun run typecheck:strict` · `heavy bunx tsc --noEmit -p tsconfig.app.json` · `bun lint`. Prefixo `heavy` obrigatório.

**Dependência de tipos:** a tabela `visitas_agendadas` só entra em `src/integrations/supabase/types.ts` quando o founder **regenera os tipos via Lovable** (após aplicar a migration). Até lá, o módulo `visitasAgendadas.ts` isola **um único** cast `as unknown as` (NUNCA `as any` — o lint bloqueia) pra a tabela. O código compila e os testes de helper puro passam **sem** a migration aplicada; o runtime real é QA do founder pós-apply.

---

## Task 1: Migration `visitas_agendadas` (backend, Lovable) + revisão adversária codex

**Files:**
- Create: `supabase/migrations/20260530NNNNNN_visitas_agendadas.sql` (NNNNNN = timestamp no apply; ex.: `20260530120000`)

- [ ] **Step 1: Escrever a migration completa**

```sql
-- visitas_agendadas: fila persistente de visitas datadas, owner-scoped.
CREATE TABLE public.visitas_agendadas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  scheduled_by uuid NOT NULL,
  scheduled_date date NOT NULL,
  status text NOT NULL DEFAULT 'pendente',
  visit_type text NOT NULL DEFAULT 'comercial',
  notes text,
  route_visit_id uuid REFERENCES public.route_visits(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visitas_agendadas_status_check CHECK (status IN ('pendente','realizada','cancelada'))
);

-- Anti-duplicata: 1 pendente por (cliente, vendedor, data).
CREATE UNIQUE INDEX uq_vag_pendente_cliente_vendedor_data
  ON public.visitas_agendadas (customer_user_id, scheduled_by, scheduled_date)
  WHERE status = 'pendente';
-- Uma visita realizada fecha no máximo uma agenda.
CREATE UNIQUE INDEX uq_vag_route_visit_id
  ON public.visitas_agendadas (route_visit_id)
  WHERE route_visit_id IS NOT NULL;
-- Calendário do vendedor.
CREATE INDEX idx_vag_scheduled_by_date
  ON public.visitas_agendadas (scheduled_by, scheduled_date);
CREATE INDEX idx_vag_pending_by_seller
  ON public.visitas_agendadas (scheduled_by, scheduled_date)
  WHERE status = 'pendente';

-- updated_at automático.
CREATE OR REPLACE FUNCTION public.set_updated_at_visitas_agendadas()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER trg_vag_updated_at
  BEFORE UPDATE ON public.visitas_agendadas
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_visitas_agendadas();

-- RLS + grants endurecidos.
ALTER TABLE public.visitas_agendadas ENABLE ROW LEVEL SECURITY;

-- ⚠️ Supabase concede privilégios DEFAULT em tabela nova do public p/ anon/authenticated.
-- Sem REVOKE primeiro, o GRANT por coluna NÃO surte efeito (o UPDATE cheio default fica).
REVOKE ALL ON public.visitas_agendadas FROM anon, authenticated, PUBLIC;

GRANT SELECT, INSERT ON public.visitas_agendadas TO authenticated;
GRANT UPDATE (scheduled_date, visit_type, notes, status) ON public.visitas_agendadas TO authenticated;
-- (sem UPDATE em scheduled_by/customer_user_id/route_visit_id → imutáveis; sem DELETE; anon sem nada)

CREATE POLICY "vag_select_own" ON public.visitas_agendadas
  FOR SELECT TO authenticated
  USING (
    scheduled_by = (SELECT auth.uid())
    OR (SELECT public.pode_ver_carteira_completa((SELECT auth.uid())))
  );

CREATE POLICY "vag_insert_own_carteira" ON public.visitas_agendadas
  FOR INSERT TO authenticated
  WITH CHECK (
    scheduled_by = (SELECT auth.uid())
    AND public.carteira_visivel_para(customer_user_id, (SELECT auth.uid()))
    AND status = 'pendente'
    AND route_visit_id IS NULL
  );

CREATE POLICY "vag_update_own_pending" ON public.visitas_agendadas
  FOR UPDATE TO authenticated
  USING (
    scheduled_by = (SELECT auth.uid())
    AND status = 'pendente'
  )
  WITH CHECK (
    scheduled_by = (SELECT auth.uid())
    AND status IN ('pendente','cancelada')
    AND route_visit_id IS NULL
  );

CREATE POLICY "vag_delete_gestor" ON public.visitas_agendadas
  FOR DELETE TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

-- Reconciliação: check-in no route_visits fecha a agenda pendente correspondente.
CREATE OR REPLACE FUNCTION public.reconcile_visita_agendada()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.visitas_agendadas va
  SET status = 'realizada',
      route_visit_id = NEW.id,
      updated_at = now()
  WHERE va.customer_user_id = NEW.customer_user_id
    AND va.scheduled_by    = NEW.visited_by
    AND va.scheduled_date  = NEW.visit_date
    AND va.status = 'pendente'
    AND va.route_visit_id IS NULL;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_reconcile_visita_agendada
  AFTER INSERT OR UPDATE OF check_in_at ON public.route_visits
  FOR EACH ROW
  WHEN (NEW.check_in_at IS NOT NULL)
  EXECUTE FUNCTION public.reconcile_visita_agendada();
```

- [ ] **Step 2: Revisão adversária do SQL pelo codex (ANTES do Lovable)**

Rodar consult adversária no SQL final (escrever o brief num arquivo e chamar):
```bash
codex exec "$(cat /tmp/codex-vag-sql-review.txt)" -C /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/mystifying-lamarr-975bbd -s read-only -c 'model_reasoning_effort="medium"'
```
Brief: "Revise adversarialmente esta migration (RLS/grants/trigger). Confirme: (1) REVOKE+GRANT-por-coluna realmente torna scheduled_by/customer_user_id/route_visit_id imutáveis p/ authenticated via PostgREST; (2) a WITH CHECK do UPDATE impede status='realizada' externo; (3) o trigger SECURITY DEFINER é idempotente e não vira bypass; (4) nenhum furo de IDOR/BFLA vs os padrões 20260526020000/040000. Aponte só o que MUDA o SQL." Incorporar P1/P2 achados antes de entregar.

- [ ] **Step 3: Entregar p/ o founder aplicar via Lovable (skill `lovable-db-operator`)**

Usar a skill `lovable-db-operator` p/ empacotar: bloco SQL pronto pra colar no SQL Editor + query de validação + nota de PR "⚠️ migration manual necessária". Validação pós-apply (colar no SQL Editor):
```sql
SELECT 'visitas_agendadas OK' AS status,
  (SELECT count(*) FROM pg_policies WHERE tablename='visitas_agendadas') AS policies,         -- esperado 4
  (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.visitas_agendadas'::regclass) AS triggers_tbl, -- >=1 (updated_at)
  (SELECT count(*) FROM pg_trigger WHERE tgname='trg_reconcile_visita_agendada') AS recon_trigger,     -- 1
  (SELECT count(*) FROM pg_indexes WHERE tablename='visitas_agendadas') AS indexes;            -- >=5 (pk+4)
```

- [ ] **Step 4: Founder regenera os tipos Supabase via Lovable** (pra `visitas_agendadas` entrar em `types.ts`). Não bloqueia o resto do plano (o módulo da Task 4 isola o cast), mas habilita simplificar o cast depois.

- [ ] **Step 5: Commit**
```bash
git add supabase/migrations/20260530NNNNNN_visitas_agendadas.sql
git commit -m "feat(visitas): migration visitas_agendadas (RLS endurecida + trigger de reconciliacao)"
```

> ⚠️ As Tasks 5–8 só funcionam em RUNTIME após o founder aplicar esta migration. O código compila/testa antes (tipos locais). QA real é pós-apply.

---

## Task 2: Helper puro `deriveVisitaStatus` (TDD)

**Files:**
- Create: `src/lib/visitas/visita-status.ts`
- Test: `src/lib/visitas/__tests__/visita-status.test.ts`

- [ ] **Step 1: Escrever o teste que falha**

```ts
import { describe, it, expect } from 'vitest';
import { deriveVisitaStatus } from '../visita-status';

describe('deriveVisitaStatus', () => {
  const hoje = '2026-05-30';
  it('realizada/cancelada passam direto', () => {
    expect(deriveVisitaStatus('2026-05-01', 'realizada', hoje)).toBe('realizada');
    expect(deriveVisitaStatus('2026-06-10', 'cancelada', hoje)).toBe('cancelada');
  });
  it('pendente no passado → atrasada', () => {
    expect(deriveVisitaStatus('2026-05-29', 'pendente', hoje)).toBe('atrasada');
  });
  it('pendente hoje → hoje', () => {
    expect(deriveVisitaStatus('2026-05-30', 'pendente', hoje)).toBe('hoje');
  });
  it('pendente no futuro → futura', () => {
    expect(deriveVisitaStatus('2026-06-01', 'pendente', hoje)).toBe('futura');
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `heavy bun run test src/lib/visitas/__tests__/visita-status.test.ts`
Expected: FAIL (`deriveVisitaStatus is not a function`).

- [ ] **Step 3: Implementar**

```ts
export type VisitaStatusDerivado = 'realizada' | 'cancelada' | 'atrasada' | 'hoje' | 'futura';

/**
 * Deriva o estado de exibição de uma visita agendada. 'atrasada' NÃO é coluna no
 * banco — é pendente com scheduled_date < hoje. Datas em ISO 'YYYY-MM-DD' (comparação
 * lexicográfica = cronológica nesse formato).
 */
export function deriveVisitaStatus(
  scheduledDate: string,
  status: string,
  today: string,
): VisitaStatusDerivado {
  if (status === 'realizada') return 'realizada';
  if (status === 'cancelada') return 'cancelada';
  if (scheduledDate < today) return 'atrasada';
  if (scheduledDate === today) return 'hoje';
  return 'futura';
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `heavy bun run test src/lib/visitas/__tests__/visita-status.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add src/lib/visitas/visita-status.ts src/lib/visitas/__tests__/visita-status.test.ts
git commit -m "feat(visitas): helper deriveVisitaStatus (TDD)"
```

---

## Task 3: Helper puro `navLink` (TDD) + DRY no route planner

**Files:**
- Create: `src/lib/maps/nav-link.ts`
- Test: `src/lib/maps/__tests__/nav-link.test.ts`
- Modify: `src/hooks/useRoutePlanner.ts` (refatorar `openInWaze`, ~linhas 784-791, p/ usar `navLink`)

- [ ] **Step 1: Escrever o teste que falha**

```ts
import { describe, it, expect } from 'vitest';
import { navLink } from '../nav-link';

describe('navLink', () => {
  it('com coords → Waze por lat/lng', () => {
    expect(navLink('Rua X, 10, Divinópolis, MG', -20.1, -44.9))
      .toBe('https://waze.com/ul?ll=-20.1,-44.9&navigate=yes');
  });
  it('sem coords mas com endereço → Waze por query', () => {
    expect(navLink('Rua X, 10, Divinópolis, MG', null, null))
      .toBe('https://waze.com/ul?q=Rua%20X%2C%2010%2C%20Divin%C3%B3polis%2C%20MG&navigate=yes');
  });
  it('sem coords e sem endereço → null', () => {
    expect(navLink(null)).toBeNull();
    expect(navLink('   ')).toBeNull();
    expect(navLink('', null, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `heavy bun run test src/lib/maps/__tests__/nav-link.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementar**

```ts
/**
 * Monta um link de navegação Waze a partir de coordenadas ou, na falta, de um
 * endereço-texto. Retorna null quando não há nem coords nem endereço utilizável
 * (o call-site esconde o botão "Ir").
 */
export function navLink(
  addressQuery: string | null | undefined,
  lat?: number | null,
  lng?: number | null,
): string | null {
  if (lat != null && lng != null) {
    return `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
  }
  const q = (addressQuery ?? '').trim();
  if (q.length === 0) return null;
  return `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
}
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `heavy bun run test src/lib/maps/__tests__/nav-link.test.ts`
Expected: PASS.

- [ ] **Step 5: DRY — refatorar `openInWaze` no route planner**

Em `src/hooks/useRoutePlanner.ts`, localizar o `openInWaze` (≈ linhas 784-791):
```tsx
const openInWaze = (stop: RouteStop) => {
  if (stop.lat && stop.lng) {
    window.open(`https://waze.com/ul?ll=${stop.lat},${stop.lng}&navigate=yes`, '_blank');
  } else {
    const q = `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}`;
    window.open(`https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`, '_blank');
  }
};
```
Substituir por (importar `navLink` de `@/lib/maps/nav-link` no topo do arquivo):
```tsx
const openInWaze = (stop: RouteStop) => {
  const q = `${stop.address.street}, ${stop.address.number}, ${stop.address.city}, ${stop.address.state}`;
  const href = navLink(q, stop.lat ?? null, stop.lng ?? null);
  if (href) window.open(href, '_blank');
};
```

- [ ] **Step 6: Typecheck + lint + test**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json` → 0 erros.
Run: `bun lint` → sem novos errors.
Run: `heavy bun run test src/lib/maps/__tests__/nav-link.test.ts` → PASS.

- [ ] **Step 7: Commit**
```bash
git add src/lib/maps/nav-link.ts src/lib/maps/__tests__/nav-link.test.ts src/hooks/useRoutePlanner.ts
git commit -m "feat(maps): helper navLink (Waze) + DRY no openInWaze do route planner"
```

---

## Task 4: Módulo de acesso tipado `visitasAgendadas.ts`

**Files:**
- Create: `src/integrations/supabase/visitasAgendadas.ts`

Contexto: a tabela ainda NÃO está nos tipos gerados. Isolamos **um** cast `as unknown as` aqui (lint proíbe `as any`). Após o founder regenerar os tipos, simplificar.

- [ ] **Step 1: Criar o módulo**

```ts
import { supabase } from '@/integrations/supabase/client';

export type VisitaStatus = 'pendente' | 'realizada' | 'cancelada';

export interface VisitaAgendadaRow {
  id: string;
  customer_user_id: string;
  scheduled_by: string;
  scheduled_date: string;   // 'YYYY-MM-DD'
  status: VisitaStatus;
  visit_type: string;
  notes: string | null;
  route_visit_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface NovaVisitaAgendada {
  customer_user_id: string;
  scheduled_by: string;
  scheduled_date: string;
  notes?: string | null;
  visit_type?: string;
}

/**
 * Acesso à tabela `visitas_agendadas` antes dela existir nos tipos gerados do
 * Supabase. Único ponto com cast (via `unknown`, nunca `any`). Depois do regen
 * de tipos via Lovable, trocar por `supabase.from('visitas_agendadas')` direto.
 */
export function visitasAgendadasTable() {
  return (supabase as unknown as {
    from: (table: string) => ReturnType<typeof supabase.from>;
  }).from('visitas_agendadas');
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json` → 0 erros.
Run: `bun lint` → sem novos errors (sem `no-explicit-any`).

- [ ] **Step 3: Commit**
```bash
git add src/integrations/supabase/visitasAgendadas.ts
git commit -m "feat(visitas): modulo de acesso tipado visitasAgendadas (pre type-regen)"
```

---

## Task 5: Hook `useVisitasAgendadas` (query + mutations optimistic)

**Files:**
- Create: `src/hooks/useVisitasAgendadas.ts`

Contexto: padrão de mutation optimista (cancel/snapshot/setQueryData/rollback/invalidate) como em `src/hooks/useMarkMixGapFeedback.ts`. Toast via `import { toast } from 'sonner'`. Auth via `useAuth()` (`src/contexts/AuthContext.tsx`) → `user.id`. Tratar `unique_violation` (Postgres code `23505`).

- [ ] **Step 1: Implementar o hook**

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import {
  visitasAgendadasTable,
  type VisitaAgendadaRow,
} from '@/integrations/supabase/visitasAgendadas';

const KEY = (uid: string | undefined) => ['visitas-agendadas', uid];

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export function useVisitasAgendadas() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const uid = user?.id;
  const key = KEY(uid);

  const proximas = useQuery({
    queryKey: key,
    enabled: !!uid,
    queryFn: async (): Promise<VisitaAgendadaRow[]> => {
      const { data, error } = await visitasAgendadasTable()
        .select('*')
        .eq('scheduled_by', uid!)
        .in('status', ['pendente'])
        .order('scheduled_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as VisitaAgendadaRow[];
    },
  });

  const agendar = useMutation({
    mutationFn: async (input: { customerUserId: string; scheduledDate: string; notes?: string }) => {
      const { error } = await visitasAgendadasTable().insert({
        customer_user_id: input.customerUserId,
        scheduled_by: uid!,
        scheduled_date: input.scheduledDate,
        notes: input.notes ?? null,
        visit_type: 'comercial',
        status: 'pendente',
      });
      if (error) throw error;
    },
    onError: (err) => {
      if (isUniqueViolation(err)) {
        toast.error('Já existe visita pendente pra esse cliente nessa data');
      } else {
        toast.error('Não foi possível agendar a visita');
      }
    },
    onSuccess: () => {
      toast.success('Visita agendada');
      qc.invalidateQueries({ queryKey: key });
    },
  });

  const remarcar = useMutation({
    mutationFn: async (input: { id: string; scheduledDate: string }) => {
      const { error } = await visitasAgendadasTable()
        .update({ scheduled_date: input.scheduledDate })
        .eq('id', input.id);
      if (error) throw error;
    },
    onError: (err) =>
      toast.error(isUniqueViolation(err)
        ? 'Já existe visita pendente nessa nova data'
        : 'Não foi possível remarcar'),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const cancelar = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await visitasAgendadasTable()
        .update({ status: 'cancelada' })
        .eq('id', id);
      if (error) throw error;
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<VisitaAgendadaRow[]>(key);
      qc.setQueryData<VisitaAgendadaRow[]>(key, (old) => (old ?? []).filter((v) => v.id !== id));
      return { prev };
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev);
      toast.error('Não foi possível cancelar');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });

  return { proximas, agendar, remarcar, cancelar };
}
```

- [ ] **Step 2: Typecheck + lint**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json` → 0 erros.
Run: `bun lint` → sem novos errors.

- [ ] **Step 3: Commit**
```bash
git add src/hooks/useVisitasAgendadas.ts
git commit -m "feat(visitas): hook useVisitasAgendadas (query + mutations optimistic)"
```

---

## Task 6: `AgendarVisitaDialog` + 2 pontos de entrada

**Files:**
- Create: `src/components/visitas/AgendarVisitaDialog.tsx`
- Modify: `src/components/adminCustomers/Customer360View.tsx` (dropdown, ~linhas 109-114)
- Modify: `src/components/customer360/CustomerHero.tsx` (ações, ~linha 164)

- [ ] **Step 1: Criar o dialog**

```tsx
import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useVisitasAgendadas } from '@/hooks/useVisitasAgendadas';

function hojeISO(): string {
  return new Date().toISOString().split('T')[0];
}

export function AgendarVisitaDialog({
  customerUserId,
  customerName,
  trigger,
}: {
  customerUserId: string;
  customerName: string;
  trigger: React.ReactNode;
}) {
  const { agendar } = useVisitasAgendadas();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState(hojeISO());
  const [notes, setNotes] = useState('');

  const submit = () => {
    agendar.mutate(
      { customerUserId, scheduledDate: date, notes: notes.trim() || undefined },
      { onSuccess: () => { setOpen(false); setNotes(''); setDate(hojeISO()); } },
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agendar visita — {customerName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="vag-date">Data</Label>
            <Input id="vag-date" type="date" min={hojeISO()} value={date}
              onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="vag-notes">Motivo (opcional)</Label>
            <Textarea id="vag-notes" value={notes} maxLength={500}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Por que vale visitar esse cliente?" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={submit} disabled={agendar.isPending || !date}>
            {agendar.isPending ? 'Agendando…' : 'Agendar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```
> Confirme que `src/components/ui/textarea.tsx` e `label.tsx` existem (shadcn). Se não, usar `<textarea>`/`<label>` nativos com classes equivalentes.

- [ ] **Step 2: Ligar no dropdown do Customer360View**

Em `src/components/adminCustomers/Customer360View.tsx`, importar no topo:
```ts
import { AgendarVisitaDialog } from '@/components/visitas/AgendarVisitaDialog';
```
Trocar o item desabilitado (linhas ~109-114):
```tsx
            <DropdownMenuContent align="end">
              <DropdownMenuItem disabled>
                <Calendar className="w-3.5 h-3.5 mr-2" /> Agendar visita
                <span className="ml-2 text-[10px] text-muted-foreground">em breve</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
```
por:
```tsx
            <DropdownMenuContent align="end">
              <AgendarVisitaDialog
                customerUserId={customer.user_id}
                customerName={customer.name}
                trigger={
                  <DropdownMenuItem onSelect={(e) => e.preventDefault()}>
                    <Calendar className="w-3.5 h-3.5 mr-2" /> Agendar visita
                  </DropdownMenuItem>
                }
              />
            </DropdownMenuContent>
```
> `onSelect={(e) => e.preventDefault()}` impede o menu de fechar antes do dialog abrir (padrão Radix DropdownMenuItem + Dialog).

- [ ] **Step 3: Botão no CustomerHero**

Em `src/components/customer360/CustomerHero.tsx`, importar `AgendarVisitaDialog` e `Calendar` (de `lucide-react`). No bloco "Ações rápidas" (após o botão "Novo pedido", ~linha 169), adicionar:
```tsx
            <AgendarVisitaDialog
              customerUserId={customer.user_id}
              customerName={customer.name}
              trigger={
                <Button variant="outline" size="sm">
                  <Calendar className="w-3.5 h-3.5 mr-1.5" />
                  Agendar visita
                </Button>
              }
            />
```

- [ ] **Step 4: Typecheck + lint**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json` → 0 erros.
Run: `bun lint` → sem novos errors.

- [ ] **Step 5: Commit**
```bash
git add src/components/visitas/AgendarVisitaDialog.tsx src/components/adminCustomers/Customer360View.tsx src/components/customer360/CustomerHero.tsx
git commit -m "feat(visitas): AgendarVisitaDialog + entradas no dropdown e no CustomerHero"
```

---

## Task 7: Painel "Próximas visitas" + check-in 1-toque

**Files:**
- Create: `src/components/reposicao/routePlanner/ScheduledVisitsPanel.tsx`
- Modify: `src/hooks/useVisitasAgendadas.ts` (adicionar mutation `checkIn`)
- Modify: `src/pages/AdminRoutePlanner.tsx` (montar o painel)

Contexto: o check-in cria uma linha em `route_visits` (espelha `handleCheckIn`: `customer_user_id`, `visited_by`, `visit_type='comercial'`, `check_in_at`, lat/lng opcional via geolocalização) → o trigger da Task 1 fecha a agenda. Decisão (desvio do spec): mutation dedicada `checkIn` em vez de reusar `handleCheckIn` do god-hook (desacopla; o trigger faz a reconciliação).

- [ ] **Step 1: Adicionar a mutation `checkIn` ao hook**

Em `src/hooks/useVisitasAgendadas.ts`, dentro do `useVisitasAgendadas`, adicionar (e incluir `checkIn` no return):
```ts
  const checkIn = useMutation({
    mutationFn: async (input: { customerUserId: string }) => {
      const coords = await new Promise<{ lat: number; lng: number } | null>((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
          () => resolve(null),
          { timeout: 5000 },
        );
      });
      const { error } = await (supabase.from('route_visits')).insert({
        customer_user_id: input.customerUserId,
        visited_by: uid!,
        visit_type: 'comercial',
        check_in_at: new Date().toISOString(),
        ...(coords ? { lat: coords.lat, lng: coords.lng } : {}),
      });
      if (error) throw error;
    },
    onError: () => toast.error('Não foi possível fazer check-in'),
    onSuccess: () => {
      toast.success('Check-in feito');
      qc.invalidateQueries({ queryKey: key });
    },
  });
```
Importar `supabase` de `@/integrations/supabase/client` no topo. Incluir `checkIn` no `return { ... }`.
> `route_visits` JÁ está nos tipos gerados → `.insert` tipado direto (sem cast).

- [ ] **Step 2: Criar o painel**

```tsx
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar, Navigation, CheckCircle2, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { useVisitasAgendadas } from '@/hooks/useVisitasAgendadas';
import { deriveVisitaStatus } from '@/lib/visitas/visita-status';
import { navLink } from '@/lib/maps/nav-link';
import { cn } from '@/lib/utils';

function hojeISO(): string {
  return new Date().toISOString().split('T')[0];
}

export function ScheduledVisitsPanel({
  nomePorCliente,
  enderecoPorCliente,
}: {
  // mapas cliente→nome/endereço carregados pela página (route planner já carrega clientes)
  nomePorCliente: Record<string, string>;
  enderecoPorCliente: Record<string, { query: string | null; lat: number | null; lng: number | null }>;
}) {
  const { proximas, cancelar, checkIn } = useVisitasAgendadas();
  const hoje = hojeISO();
  const visitas = proximas.data ?? [];

  if (proximas.isLoading) return null;
  if (visitas.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Calendar className="w-4 h-4" /> Próximas visitas
          <Badge variant="secondary" className="text-[10px]">{visitas.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {visitas.map((v) => {
          const d = deriveVisitaStatus(v.scheduled_date, v.status, hoje);
          const end = enderecoPorCliente[v.customer_user_id];
          const href = end ? navLink(end.query, end.lat, end.lng) : null;
          return (
            <div key={v.id} className="flex items-center gap-2 text-sm border-b last:border-b-0 pb-2 last:pb-0">
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">{nomePorCliente[v.customer_user_id] ?? v.customer_user_id}</div>
                <div className={cn('text-xs', d === 'atrasada' ? 'text-status-warning-bold' : 'text-muted-foreground')}>
                  {d === 'atrasada' ? 'Atrasada · ' : ''}{format(parseISO(v.scheduled_date), "dd 'de' MMM", { locale: ptBR })}
                </div>
              </div>
              {href && (
                <Button asChild variant="ghost" size="icon" className="h-8 w-8" title="Ir (Waze)">
                  <a href={href} target="_blank" rel="noopener noreferrer"><Navigation className="w-4 h-4" /></a>
                </Button>
              )}
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Check-in"
                disabled={checkIn.isPending}
                onClick={() => checkIn.mutate({ customerUserId: v.customer_user_id })}>
                <CheckCircle2 className="w-4 h-4 text-status-success-bold" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" title="Cancelar"
                disabled={cancelar.isPending}
                onClick={() => cancelar.mutate(v.id)}>
                <X className="w-4 h-4 text-muted-foreground" />
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 3: Montar o painel no AdminRoutePlanner**

Em `src/pages/AdminRoutePlanner.tsx`, importar `ScheduledVisitsPanel` e renderizar logo após o `StatsStrip` (≈ linha 182). Construir os mapas `nomePorCliente`/`enderecoPorCliente` a partir dos clientes que o hook do route planner já carrega (`loadManualCustomers`/stops); se a página não expõe isso prontamente, passar mapas vazios `{}` na v1 (o painel ainda lista nome via `customer_user_id` fallback e esconde o botão "Ir" quando não há endereço) e enriquecer na Task 8.
```tsx
<ScheduledVisitsPanel nomePorCliente={nomePorCliente} enderecoPorCliente={enderecoPorCliente} />
```

- [ ] **Step 4: Typecheck + lint**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json` → 0 erros.
Run: `bun lint` → sem novos errors.

- [ ] **Step 5: Commit**
```bash
git add src/hooks/useVisitasAgendadas.ts src/components/reposicao/routePlanner/ScheduledVisitsPanel.tsx src/pages/AdminRoutePlanner.tsx
git commit -m "feat(visitas): painel Proximas visitas no route planner + check-in 1-toque"
```

> **Fim da Fase 1 — feature shippable.** Validação final + QA na Task "Validação".

---

## Task 8 (Fase 2): Agendadas de hoje como parada no mapa do route planner

**Files:**
- Modify: `src/components/reposicao/routePlanner/types.ts` (novo `StopType` `'scheduled_visit'`)
- Modify: `src/hooks/useRoutePlanner.ts` (fonte `loadScheduledVisits` + merge no `allStops` useMemo ~linha 595)

Contexto: o route planner é **today-only**. Esta task surfacea as agendadas com `scheduled_date = hoje` como `RouteStop` (badge "Agendada"), entrando no mapa Leaflet + otimização. `RouteStop` shape em `routePlanner/types.ts:43-70` (id, stopType, customerUserId, customerName, phone, address{...}, lat?, lng?, priorityScore, priorityLabel, priorityFactors, etc.).

- [ ] **Step 1: Adicionar o StopType**

Em `routePlanner/types.ts`, no union `StopType`, adicionar `| 'scheduled_visit'`.

- [ ] **Step 2: Carregar agendadas de hoje e mapear p/ RouteStop**

Em `useRoutePlanner.ts`, criar `loadScheduledVisits()` que: query `visitasAgendadasTable().select('*').eq('scheduled_by', user.id).eq('status','pendente').eq('scheduled_date', today)`; enriquece endereço por cliente (mesma fonte de `loadManualCustomers`: tabela `addresses` is_default / `order.address`); mapeia p/ `RouteStop` com `stopType:'scheduled_visit'`, `visitReason:'Visita agendada'`, `priorityScore` fixo (ex.: 70) e `priorityLabel:'alta'`, `priorityFactors:['Agendada manualmente']`. Reusar o pipeline de geocoding existente (≈ linhas 662-706) p/ preencher lat/lng.

- [ ] **Step 3: Mesclar no `allStops`**

No `useMemo` que combina as fontes (≈ linha 595-644), incluir as agendadas (dedup por `customerUserId` se já houver outra parada do mesmo cliente — preferir manter a agendada com badge). Garantir que o `RouteStopCard` exibe o badge "Agendada" p/ `stopType==='scheduled_visit'`.

- [ ] **Step 4: Typecheck + lint + smoke**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json` → 0 erros.
Run: `bun lint` → sem novos errors.

- [ ] **Step 5: Commit**
```bash
git add src/components/reposicao/routePlanner/types.ts src/hooks/useRoutePlanner.ts
git commit -m "feat(visitas): agendadas de hoje como parada no route planner (4a fonte)"
```

---

## Task 9: Validação final + QA

**Files:** nenhum (verificação)

- [ ] **Step 1: Suíte completa**

Run: `heavy bun run test` → 100% PASS (inclui `deriveVisitaStatus` + `navLink`).
Run: `heavy bun run typecheck:strict` → 0 erros.
Run: `heavy bunx tsc --noEmit -p tsconfig.app.json` → 0 erros.
Run: `bun lint` → sem novos errors.

- [ ] **Step 2: QA manual (founder, pós-apply da migration + regen de tipos)**

- Agendar pelos 2 pontos de entrada (dropdown do detalhe + header 360°); ver na agenda "Próximas visitas".
- "Ir" abre Waze no endereço/coords; botão some quando o cliente não tem endereço.
- Check-in 1-toque cria `route_visits` e a agenda some da lista (vira `realizada`).
- Tentar agendar 2× o mesmo cliente/data → toast "já existe visita pendente…".
- Atrasada (data passada, pendente) aparece com destaque.
- (Fase 2) agendada de hoje aparece como parada no mapa.

- [ ] **Step 3: Validação de segurança (founder, via Lovable SQL Editor, com JWT de vendedor)**

Confirmar que `authenticated` (vendedor) **não** consegue: `UPDATE` de `route_visit_id`/`customer_user_id`/`scheduled_by`; setar `status='realizada'`; `DELETE`; nem ler agenda de outro vendedor (a menos que gestor/master). `anon` não enxerga a tabela.

---

## Notas
- **Migration é manual via Lovable** (CLAUDE.md §5) — usar `lovable-db-operator`. PR sinaliza "⚠️ migration manual necessária".
- **Deploy:** sem edge function/cron. Só a migration.
- **Limitações v1** (no spec §10): reatribuição de carteira (agenda velha fica com o vendedor antigo, que pode cancelar); check-in de cobertura não fecha a agenda do dono; `navLink` depende de endereço/coords.
- **Fase 2 (Task 8)** pode virar PR separado se a integração no god-hook do route planner ficar arriscada — a Fase 1 já é shippable.
