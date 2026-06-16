# Grupo de Cliente 360 — Fase 1 (Financeiro + Contatos) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar um lugar no app pra agrupar documentos (CNPJ/CPF) de um mesmo dono numa identidade única e ver os recebíveis (cobrança) e contatos somados em cima do grupo, atravessando as 3 empresas.

**Architecture:** 2 tabelas novas (`cliente_grupos`, `cliente_grupo_membros`) + 1 view de agregação de recebíveis (`v_grupo_contas_receber`) lendo o que o Omie já sincroniza em `fin_contas_receber` (read-only, não emite nada). Frontend: 1 página de gestão de grupos + 1 ficha "Grupo 360" com abas Financeiro e Contatos. Acesso staff (master/gestor), igual ao financeiro.

**Tech Stack:** React 18 + TS + Vite, @tanstack/react-query, Supabase (Postgres + RLS), shadcn/ui. Banco aplicado via Lovable SQL Editor (sem CLI). Spec: [`docs/superpowers/specs/2026-06-15-grupo-cliente-360-design.md`](../specs/2026-06-15-grupo-cliente-360-design.md).

> **Rituais obrigatórios deste repo (CLAUDE.md):** banco entra via skill `lovable-db-operator` (a migration custom NÃO aplica sozinha no Lovable — precisa colar no SQL Editor + validar). A view de recebível é **money-path** → provar num Postgres 17 local via skill `prove-sql-money-path` ANTES de aplicar. Frontend testa com `bun run test` (vitest).

> **Branch:** implementar numa branch nova off `main` (depois do merge do #887). NÃO nesta branch da skill.

---

## File Structure

**Banco (migrations custom — `supabase/migrations/`):**
- `YYYYMMDDHHMMSS_cliente_grupos.sql` — as 2 tabelas + índices + RLS.
- `YYYYMMDDHHMMSS_v_grupo_contas_receber.sql` — a view de agregação de recebíveis.

**Frontend:**
- `src/integrations/supabase/types.ts` — regenerado (tipos das tabelas novas).
- `src/queries/useClienteGrupos.ts` — CRUD de grupos + membros (react-query).
- `src/queries/useGrupoFinanceiro.ts` — rollup de recebíveis do grupo (lê a view).
- `src/queries/useGrupoContatos.ts` — contatos/cadastro dos documentos do grupo.
- `src/pages/GestaoGruposCliente.tsx` — página de gestão (lista + criar/editar + add documento).
- `src/pages/GrupoCliente360.tsx` — ficha do grupo (abas Financeiro / Contatos).
- `src/components/grupos/` — subcomponentes (GrupoFormDialog, AddDocumentoDialog, GrupoFinanceiroTab, GrupoContatosTab).
- `src/App.tsx` — registrar as 2 rotas (lazy) + gate de acesso.
- Testes: `src/queries/__tests__/useGrupoFinanceiro.test.ts` (lógica de agregação), `src/components/grupos/__tests__/*`.

**Padrões a seguir (já existem no repo):**
- Gate de acesso financeiro: `src/lib/financeiro/omie-request.ts` (`hasFinanceiroAccess`, `GESTOR_COMMERCIAL_ROLES`).
- Shell de página financeira + select de empresa: `src/pages/FinanceiroGestao.tsx`.
- Padrão de query hook: `src/queries/useOrders.ts` / `useProfile.ts`.
- Roles/auth: `src/contexts/AuthContext.tsx` (`isStaff`, `isMaster`).

---

## Task 1: Confirmar o schema real de `fin_contas_receber` (read-only)

A view de recebível depende dos nomes EXATOS das colunas de saldo/vencimento/status. O design fixou o join (`company` + `cnpj_cpf`); os nomes de valor são confirmados aqui antes de escrever a view. Sem isso, a view money-path sai errada.

**Files:** nenhum (query read-only no Lovable).

- [ ] **Step 1: Rodar no Lovable → SQL Editor → cola → Run, e anotar os nomes reais:**

```sql
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'fin_contas_receber'
order by ordinal_position;
```

- [ ] **Step 2: Amostra pra entender status/saldo/vencimento:**

```sql
select * from fin_contas_receber
order by data_vencimento desc nulls last
limit 5;   -- ⚙️ se 'data_vencimento' não existir, ajustar pelo resultado do Step 1
```

- [ ] **Step 3: Registrar no plano** (editar este arquivo) o mapeamento real → variáveis usadas na Task 3:
  - `COL_SALDO` = (ex.: `saldo` / `valor_documento` / `valor_aberto`)
  - `COL_VENCIMENTO` = (ex.: `data_vencimento`)
  - `COL_STATUS` = (ex.: `status_titulo`) e os VALORES de "em aberto" (ex.: `'ABERTO','VENCIDO','PARCIAL'`)
  - Confirmar que `company` e `cnpj_cpf` existem (esperado: sim).

> Sem step de teste automatizado — é descoberta de schema. O "passou" é ter os 4 nomes confirmados.

---

## Task 2: Migration das tabelas `cliente_grupos` + `cliente_grupo_membros` + RLS

Usar a skill **`lovable-db-operator`** (ela empacota: arquivo de migration + bloco pro SQL Editor + query de validação + nota de PR + regenera audit). As tabelas são novas, então o SQL é totalmente definido aqui.

**Files:**
- Create: `supabase/migrations/YYYYMMDDHHMMSS_cliente_grupos.sql`

- [ ] **Step 1: Escrever a migration (conteúdo completo):**

```sql
-- cliente_grupos: um dono/grupo (identidade única)
create table if not exists public.cliente_grupos (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  notas text,
  ativo boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- cliente_grupo_membros: os documentos (CNPJ/CPF) do grupo
create table if not exists public.cliente_grupo_membros (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references public.cliente_grupos(id) on delete cascade,
  documento text not null,                 -- só dígitos (CPF 11 / CNPJ 14)
  relation_type text not null default 'incerto'
    check (relation_type in ('sucessao','multi_ativo','incerto')),
  valid_from date,
  valid_to date,
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz default now(),
  note text,
  created_at timestamptz not null default now(),
  constraint cliente_grupo_membros_documento_key unique (documento)  -- 1 documento = 1 grupo
);

create index if not exists idx_cgm_grupo on public.cliente_grupo_membros(grupo_id);
create index if not exists idx_cgm_documento on public.cliente_grupo_membros(documento);

-- updated_at trigger (seguir o padrão do repo se já houver função set_updated_at)
create or replace function public.cliente_grupos_touch_updated_at() returns trigger
  language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_cliente_grupos_touch on public.cliente_grupos;
create trigger trg_cliente_grupos_touch before update on public.cliente_grupos
  for each row execute function public.cliente_grupos_touch_updated_at();

-- RLS: staff-only (master OU gestor comercial). Seguir o helper existente do projeto.
alter table public.cliente_grupos enable row level security;
alter table public.cliente_grupo_membros enable row level security;
```

- [ ] **Step 2: Escrever as RLS policies** seguindo EXATAMENTE o padrão das tabelas `fin_*` (ver `supabase/migrations/20260328200000_financial_module.sql` linhas ~236-270). Confirmar como o repo checa "master/gestor" (via `user_roles` e/ou `commercial_roles`) e replicar. Esboço a ajustar ao padrão real:

```sql
-- ⚙️ ALINHAR ao predicado real usado nas fin_* (user_roles role in ('admin','manager') OU master/commercial gestor)
create policy cliente_grupos_staff_all on public.cliente_grupos
  for all using ( public.is_staff_or_master(auth.uid()) ) with check ( public.is_staff_or_master(auth.uid()) );
create policy cgm_staff_all on public.cliente_grupo_membros
  for all using ( public.is_staff_or_master(auth.uid()) ) with check ( public.is_staff_or_master(auth.uid()) );
-- service_role bypass se o padrão do projeto exigir (ver fin_* policies)
```

- [ ] **Step 3: Aplicar via `lovable-db-operator`** — colar o bloco no Lovable SQL Editor → Run.

- [ ] **Step 4: Validar (query que a skill gera) no Lovable:**

```sql
select
  exists(select 1 from information_schema.tables where table_name='cliente_grupos') as t_grupos,
  exists(select 1 from information_schema.tables where table_name='cliente_grupo_membros') as t_membros,
  exists(select 1 from pg_constraint where conname='cliente_grupo_membros_documento_key') as uniq_doc;
-- esperado: t,t,t
```

- [ ] **Step 5: Commit** (migration no repo):

```bash
git add supabase/migrations/*_cliente_grupos.sql
git commit -m "feat(db): tabelas cliente_grupos + cliente_grupo_membros + RLS (Grupo 360 F1)"
```

---

## Task 3: View `v_grupo_contas_receber` (money-path — provar antes de aplicar)

A view soma recebíveis em aberto por grupo, across `company`, e expõe por documento. É **money-path** → provar num Postgres 17 local via skill **`prove-sql-money-path`** antes de aplicar no Lovable.

**Files:**
- Create: `supabase/migrations/YYYYMMDDHHMMSS_v_grupo_contas_receber.sql`

- [ ] **Step 1: Escrever a view** (usar os nomes confirmados na Task 1 — `COL_SALDO`/`COL_VENCIMENTO`/`COL_STATUS`):

```sql
create or replace view public.v_grupo_contas_receber as
with membros as (
  select grupo_id, regexp_replace(documento,'\D','','g') as doc
  from public.cliente_grupo_membros
),
titulos as (
  select regexp_replace(fcr.cnpj_cpf,'\D','','g') as doc,
         fcr.company,
         fcr.COL_SALDO::numeric as saldo,                    -- ⚙️ nome real da Task 1
         fcr.COL_VENCIMENTO::date as vencimento,             -- ⚙️
         fcr.COL_STATUS as status                            -- ⚙️
  from public.fin_contas_receber fcr
  where fcr.COL_STATUS in ('ABERTO','VENCIDO','PARCIAL')     -- ⚙️ valores reais da Task 1
)
select g.id as grupo_id, g.nome,
       count(distinct m.doc) filter (where t.doc is not null) as documentos_com_titulo,
       coalesce(sum(t.saldo),0) as total_aberto,
       coalesce(sum(t.saldo) filter (where t.vencimento >= current_date),0) as a_vencer,
       coalesce(sum(t.saldo) filter (where current_date - t.vencimento between 1 and 30),0) as venc_1_30,
       coalesce(sum(t.saldo) filter (where current_date - t.vencimento between 31 and 60),0) as venc_31_60,
       coalesce(sum(t.saldo) filter (where current_date - t.vencimento between 61 and 90),0) as venc_61_90,
       coalesce(sum(t.saldo) filter (where current_date - t.vencimento > 90),0) as venc_90_mais
from public.cliente_grupos g
join membros m on m.grupo_id = g.id
left join titulos t on t.doc = m.doc
where g.ativo = true
group by g.id, g.nome;

-- view por-documento (expor a composição — exigência do design)
create or replace view public.v_grupo_contas_receber_por_doc as
select m.grupo_id, m.doc as documento, t.company,
       coalesce(sum(t.saldo),0) as total_aberto
from membros m   -- ⚠️ repetir os CTEs ou materializar; ver nota
left join titulos t on t.doc = m.doc
group by m.grupo_id, m.doc, t.company;
```

> Nota: views não compartilham CTE — na real, inline os CTEs em cada view, ou crie uma view base `v_titulos_abertos_norm` e as duas derivam dela (preferível, DRY). Decidir na implementação.

- [ ] **Step 2: Provar via `prove-sql-money-path`** (PG17 local). Asserts mínimos:
  - **Positivo:** grupo com 2 documentos, um na Colacor (R$100 aberto) e outro na Oben (R$50) → `total_aberto = 150` (soma across company).
  - **Positivo (aging):** título vencido há 45 dias cai em `venc_31_60`, não em `a_vencer`.
  - **Negativo (vazamento):** documento que NÃO está em nenhum grupo não aparece em nenhuma linha da view.
  - **Negativo (CPF):** membro com CPF (11 dígitos) casa com `cnpj_cpf` de CPF (normalização por dígitos funciona pra CPF e CNPJ).
  - **Falsificação:** trocar o join de `doc` por `company` → o assert positivo deve FICAR VERMELHO (prova que o teste pega o erro).

- [ ] **Step 3: Aplicar via `lovable-db-operator`** (colar no SQL Editor) + validar:

```sql
select exists(select 1 from information_schema.views where table_name='v_grupo_contas_receber') as v_ok;
```

- [ ] **Step 4: Commit:**

```bash
git add supabase/migrations/*_v_grupo_contas_receber.sql
git commit -m "feat(db): view v_grupo_contas_receber (rollup recebíveis por grupo) — money-path provado"
```

---

## Task 4: Regenerar tipos do Supabase

**Files:** Modify `src/integrations/supabase/types.ts`

- [ ] **Step 1:** Regenerar os tipos (pelo fluxo do projeto — Lovable/Supabase) pra incluir `cliente_grupos`, `cliente_grupo_membros`, `v_grupo_contas_receber`. Confirmar que os tipos aparecem em `types.ts`.
- [ ] **Step 2: Commit:** `git commit -am "chore(types): regenera tipos supabase (grupos de cliente)"`

---

## Task 5: Hook `useClienteGrupos` (CRUD grupos + membros)

**Files:**
- Create: `src/queries/useClienteGrupos.ts`
- Test: `src/queries/__tests__/useClienteGrupos.test.ts`

- [ ] **Step 1: Escrever o teste** (mockando supabase client, padrão dos testes existentes em `src/queries/__tests__` se houver; senão seguir `src/test/` setup):

```ts
import { describe, it, expect, vi } from 'vitest';
// mock do supabase client retornando uma lista de grupos
// assert: useClienteGrupos retorna data normalizada [{id, nome, membros: [...]}]
```

- [ ] **Step 2: Rodar e ver falhar:** `bun run test src/queries/__tests__/useClienteGrupos.test.ts` → FAIL (hook não existe).

- [ ] **Step 3: Implementar o hook** com react-query: `listGrupos` (select grupos + membros), `createGrupo`, `updateGrupo`, `addMembro(documento, relation_type, note)` (normaliza dígitos antes de inserir; trata erro de UNIQUE → "documento já está em outro grupo"), `removeMembro`. Invalida queryKey `['cliente-grupos']` em cada mutação.

- [ ] **Step 4: Rodar e ver passar.** **Step 5: Commit.**

---

## Task 6: Hooks `useGrupoFinanceiro` + `useGrupoContatos`

**Files:**
- Create: `src/queries/useGrupoFinanceiro.ts`, `src/queries/useGrupoContatos.ts`
- Test: `src/queries/__tests__/useGrupoFinanceiro.test.ts`

- [ ] **Step 1: Teste de `useGrupoFinanceiro`** — mock da view `v_grupo_contas_receber` retornando `{total_aberto, a_vencer, venc_1_30, ...}` + a view por-doc; assert que o hook expõe total + aging + breakdown por documento.
- [ ] **Step 2: Ver falhar.**
- [ ] **Step 3: Implementar** — `useGrupoFinanceiro(grupoId)` lê `v_grupo_contas_receber` (filtro grupo_id) + `v_grupo_contas_receber_por_doc`. `useGrupoContatos(grupoId)` lê `profiles`/`addresses` dos documentos do grupo (resolve documento → user_id via `profiles.cnpj`/`document`).
- [ ] **Step 4: Ver passar.** **Step 5: Commit.**

---

## Task 7: Rota + gate de acesso

**Files:** Modify `src/App.tsx`

- [ ] **Step 1:** Registrar lazy routes `/gestao/grupos-cliente` (`GestaoGruposCliente`) e `/gestao/grupos-cliente/:grupoId` (`GrupoCliente360`), seguindo o padrão de lazy import + `<Suspense>` já usado em `App.tsx`.
- [ ] **Step 2:** Gate de acesso: reusar `hasFinanceiroAccess` (de `src/lib/financeiro/omie-request.ts`) — redirecionar/364 quem não é master/gestor. Seguir como `FinanceiroGestao` faz o gate.
- [ ] **Step 3:** Adicionar o item na sidebar (seção **Gestão**) em `AppShell.tsx`, visível só pra quem tem acesso.
- [ ] **Step 4: Commit.**

---

## Task 8: Página de gestão `GestaoGruposCliente`

**Files:**
- Create: `src/pages/GestaoGruposCliente.tsx`, `src/components/grupos/GrupoFormDialog.tsx`, `src/components/grupos/AddDocumentoDialog.tsx`

- [ ] **Step 1:** Shell da página seguindo `FinanceiroGestao.tsx` (header + gate). Lista de grupos via `useClienteGrupos` (nome · nº documentos · exposição total via `useGrupoFinanceiro` ou um select agregado · status). Botão "Novo grupo".
- [ ] **Step 2:** `GrupoFormDialog` — criar/editar (nome, notas). `AddDocumentoDialog` — busca documento por nome/CNPJ (consulta `profiles`), adiciona com `relation_type`. Tratar erro de UNIQUE com mensagem clara ("documento já pertence ao grupo X").
- [ ] **Step 3:** (opcional F1, pode ir pra F2) botão "Sugestões" que roda os diagnósticos de `unificacao-cnpj.md` como candidatos a confirmar. Se cortar de F1, marcar no roadmap.
- [ ] **Step 4:** Teste de render + fluxo de criar grupo (vitest + testing-library, se o padrão do repo usar). **Step 5: Commit.**

---

## Task 9: Ficha `GrupoCliente360` (abas Financeiro + Contatos)

**Files:**
- Create: `src/pages/GrupoCliente360.tsx`, `src/components/grupos/GrupoFinanceiroTab.tsx`, `src/components/grupos/GrupoContatosTab.tsx`

- [ ] **Step 1:** Header do grupo (nome · nº documentos · relation_types · **exposição total**). Tabs shadcn (Financeiro / Contatos).
- [ ] **Step 2: `GrupoFinanceiroTab`** — cards de total em aberto + aging (a vencer / 1-30 / 31-60 / 61-90 / 90+) via `useGrupoFinanceiro`; **tabela por documento** (exigência do design: expor a composição). Banner: "Visão consolidada — a cobrança é emitida no Omie por documento."
- [ ] **Step 3: `GrupoContatosTab`** — lista dos documentos com nome, telefone, cidade/endereço, vendedor (via `useGrupoContatos`).
- [ ] **Step 4:** Teste de render com dados mockados (total bate com soma; por-documento aparece). **Step 5: Commit.**

---

## Task 10: Verificação fim-a-fim + lint/build

- [ ] **Step 1:** `bun lint && bun run test` — tudo verde.
- [ ] **Step 2:** `bun build` — sem erro (PWA/Tailwind ok).
- [ ] **Step 3:** Smoke manual (ou `/qa`): criar um grupo com 2 documentos (um Colacor, um Oben), abrir o 360, conferir que o total bate com a soma dos dois e que o aging aparece.
- [ ] **Step 4:** Abrir PR (própria branch) com a nota: "Fase 1 do Grupo 360. Migrations exigem apply manual no Lovable (ver corpo). View de recebível provada via prove-sql-money-path."

---

## Self-review (cobertura do spec)

- Tabelas + RLS → Task 2. ✅
- Identidade documento (CPF+CNPJ) + UNIQUE → Task 2 (constraint) + Task 5 (normalização). ✅
- Cross-empresa (soma nos 3) → Task 3 (view across `company`). ✅
- Aba Financeiro (aging + por-documento) → Task 3 + Task 9. ✅
- Aba Contatos → Task 6 + Task 9. ✅
- Acesso master/gestor + RLS → Task 2 + Task 7. ✅
- Money-path provado → Task 3 (prove-sql-money-path). ✅
- "Não é emissão" → banner na Task 9. ✅
- Comercial + dedup farmer → **fora da Fase 1** (Fase 2, não neste plano). ✅
