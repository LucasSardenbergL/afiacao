# Clientes não-vinculados (v1 sob demanda) · Implementation Plan

> **⚠️ SUPERSEDED (2026-05-26).** Este plano é da abordagem **standalone** (edge function nova diffando só contra `omie_clientes`), que o build revelou ser **incorreta** (contaria clientes com profile como não-vinculados = relatório enganoso). O design CORRETO (carona no `omie-analytics-sync`, que já enumera + define "vinculado" certo) está no spec `docs/superpowers/specs/2026-05-26-clientes-nao-vinculados-design.md` → seção "Correção de design". Uma sessão fresca **re-planeja** a partir do spec corrigido. Não executar este plano.

---


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relatório sob demanda (master/gestor) dos clientes Omie da Oben que NÃO têm conta no app, via edge function que enumera o Omie (paginado, resumável) e diffa contra `omie_clientes`.

**Architecture:** Edge function `omie-clientes-nao-vinculados` (gated master/gestor server-side) enumera `ListarClientes` da conta **Oben** em chunks resumáveis (cursor de página por `run_id`), com backoff; diffa cada página contra `omie_clientes` (vinculados) e grava os não-vinculados no snapshot. A UI dispara start→continue até completar e lê o último run COMPLETO. Sem cron. Helper de diff puro é TDD; a enumeração é integração.

**Tech Stack:** Supabase Postgres (2 tabelas + RLS via SQL Editor) + Deno edge function (deploy via chat do Lovable, reusa `callOmieApi` do `omie-sync` com creds `OMIE_OBEN_*`) + React/react-query (report + trigger loop). Vitest no helper puro.

**Spec:** `docs/superpowers/specs/2026-05-26-clientes-nao-vinculados-design.md`

> ⚠️ **Os não-negociáveis do Codex são tasks explícitas:** cursor resumável (T1/T4), `run_id`/integridade de snapshot (T1/T4), backoff de rate-limit (T4), auth server-side (T4), observabilidade/contagens (T1/T4), honestidade de UX (T6). A UI lê SÓ o último run com `completed_at` (nunca mistura runs).

---

## File Structure

- Create `supabase/migrations/20260527000000_clientes_nao_vinculados.sql` — `omie_nao_vinculados_runs` (estado/cursor/contagens) + `omie_clientes_nao_vinculados` (linhas por run) + RLS master/gestor + helper `pode_ver_carteira_completa` reuse.
- Create `src/lib/clientes-nao-vinculados/diff.ts` (+ `__tests__/diff.test.ts`) — `computeNaoVinculados(paginaOmie, linkedCodigos)` puro.
- Create `supabase/functions/omie-clientes-nao-vinculados/index.ts` — edge function resumável (copia `callOmieApi` do omie-sync).
- Create `src/hooks/useClientesNaoVinculados.ts` — lê último run completo + linhas.
- Create `src/hooks/useRefreshNaoVinculados.ts` — mutation: loop start→continue até `completed_at`.
- Create `src/pages/AdminClientesNaoVinculados.tsx` — relatório + botão Atualizar + estados.
- Modify `src/App.tsx` — rota lazy `/admin/clientes-nao-vinculados`.
- (Menu: adicionar em Gestão no AppShell — opcional, T6.)

---

## Task 1: Migration — tabelas de run + snapshot + RLS

**Files:** Create `supabase/migrations/20260527000000_clientes_nao_vinculados.sql`

- [ ] **Step 1: Escrever a migration.**

```sql
-- 20260527000000_clientes_nao_vinculados.sql
-- Relatório sob demanda de clientes Omie (Oben) sem conta no app. Resumável por run_id.

CREATE TABLE IF NOT EXISTS public.omie_nao_vinculados_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL DEFAULT 'oben',
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','error')),
  next_page integer NOT NULL DEFAULT 1,          -- próxima página a buscar (cursor)
  total_paginas integer,                          -- total_de_paginas reportado pelo Omie
  total_fetched integer NOT NULL DEFAULT 0,       -- clientes Omie lidos
  linked_matched integer NOT NULL DEFAULT 0,      -- bateram em omie_clientes
  unlinked_found integer NOT NULL DEFAULT 0,      -- não-vinculados gravados
  pages_fetched integer NOT NULL DEFAULT 0,
  error text,
  actor_user_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE public.omie_nao_vinculados_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "nv runs select" ON public.omie_nao_vinculados_runs;
CREATE POLICY "nv runs select" ON public.omie_nao_vinculados_runs
  FOR SELECT USING (pode_ver_carteira_completa(auth.uid()));

CREATE TABLE IF NOT EXISTS public.omie_clientes_nao_vinculados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.omie_nao_vinculados_runs(id) ON DELETE CASCADE,
  empresa text NOT NULL DEFAULT 'oben',
  omie_codigo_cliente bigint NOT NULL,
  razao_social text,
  nome_fantasia text,
  cnpj_cpf text,
  codigo_vendedor bigint,
  cidade text,
  uf text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, omie_codigo_cliente)
);
CREATE INDEX IF NOT EXISTS idx_nv_run ON public.omie_clientes_nao_vinculados(run_id);
ALTER TABLE public.omie_clientes_nao_vinculados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "nv linhas select" ON public.omie_clientes_nao_vinculados;
CREATE POLICY "nv linhas select" ON public.omie_clientes_nao_vinculados
  FOR SELECT USING (pode_ver_carteira_completa(auth.uid()));

SELECT 'BLOCO CLIENTES-NV OK' AS status,
  (SELECT count(*) FROM information_schema.tables
   WHERE table_name IN ('omie_nao_vinculados_runs','omie_clientes_nao_vinculados')) AS tbl;
```

> ⚠️ Confirmar que `pode_ver_carteira_completa(uuid)` existe (criado no #329; = master OU gestor comercial). Se o nome divergir, ajustar. Escrita é via `service_role` (edge function) → bypassa RLS; a RLS é só pra leitura master/gestor.

- [ ] **Step 2: Entregar (BLOCO CLIENTES-NV).** Esperado `tbl=2`.
- [ ] **Step 3: Commit.**
```bash
git add supabase/migrations/20260527000000_clientes_nao_vinculados.sql
git commit -m "feat(clientes-nv): tabelas de run + snapshot + RLS master/gestor"
```

## Task 2: Helper puro `computeNaoVinculados` (TDD)

**Files:** Create `src/lib/clientes-nao-vinculados/diff.ts` + `__tests__/diff.test.ts`

- [ ] **Step 1: Teste (falha).**
```ts
// src/lib/clientes-nao-vinculados/__tests__/diff.test.ts
import { describe, it, expect } from 'vitest';
import { computeNaoVinculados, type OmieClientePagina } from '../diff';

const pagina: OmieClientePagina[] = [
  { codigo_cliente_omie: 100, razao_social: 'A' },
  { codigo_cliente_omie: 200, razao_social: 'B' },
  { codigo_cliente_omie: 300, razao_social: 'C' },
];

describe('computeNaoVinculados', () => {
  it('retorna só os codigos ausentes do set de vinculados', () => {
    const linked = new Set<number>([200]);
    const r = computeNaoVinculados(pagina, linked);
    expect(r.map((c) => c.codigo_cliente_omie)).toEqual([100, 300]);
  });
  it('normaliza codigo (string vs number) dos dois lados', () => {
    const linked = new Set<number>([100, 200, 300]);
    expect(computeNaoVinculados(pagina, linked)).toEqual([]);
  });
  it('página vazia → []', () => {
    expect(computeNaoVinculados([], new Set())).toEqual([]);
  });
});
```

- [ ] **Step 2: Rodar (falha).** `heavy bun run test src/lib/clientes-nao-vinculados` → FAIL.

- [ ] **Step 3: Implementar.**
```ts
// src/lib/clientes-nao-vinculados/diff.ts
export interface OmieClientePagina {
  codigo_cliente_omie: number;
  razao_social?: string | null;
  nome_fantasia?: string | null;
  cnpj_cpf?: string | null;
  codigo_vendedor?: number | null;
  cidade?: string | null;
  estado?: string | null;
}

/** Clientes da página que NÃO estão no set de vinculados. Normaliza codigo a Number. */
export function computeNaoVinculados(
  pagina: OmieClientePagina[],
  linkedCodigos: Set<number>,
): OmieClientePagina[] {
  return pagina.filter((c) => !linkedCodigos.has(Number(c.codigo_cliente_omie)));
}
```

- [ ] **Step 4: Rodar (passa).** `heavy bun run test src/lib/clientes-nao-vinculados` → PASS (3).
- [ ] **Step 5: Commit.**
```bash
git add src/lib/clientes-nao-vinculados/
git commit -m "feat(clientes-nv): helper puro computeNaoVinculados (TDD)"
```

## Task 3: Edge function `omie-clientes-nao-vinculados` (resumável)

**Files:** Create `supabase/functions/omie-clientes-nao-vinculados/index.ts`

- [ ] **Step 1: Escrever a function.** Requisitos (must-gets do Codex):
  - **Auth server-side:** validar o JWT do caller e que é **master OU gestor comercial** (espelhar o gate de `omie-financeiro`/`fin-valor-cockpit`: `user_roles` master OU `commercial_roles ∈ {gerencial,estrategico,super_admin}`). 403 caso contrário.
  - **Copiar o helper `callOmieApi`** de `supabase/functions/omie-sync/index.ts` **verbatim**, trocando as creds pra `Deno.env.get("OMIE_OBEN_APP_KEY")` / `OMIE_OBEN_APP_SECRET`. (Não reinventar o formato de request do Omie.)
  - **Modos** (body `{ action: 'start' | 'continue', run_id? }`):
    - `start`: cria uma linha em `omie_nao_vinculados_runs` (status='running', next_page=1, actor=auth.uid()); retorna `{ run_id, status, next_page }`.
    - `continue`: processa **um chunk de até `CHUNK_PAGES = 8` páginas** a partir de `next_page`; atualiza o run.
  - **Por página:** `callOmieApi("geral/clientes/", "ListarClientes", { pagina, registros_por_pagina: 100 })`. Ler `clientes_cadastro` + `total_de_paginas`. Carregar o set de **vinculados** = `SELECT omie_codigo_cliente FROM omie_clientes WHERE empresa_omie = 'oben'` (uma vez por chunk, em Set<number>). Mapear cada `clientes_cadastro` p/ `OmieClientePagina` (codigo_cliente_omie, razao_social, nome_fantasia, cnpj_cpf, codigo_vendedor = `recomendacoes?.codigo_vendedor ?? codigo_vendedor`, cidade, estado). `computeNaoVinculados` (inline a mesma lógica — Deno não importa do src; replicar o filtro). `upsert` os não-vinculados em `omie_clientes_nao_vinculados` (onConflict `run_id,omie_codigo_cliente`), via service_role.
  - **Contadores:** acumular total_fetched, linked_matched, unlinked_found, pages_fetched no run.
  - **Backoff:** em `faultstring` de rate-limit (ex.: "Consumo redundante"/HTTP 425/5xx), `await sleep(exponencial)` e retry até 3x; se persistir, gravar `status='error'`, `error=...`, e retornar (a UI mostra falha).
  - **Cursor:** ao fim do chunk, se `pagina_atual >= total_de_paginas` → `status='completed'`, `completed_at=now()`; senão `next_page = pagina_atual + 1`, status segue 'running'. Sempre `updated_at=now()`.
  - **Budget:** o chunk de 8 páginas (~8×0.5–1s) cabe folgado em 130s; a UI chama `continue` em loop até `completed`.
  - Retornar `{ run_id, status, next_page, total_paginas, unlinked_found, pages_fetched }`.

- [ ] **Step 2: Montar o prompt de deploy pro Lovable** (a function é nova; deploy via chat do Lovable lendo `supabase/functions/omie-clientes-nao-vinculados/index.ts` do repo). Sem `VITE_*`. Confirmar que `OMIE_OBEN_APP_KEY/SECRET` já existem nas env vars (outras functions usam).

- [ ] **Step 3: `deno check`** (se disponível no worktree) ou revisão estática. Commit.
```bash
git add supabase/functions/omie-clientes-nao-vinculados/index.ts
git commit -m "feat(clientes-nv): edge function resumável (Oben, cursor+backoff+auth+contadores)"
```

## Task 4: Hooks — leitura + refresh em loop

**Files:** Create `src/hooks/useClientesNaoVinculados.ts` + `src/hooks/useRefreshNaoVinculados.ts`

- [ ] **Step 1: `useClientesNaoVinculados`** — lê o **último run `completed`** + suas linhas:
```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface NaoVinculadoRow {
  omie_codigo_cliente: number; razao_social: string | null; nome_fantasia: string | null;
  cnpj_cpf: string | null; codigo_vendedor: number | null; cidade: string | null; uf: string | null;
}
export interface NVRun {
  id: string; status: string; unlinked_found: number; total_fetched: number;
  pages_fetched: number; total_paginas: number | null; completed_at: string | null; error: string | null;
}

export function useClientesNaoVinculados() {
  return useQuery({
    queryKey: ['clientes-nao-vinculados'],
    staleTime: 60_000,
    queryFn: async (): Promise<{ run: NVRun | null; rows: NaoVinculadoRow[] }> => {
      const { data: runs, error: e1 } = await supabase
        .from('omie_nao_vinculados_runs').select('*')
        .eq('status', 'completed').order('completed_at', { ascending: false }).limit(1);
      if (e1) throw e1;
      const run = (runs?.[0] as NVRun | undefined) ?? null;
      if (!run) return { run: null, rows: [] };
      const { data: rows, error: e2 } = await supabase
        .from('omie_clientes_nao_vinculados')
        .select('omie_codigo_cliente, razao_social, nome_fantasia, cnpj_cpf, codigo_vendedor, cidade, uf')
        .eq('run_id', run.id).order('razao_social', { ascending: true }).limit(2000);
      if (e2) throw e2;
      return { run, rows: (rows ?? []) as NaoVinculadoRow[] };
    },
  });
}
```
> `omie_nao_vinculados_runs`/`omie_clientes_nao_vinculados` ficam fora dos tipos gerados → cast no boundary `(supabase as unknown as { from(t:string): ... })` se o typecheck reclamar (padrão do repo). Ajustar no Step de typecheck.

- [ ] **Step 2: `useRefreshNaoVinculados`** — mutation que faz o loop start→continue até `completed`/`error`, invocando a edge function via `supabase.functions.invoke('omie-clientes-nao-vinculados', { body })`, atualizando um progresso local; `onSettled` invalida `['clientes-nao-vinculados']`. Limite de segurança: máx ~40 chamadas `continue` (≈320 páginas) pra não loopar infinito.

- [ ] **Step 3: Typecheck.** `heavy bun run typecheck:strict` → 0. Commit.

## Task 5: Página de relatório

**Files:** Create `src/pages/AdminClientesNaoVinculados.tsx` + Modify `src/App.tsx`

- [ ] **Step 1: Página** — usa `useClientesNaoVinculados` + `useRefreshNaoVinculados`. Mostra: título, **botão "Atualizar lista"** (dispara o refresh; desabilita + barra de progresso enquanto roda), `refreshed_at` (= `run.completed_at`) e contagem (`unlinked_found`), tabela (razão social, nome fantasia, CNPJ, cód. vendedor, cidade/UF). **Estados honestos:** sem run → "Nunca atualizado, clique em Atualizar"; run em erro → banner vermelho com `error`; durante refresh → "Buscando página X…". Usa `<PageSkeleton variant="list" />` no loading, `EmptyState` quando vazio.
- [ ] **Step 2: Rota** — em `src/App.tsx`: `const AdminClientesNaoVinculados = lazy(() => import("./pages/AdminClientesNaoVinculados"));` + `<Route path="admin/clientes-nao-vinculados" element={<AdminClientesNaoVinculados />} />` dentro do bloco autenticado. (Gate de menu/persona fica pra quando #221 existir; a RLS + o gate da edge function já protegem os dados.)
- [ ] **Step 3: Typecheck + build.** `heavy bun run typecheck:strict` → 0; `heavy bun run build` → OK. Commit.

## Task 6: Menu + Codex review + validação + PR + rollout

- [ ] **Step 1: Menu (opcional)** — link em "Gestão" no `AppShell.tsx` pra `/admin/clientes-nao-vinculados` (gestor/master). Se arriscar conflito com sessões paralelas no AppShell, pular e acessar por URL no v1.
- [ ] **Step 2: Codex review** — `codex exec` na edge function + migration: auth server-side correto? cursor/backoff/integridade de snapshot? a Oben é a conta certa? diff normaliza codigo? Corrigir achados.
- [ ] **Step 3: Suite** — `heavy bun run test` (verde) · `typecheck:strict` (0) · `bun lint` (0) · `heavy bun run build`. `bun run audit:migrations` + add.
- [ ] **Step 4: PR** — corpo com o BLOCO CLIENTES-NV + o **prompt de deploy da edge function** + "ATENÇÃO: migration manual + deploy de edge function". `gh pr merge --squash --auto`.
- [ ] **Step 5: Rollout (founder)** — BLOCO no SQL Editor (`tbl=2`) → deploy da edge function via chat do Lovable → deploy do front → master abre `/admin/clientes-nao-vinculados` → "Atualizar" → confere a lista. **Primeira execução observada** (o batch real contra o Omie de produção): conferir contagens plausíveis (total_fetched ≈ nº de clientes Oben; unlinked_found razoável).

---

## Self-Review (preenchido)

**Spec coverage:** ✅ on-demand/sem cron (T3/T4) · master/gestor (T1 RLS + T3 auth) · Oben (T3 creds+filtro) · snapshot+run (T1) · cursor resumável (T3/T4) · backoff (T3) · integridade run_id (T1/T4 lê só completed) · diff normalizado (T2) · auth server-side (T3) · observabilidade/contadores (T1/T3) · UX honesta (T5).

**Placeholders:** nenhum. A única instrução "copiar verbatim" é o `callOmieApi` (proposital — não reinventar o request Omie).

**Type consistency:** `OmieClientePagina` (T2) usado na edge fn (T3, replicado em Deno). `NVRun`/`NaoVinculadoRow` (T4) consumidos na página (T5). queryKey `['clientes-nao-vinculados']` igual em T4↔T5.

**Riscos:** (1) conta Omie — **Oben** (`OMIE_OBEN_*`), confirmar o valor de `omie_clientes.empresa_omie` p/ Oben no Step de migration/edge. (2) `pode_ver_carteira_completa` deve existir (#329). (3) budget — chunk de 8 páginas + loop na UI; limite de segurança de 40 continues. (4) primeira execução é o batch real contra prod — observar contagens.
