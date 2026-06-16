# Clientes não-vinculados (carona no `omie-analytics-sync`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relatório master/gestor dos clientes que existem no Omie (Oben) mas **não têm conta no app** (sem `omie_clientes` E sem `profile` por documento), pra ação comercial (convidar/criar conta).

**Architecture:** Pega carona na função `syncCustomers` do `omie-analytics-sync`, que **já enumera** a lista completa de clientes de cada conta Omie (paginado) e **já define vínculo corretamente** (acha `profile` por documento → cria vínculo em `omie_clientes`). A única coisa que falta é o ramo `else` (sem profile = não-vinculado): em vez de pular, **acumula em memória** e, no fim do run, grava um snapshot com **integridade de run** (replace atômico via RPC transacional, UI lê só o último run completo). Refresh cai no cron do analytics-sync; um botão "Atualizar" dispara um run **assíncrono** (`EdgeRuntime.waitUntil`, 202 imediato) com a UI fazendo poll do estado.

**Tech Stack:** Supabase (Postgres + RLS + Edge Functions Deno), React 18 + React Query, TypeScript, Vitest (TDD nos helpers puros).

---

## ⚠️ Atualização de rollout (2026-05-27) — pivô carona → rotina dedicada

A abordagem "carona no `syncCustomers`" foi implementada, mergeada (PR #372) e deployada — mas **no smoke de produção o run travou em `status=running` sem finalizar**: o `syncCustomers` do Oben faz ~2 queries PostgREST **por cliente** (~10k clientes) + ~6900 updates de vendedor = round-trips sequenciais demais → o edge **mata a função por timeout** antes do finalize. Isso é o risco de N+1 que o Codex e o review de qualidade já tinham sinalizado; a degradação foi honesta (a UI nunca mostrou run incompleto, ficou "não-sincronizado").

**Fix (PR seguinte):** rotina **dedicada e desacoplada** `syncNaoVinculados` que NÃO toca no linking:
- 2 leituras em massa (`fetchAllOmieClienteCodigos` + `fetchAllProfileDocs`, paginadas via `.range` p/ furar o cap de 1000 do PostgREST) → ~13 reads no total, não ~20k;
- enumera o Omie e classifica em memória via `classifyClienteForSnapshot` (helper puro TDD): não-vinculado = código ∉ set de omie_clientes **E** doc ∉ set de profiles (mesma definição correta);
- dedup → bulk insert → `finalize_nao_vinculados_snapshot` (igual). O `syncCustomers` voltou ao **original** (zero risco no money-path do linking). A action `start_nao_vinculados` chama a rotina nova.

As Tasks abaixo descrevem a versão original (carona); a migration (Task 2), os hooks/UI (Tasks 5-6) e o gate/async da action (Task 4) **seguem válidos** — só a mecânica de enumeração (Task 3) foi substituída pela rotina dedicada.

---

## Por que este plano difere do spec `2026-05-26-clientes-nao-vinculados-design.md`

O spec #360 cravou a **direção** (carona no analytics-sync; definição correta de "não-vinculado"; leitura master/gestor via `pode_ver_carteira_completa`). Este plano incorpora os ajustes de **uma consulta ao Codex** (2026-05-27, registrada no CLAUDE.md como preferência) sobre o *shape* da implementação numa função quente (zona de colisão):

1. **Edição passiva** de `syncCustomers`: só acumular no `else`, sem tocar no fluxo de upsert/update existente (minimiza regressão no caminho do linking).
2. **Finalize transacional**: 1 RPC SQL (`finalize_nao_vinculados_snapshot`) faz delete-stale + update-state atômico — não 3 chamadas PostgREST soltas (que crashariam no meio).
3. **Trigger assíncrono**: o botão "Atualizar" **não** espera o full-scan síncrono (estoura o cap de ~150s do edge + UX desonesto). Dispara `EdgeRuntime.waitUntil` e retorna 202; a UI faz poll do `state` (status `running`/`complete`/`error`).
4. **Gate server-side** do trigger: além do `authorizeCronOrStaff` (staff), valida `pode_ver_carteira_completa(uid)` (master/gestor) — não basta "staff".
5. **Validação de `account`**: v1 só aceita `vendas` (senão cai no fallback de credenciais errado em `getCredentials`).
6. **Normalização de documento** (Task 0): se `profiles.document` estiver formatado, o `.eq('document', doc_normalizado)` daria **falso não-vinculado** — exatamente o relatório enganoso que adiou o B. Verificar antes de tudo.

**Limitação conhecida (documentar, não consertar em v1):** `omie_clientes` tem `UNIQUE(user_id)` e **não guarda empresa/account** — qualquer lógica por empresa no *linking* é frágil em multiempresa. Como este plano **só lê** o linking (não altera) e escreve um snapshot **scopado por `empresa`** (derivada do `account`), v1 Oben está ok. Multiempresa fica pra depois.

---

## File Structure

**Create:**
- `src/lib/clientes-nao-vinculados/snapshot.ts` — helpers puros (`accountToEmpresa`, `normalizeDoc`, `buildNaoVinculadoRow`) + tipos.
- `src/lib/clientes-nao-vinculados/__tests__/snapshot.test.ts` — testes Vitest.
- `supabase/migrations/20260527120000_clientes_nao_vinculados.sql` — tabelas (snapshot + state) + RLS + view + RPC finalize.
- `src/hooks/useClientesNaoVinculados.ts` — leitura (view + state, poll quando running).
- `src/hooks/useRefreshClientesNaoVinculados.ts` — mutation que dispara o trigger.
- `src/pages/ClientesNaoVinculados.tsx` — relatório (lista + frescor + estados + botão Atualizar).

**Modify:**
- `supabase/functions/omie-analytics-sync/index.ts` — estende interface, espelha helpers, acumula em `syncCustomers`, finaliza, action `start_nao_vinculados`.
- `src/App.tsx` — lazy import + rota `admin/clientes-nao-vinculados`.
- `src/components/AppShell.tsx` — item de menu (Gestão, `gestorComercialOuMaster`).

---

## Task 0: Verificar normalização de `profiles.document` (gate de correção)

**Por quê primeiro:** se `profiles.document` estiver armazenado **formatado** (`12.345.678/0001-99`), a comparação do sync (`.eq('document', doc)` com `doc` = só dígitos) **nunca casa** → clientes COM conta apareceriam como "não-vinculados". É o relatório enganoso que adiou o B. O `syncCustomers` atual já faz essa comparação (linking "provado"), então a expectativa é que esteja normalizado — mas **confirme antes de construir**.

**Files:** nenhum (verificação via SQL Editor — founder roda).

- [ ] **Step 1: Entregar a query de verificação pro founder colar no SQL Editor**

🟣 Lovable → SQL Editor → cola → Run:

```sql
SELECT
  count(*) FILTER (WHERE document IS NOT NULL AND document <> '')                              AS com_doc,
  count(*) FILTER (WHERE document ~ '\D')                                                       AS com_nao_digito,
  count(*) FILTER (WHERE document IS NOT NULL AND document <> '' AND document = regexp_replace(document, '\D', '', 'g')) AS ja_normalizado,
  (array_agg(document) FILTER (WHERE document ~ '\D'))[1:5]                                      AS exemplos_formatados
FROM public.profiles;
```

- [ ] **Step 2: Interpretar o resultado e ramificar**

  - **`com_nao_digito = 0`** (todos só dígitos): ✅ premissa confirmada. O `.eq('document', doc_normalizado)` casa. Seguir o plano como está.
  - **`com_nao_digito > 0`** (há documentos formatados): ⚠️ **PARE.** O linking atual já está perdendo matches e o snapshot herdaria o erro. Antes de seguir, normalizar a base: entregar como BLOCO extra um `UPDATE public.profiles SET document = regexp_replace(document,'\D','','g') WHERE document ~ '\D';` + (recomendado) um índice `CREATE INDEX IF NOT EXISTS idx_profiles_document ON public.profiles(document);`. Registrar a decisão no PR. Só então seguir.

> Não há commit nesta task — é um gate. Anotar o resultado no corpo do PR ("Task 0: profiles.document normalizado — confirmado / corrigido via UPDATE").

---

## Task 1: Helpers puros + testes (TDD)

**Files:**
- Create: `src/lib/clientes-nao-vinculados/snapshot.ts`
- Test: `src/lib/clientes-nao-vinculados/__tests__/snapshot.test.ts`

Estes helpers são **puros** e serão **espelhados verbatim** no edge function Deno (Task 3) — o Deno não importa de `src/`, então o código é copiado. Mantê-los sem dependências.

- [ ] **Step 1: Escrever o teste que falha**

Create `src/lib/clientes-nao-vinculados/__tests__/snapshot.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { accountToEmpresa, normalizeDoc, buildNaoVinculadoRow } from '../snapshot';

describe('accountToEmpresa', () => {
  it('mapeia as 3 contas Omie pras empresas', () => {
    expect(accountToEmpresa('vendas')).toBe('oben');
    expect(accountToEmpresa('colacor_vendas')).toBe('colacor');
    expect(accountToEmpresa('servicos')).toBe('colacor_sc');
  });
});

describe('normalizeDoc', () => {
  it('remove tudo que não é dígito', () => {
    expect(normalizeDoc('12.345.678/0001-99')).toBe('12345678000199');
    expect(normalizeDoc('123.456.789-00')).toBe('12345678900');
  });
  it('trata null/undefined/vazio como string vazia', () => {
    expect(normalizeDoc(undefined)).toBe('');
    expect(normalizeDoc(null)).toBe('');
    expect(normalizeDoc('')).toBe('');
  });
});

describe('buildNaoVinculadoRow', () => {
  const ts = '2026-05-27T10:00:00.000Z';

  it('monta a linha normalizando doc e aplicando fallbacks null', () => {
    const row = buildNaoVinculadoRow(
      {
        codigo_cliente_omie: 4242,
        codigo_vendedor: 7,
        cnpj_cpf: '12.345.678/0001-99',
        razao_social: '  Marcenaria Silva LTDA  ',
        nome_fantasia: 'Móveis Silva',
        cidade: 'Curitiba',
        estado: 'PR',
      },
      'oben',
      ts,
    );
    expect(row).toEqual({
      empresa: 'oben',
      omie_codigo_cliente: 4242,
      cnpj_cpf: '12345678000199',
      razao_social: 'Marcenaria Silva LTDA',
      nome_fantasia: 'Móveis Silva',
      cidade: 'Curitiba',
      uf: 'PR',
      codigo_vendedor: 7,
      synced_at: ts,
    });
  });

  it('campos ausentes/vazios viram null (menos empresa/codigo/synced_at)', () => {
    const row = buildNaoVinculadoRow(
      { codigo_cliente_omie: 1, cnpj_cpf: '' },
      'colacor',
      ts,
    );
    expect(row.razao_social).toBeNull();
    expect(row.nome_fantasia).toBeNull();
    expect(row.cidade).toBeNull();
    expect(row.uf).toBeNull();
    expect(row.codigo_vendedor).toBeNull();
    expect(row.cnpj_cpf).toBe('');
    expect(row.empresa).toBe('colacor');
    expect(row.omie_codigo_cliente).toBe(1);
    expect(row.synced_at).toBe(ts);
  });
});
```

- [ ] **Step 2: Rodar o teste pra confirmar que falha**

Run: `heavy bun run test src/lib/clientes-nao-vinculados/`
Expected: FAIL — `Failed to resolve import "../snapshot"` (arquivo ainda não existe).

- [ ] **Step 3: Escrever a implementação mínima**

Create `src/lib/clientes-nao-vinculados/snapshot.ts`:

```ts
// Helpers puros do snapshot de clientes não-vinculados.
// ⚠️ ESPELHADOS VERBATIM no edge function `omie-analytics-sync` (Deno não importa de src/).
// Manter sem dependências externas.

export type OmieAccount = 'vendas' | 'servicos' | 'colacor_vendas';
export type Empresa = 'oben' | 'colacor' | 'colacor_sc';

export interface OmieClienteCadastroLite {
  codigo_cliente_omie?: number;
  codigo_vendedor?: number | null;
  cnpj_cpf?: string;
  razao_social?: string;
  nome_fantasia?: string;
  cidade?: string;
  estado?: string;
}

export interface NaoVinculadoRow {
  empresa: Empresa;
  omie_codigo_cliente: number;
  cnpj_cpf: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  cidade: string | null;
  uf: string | null;
  codigo_vendedor: number | null;
  synced_at: string;
}

export function accountToEmpresa(account: OmieAccount): Empresa {
  switch (account) {
    case 'vendas':
      return 'oben';
    case 'colacor_vendas':
      return 'colacor';
    case 'servicos':
      return 'colacor_sc';
  }
}

export function normalizeDoc(raw: string | undefined | null): string {
  return (raw ?? '').replace(/\D/g, '');
}

export function buildNaoVinculadoRow(
  c: OmieClienteCadastroLite,
  empresa: Empresa,
  syncedAtIso: string,
): NaoVinculadoRow {
  return {
    empresa,
    omie_codigo_cliente: c.codigo_cliente_omie ?? 0,
    cnpj_cpf: normalizeDoc(c.cnpj_cpf),
    razao_social: c.razao_social?.trim() || null,
    nome_fantasia: c.nome_fantasia?.trim() || null,
    cidade: c.cidade?.trim() || null,
    uf: c.estado?.trim() || null,
    codigo_vendedor: c.codigo_vendedor ?? null,
    synced_at: syncedAtIso,
  };
}
```

- [ ] **Step 4: Rodar o teste pra confirmar que passa**

Run: `heavy bun run test src/lib/clientes-nao-vinculados/`
Expected: PASS (3 describes, 6 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/clientes-nao-vinculados/snapshot.ts src/lib/clientes-nao-vinculados/__tests__/snapshot.test.ts
git commit -m "feat(clientes-nv): helpers puros do snapshot (accountToEmpresa, buildNaoVinculadoRow) com TDD"
```

---

## Task 2: Migration — tabelas + RLS + view + RPC finalize

**Files:**
- Create: `supabase/migrations/20260527120000_clientes_nao_vinculados.sql`

> ⚠️ **Apply manual obrigatório** (Lovable não aplica migration custom — ver CLAUDE.md §5). Entregar o BLOCO A inline no chat. Se o timestamp colidir com sessão paralela (`ls supabase/migrations/ | sort | tail`), bumpar pro próximo horário livre.

- [ ] **Step 1: Escrever a migration**

Create `supabase/migrations/20260527120000_clientes_nao_vinculados.sql`:

```sql
-- Clientes não-vinculados (carona no omie-analytics-sync).
-- Snapshot dos clientes Omie sem conta no app (sem omie_clientes E sem profile por documento).
-- Escrita: só service_role (edge). Leitura: master/gestor via pode_ver_carteira_completa.

-- 1. Snapshot
CREATE TABLE IF NOT EXISTS public.omie_clientes_nao_vinculados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  omie_codigo_cliente bigint NOT NULL,
  cnpj_cpf text,
  razao_social text,
  nome_fantasia text,
  cidade text,
  uf text,
  codigo_vendedor bigint,
  synced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_nv_run UNIQUE (empresa, omie_codigo_cliente, synced_at)
);
CREATE INDEX IF NOT EXISTS idx_nv_empresa_synced
  ON public.omie_clientes_nao_vinculados (empresa, synced_at);

-- 2. Estado do run (1 linha por empresa)
CREATE TABLE IF NOT EXISTS public.omie_nao_vinculados_state (
  empresa text PRIMARY KEY,
  status text NOT NULL DEFAULT 'idle',          -- idle | running | complete | error
  current_run_ts timestamptz,
  last_complete_synced_at timestamptz,
  total integer,
  started_at timestamptz,
  error_message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3. RLS — leitura master/gestor; escrita só service_role (bypassa RLS, sem policy IUD)
ALTER TABLE public.omie_clientes_nao_vinculados ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omie_nao_vinculados_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nv_select ON public.omie_clientes_nao_vinculados;
CREATE POLICY nv_select ON public.omie_clientes_nao_vinculados
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

DROP POLICY IF EXISTS nv_state_select ON public.omie_nao_vinculados_state;
CREATE POLICY nv_state_select ON public.omie_nao_vinculados_state
  FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

-- 4. View do último run COMPLETO (UI nunca vê run parcial)
DROP VIEW IF EXISTS public.v_clientes_nao_vinculados_atual;
CREATE VIEW public.v_clientes_nao_vinculados_atual
WITH (security_invoker = on) AS
SELECT nv.id, nv.empresa, nv.omie_codigo_cliente, nv.cnpj_cpf, nv.razao_social,
       nv.nome_fantasia, nv.cidade, nv.uf, nv.codigo_vendedor, nv.synced_at
FROM public.omie_clientes_nao_vinculados nv
JOIN public.omie_nao_vinculados_state st
  ON st.empresa = nv.empresa
 AND st.last_complete_synced_at = nv.synced_at;
GRANT SELECT ON public.v_clientes_nao_vinculados_atual TO authenticated;

-- 5. Finalize TRANSACIONAL: replace atômico do snapshot da empresa + set state complete.
--    Idempotente (re-run com mesmo run_ts é no-op). Chamado pela edge via service_role.
CREATE OR REPLACE FUNCTION public.finalize_nao_vinculados_snapshot(
  p_empresa text,
  p_run_ts timestamptz,
  p_total integer
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- remove qualquer run anterior (e parciais de runs concorrentes) desta empresa
  DELETE FROM public.omie_clientes_nao_vinculados
   WHERE empresa = p_empresa
     AND synced_at IS DISTINCT FROM p_run_ts;

  UPDATE public.omie_nao_vinculados_state
     SET status = 'complete',
         last_complete_synced_at = p_run_ts,
         total = p_total,
         error_message = NULL,
         updated_at = now()
   WHERE empresa = p_empresa;

  IF NOT FOUND THEN
    INSERT INTO public.omie_nao_vinculados_state
      (empresa, status, last_complete_synced_at, total, updated_at)
    VALUES (p_empresa, 'complete', p_run_ts, p_total, now());
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_nao_vinculados_snapshot(text, timestamptz, integer) FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_nao_vinculados_snapshot(text, timestamptz, integer) TO service_role;

SELECT 'BLOCO A OK' AS status,
  (SELECT count(*) FROM information_schema.tables
     WHERE table_schema='public'
       AND table_name IN ('omie_clientes_nao_vinculados','omie_nao_vinculados_state')) AS tabelas,
  (SELECT count(*) FROM information_schema.views
     WHERE table_schema='public' AND table_name='v_clientes_nao_vinculados_atual') AS views,
  (SELECT count(*) FROM pg_proc WHERE proname='finalize_nao_vinculados_snapshot') AS fns,
  (SELECT count(*) FROM pg_policies
     WHERE schemaname='public'
       AND tablename IN ('omie_clientes_nao_vinculados','omie_nao_vinculados_state')) AS policies;
-- esperado: tabelas=2, views=1, fns=1, policies=2
```

- [ ] **Step 2: Commit (a migration fica versionada; apply é manual no rollout)**

```bash
git add supabase/migrations/20260527120000_clientes_nao_vinculados.sql
git commit -m "feat(clientes-nv): tabelas snapshot+state, RLS master/gestor, view e RPC finalize transacional"
```

> O apply real (colar o BLOCO A no SQL Editor) acontece na Task 7 (rollout), porque o edge deployado depende das tabelas existirem.

---

## Task 3: Edge — espelhar helpers + estender interface + acumular em `syncCustomers` + finalize

**Files:**
- Modify: `supabase/functions/omie-analytics-sync/index.ts`

Mudança **passiva**: o fluxo de upsert/update do linking fica intacto. Só adicionamos (a) campos na interface, (b) helpers espelhados, (c) acumulação no `else`, (d) start/finalize do state.

- [ ] **Step 1: Estender a interface `OmieClienteCadastro`**

Em `supabase/functions/omie-analytics-sync/index.ts`, substituir o bloco da interface (linhas ~15-20):

```ts
interface OmieClienteCadastro {
  codigo_cliente_omie?: number;
  codigo_cliente_integracao?: string | null;
  codigo_vendedor?: number | null;
  cnpj_cpf?: string;
  razao_social?: string;
  nome_fantasia?: string;
  cidade?: string;
  estado?: string;
}
```

- [ ] **Step 2: Espelhar os helpers puros (verbatim do `src/lib/clientes-nao-vinculados/snapshot.ts`)**

Logo após o `const OMIE_API_URL = ...` (linha ~11), adicionar:

```ts
// ======== NÃO-VINCULADOS: helpers espelhados de src/lib/clientes-nao-vinculados/snapshot.ts ========
type Empresa = "oben" | "colacor" | "colacor_sc";

interface NaoVinculadoRow {
  empresa: Empresa;
  omie_codigo_cliente: number;
  cnpj_cpf: string;
  razao_social: string | null;
  nome_fantasia: string | null;
  cidade: string | null;
  uf: string | null;
  codigo_vendedor: number | null;
  synced_at: string;
}

function accountToEmpresa(account: OmieAccount): Empresa {
  switch (account) {
    case "vendas":
      return "oben";
    case "colacor_vendas":
      return "colacor";
    case "servicos":
      return "colacor_sc";
  }
}

function buildNaoVinculadoRow(
  c: OmieClienteCadastro,
  empresa: Empresa,
  syncedAtIso: string,
): NaoVinculadoRow {
  return {
    empresa,
    omie_codigo_cliente: c.codigo_cliente_omie ?? 0,
    cnpj_cpf: (c.cnpj_cpf ?? "").replace(/\D/g, ""),
    razao_social: c.razao_social?.trim() || null,
    nome_fantasia: c.nome_fantasia?.trim() || null,
    cidade: c.cidade?.trim() || null,
    uf: c.estado?.trim() || null,
    codigo_vendedor: c.codigo_vendedor ?? null,
    synced_at: syncedAtIso,
  };
}
```

> `OmieAccount` já está declarado (linha ~13). `accountToEmpresa` cobre os 3 casos do union sem `default`, então o TS garante exaustividade.

- [ ] **Step 3: Inicializar o run no começo de `syncCustomers`**

Em `syncCustomers` (linha ~177), logo após `await updateSyncState(db, "customers", account, { status: "running", error_message: null });`, adicionar:

```ts
  const empresa = accountToEmpresa(account);
  const runTs = new Date().toISOString();
  const naoVinculados: NaoVinculadoRow[] = [];
  await db.from("omie_nao_vinculados_state").upsert(
    {
      empresa,
      status: "running",
      current_run_ts: runTs,
      started_at: runTs,
      error_message: null,
      updated_at: runTs,
    },
    { onConflict: "empresa" },
  );
```

- [ ] **Step 4: Acumular no ramo `else` (sem profile = não-vinculado)**

Dentro do loop, o bloco `if (!mapping) { ... if (profile) { ...upsert... totalSynced++; } }` ganha um `else`. Substituir o `if (profile) { ... }` (linhas ~215-223) por:

```ts
          if (profile) {
            await db.from("omie_clientes").upsert({
              user_id: profile.user_id,
              omie_codigo_cliente: c.codigo_cliente_omie,
              omie_codigo_cliente_integracao: c.codigo_cliente_integracao || null,
              omie_codigo_vendedor: c.codigo_vendedor || null,
            }, { onConflict: "user_id" });
            totalSynced++;
          } else {
            // Sem mapping E sem profile → cliente Omie sem conta no app.
            naoVinculados.push(buildNaoVinculadoRow(c, empresa, runTs));
          }
```

- [ ] **Step 5: Bulk insert + finalize transacional no fim do `try` (após o `while`)**

Logo após `await updateSyncState(db, "customers", account, { status:"complete", ... });` (linha ~242) e ANTES do `return { totalSynced };`, inserir:

```ts
    // Snapshot de não-vinculados: dedup por código, insere em chunks com o run_ts,
    // e finaliza atômico (delete-stale + state complete). Run vazio é válido (total=0).
    const dedup = Array.from(
      new Map(naoVinculados.map((r) => [r.omie_codigo_cliente, r])).values(),
    );
    for (let i = 0; i < dedup.length; i += 1000) {
      const chunk = dedup.slice(i, i + 1000);
      const { error: insErr } = await db.from("omie_clientes_nao_vinculados").insert(chunk);
      if (insErr) throw new Error(`insert nao_vinculados: ${insErr.message}`);
    }
    const { error: finErr } = await db.rpc("finalize_nao_vinculados_snapshot", {
      p_empresa: empresa,
      p_run_ts: runTs,
      p_total: dedup.length,
    });
    if (finErr) throw new Error(`finalize nao_vinculados: ${finErr.message}`);
    console.log(`[Sync ${account}] Não-vinculados: ${dedup.length}`);
```

- [ ] **Step 6: Marcar `error` no `catch` de `syncCustomers`**

No `catch (error)` de `syncCustomers` (linha ~244), antes do `throw error;`, adicionar a marcação de erro do state (deixa o último snapshot completo intacto — só sinaliza falha):

```ts
  } catch (error) {
    await updateSyncState(db, "customers", account, { status: "error", error_message: String(error) });
    await db.from("omie_nao_vinculados_state").update({
      status: "error",
      error_message: String(error),
      updated_at: new Date().toISOString(),
    }).eq("empresa", accountToEmpresa(account));
    throw error;
  }
```

- [ ] **Step 7: `deno check` (typecheck do edge)**

Run: `cd supabase/functions && deno check omie-analytics-sync/index.ts 2>&1 | tail -20; cd -`
Expected: sem erros novos (o conjunto de erros pré-existente, se houver, fica inalterado). Se `deno` não estiver instalado localmente, pular e validar no deploy do Lovable (anotar no PR).

- [ ] **Step 8: Commit**

```bash
git add supabase/functions/omie-analytics-sync/index.ts
git commit -m "feat(clientes-nv): syncCustomers acumula não-vinculados e finaliza snapshot (carona)"
```

---

## Task 4: Edge — action `start_nao_vinculados` (async + gate master/gestor + validação + guard)

**Files:**
- Modify: `supabase/functions/omie-analytics-sync/index.ts`

- [ ] **Step 1: Adicionar o `case "start_nao_vinculados"` no `switch (action)` do handler**

No `serve(...)`, dentro do `switch (action)` (linha ~809), adicionar um case ANTES do `default:`:

```ts
      case "start_nao_vinculados": {
        // v1: só Oben.
        if (account !== "vendas") {
          return new Response(JSON.stringify({ error: "v1 suporta apenas account=vendas (Oben)" }), {
            status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // Gate master/gestor server-side (authorizeCronOrStaff só garante staff).
        // Cron/service_role são confiáveis e passam direto.
        if (auth.via === "staff") {
          const { data: pode } = await supabaseAdmin.rpc("pode_ver_carteira_completa", { _uid: auth.userId });
          if (!pode) {
            return new Response(JSON.stringify({ error: "Forbidden: requer master ou gestor comercial" }), {
              status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
        // Guard de UX "já em andamento" (correção não depende disso; é só pra não duplicar trabalho).
        const { data: st } = await supabaseAdmin
          .from("omie_nao_vinculados_state")
          .select("status, started_at")
          .eq("empresa", "oben")
          .maybeSingle();
        const running = st?.status === "running" && st?.started_at &&
          (Date.now() - new Date(st.started_at as string).getTime() < 15 * 60 * 1000);
        if (running) {
          return new Response(JSON.stringify({ accepted: false, already_running: true }), {
            status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        // Dispara o run completo (linking + snapshot) em background; responde 202 na hora.
        const bgTask = syncCustomers(supabaseAdmin, "vendas").catch((e) => {
          console.error("[nao-vinculados][async]", e instanceof Error ? e.message : e);
        });
        // @ts-ignore EdgeRuntime é global do Supabase Edge (pode não estar tipado)
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
          // @ts-ignore
          EdgeRuntime.waitUntil(bgTask);
        }
        return new Response(JSON.stringify({ accepted: true }), {
          status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
```

> `auth` está no escopo (vem de `authorizeCronOrStaff` antes do `try`). Após `if (!auth.ok) return auth.response;`, o TS estreita `auth` pra `{ ok:true; via; userId? }`, então `auth.via`/`auth.userId` são acessíveis. `pode_ver_carteira_completa` recebe `_uid` (assinatura real em prod).

- [ ] **Step 2: `deno check`**

Run: `cd supabase/functions && deno check omie-analytics-sync/index.ts 2>&1 | tail -20; cd -`
Expected: sem erros novos.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/omie-analytics-sync/index.ts
git commit -m "feat(clientes-nv): action start_nao_vinculados (async waitUntil + gate master/gestor)"
```

---

## Task 5: Front — hooks de leitura e refresh

**Files:**
- Create: `src/hooks/useClientesNaoVinculados.ts`
- Create: `src/hooks/useRefreshClientesNaoVinculados.ts`

- [ ] **Step 1: Hook de leitura (view + state, poll quando running)**

Create `src/hooks/useClientesNaoVinculados.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface ClienteNaoVinculado {
  id: string;
  omie_codigo_cliente: number;
  cnpj_cpf: string | null;
  razao_social: string | null;
  nome_fantasia: string | null;
  cidade: string | null;
  uf: string | null;
  codigo_vendedor: number | null;
}

export interface NaoVinculadosState {
  status: string; // idle | running | complete | error
  last_complete_synced_at: string | null;
  total: number | null;
  error_message: string | null;
}

export interface NaoVinculadosResult {
  lista: ClienteNaoVinculado[];
  state: NaoVinculadosState | null;
}

const EMPRESA = 'oben';

// Tabelas/views novas não estão no types.ts gerado → cast por shape mínimo (sem any).
type PgFilter = PromiseLike<{ data: unknown; error: { message: string } | null }> & {
  eq: (col: string, val: string) => PgFilter;
  order: (col: string, opts: { ascending: boolean }) => PgFilter;
  maybeSingle: () => PromiseLike<{ data: unknown; error: { message: string } | null }>;
};

export function useClientesNaoVinculados() {
  const { isMaster, isGestorComercial } = useAuth();
  const enabled = isMaster || isGestorComercial;

  return useQuery({
    queryKey: ['clientes-nao-vinculados', EMPRESA],
    enabled,
    staleTime: 60_000,
    refetchInterval: (query) => {
      const status = (query.state.data as NaoVinculadosResult | undefined)?.state?.status;
      return status === 'running' ? 4000 : false;
    },
    queryFn: async (): Promise<NaoVinculadosResult> => {
      const client = supabase as unknown as { from: (t: string) => { select: (c: string) => PgFilter } };
      const [listRes, stateRes] = await Promise.all([
        client
          .from('v_clientes_nao_vinculados_atual')
          .select('id, omie_codigo_cliente, cnpj_cpf, razao_social, nome_fantasia, cidade, uf, codigo_vendedor')
          .eq('empresa', EMPRESA)
          .order('razao_social', { ascending: true }),
        client
          .from('omie_nao_vinculados_state')
          .select('status, last_complete_synced_at, total, error_message')
          .eq('empresa', EMPRESA)
          .maybeSingle(),
      ]);
      if (listRes.error) throw new Error(listRes.error.message);
      if (stateRes.error) throw new Error(stateRes.error.message);
      return {
        lista: (listRes.data as ClienteNaoVinculado[]) ?? [],
        state: (stateRes.data as NaoVinculadosState | null) ?? null,
      };
    },
  });
}
```

- [ ] **Step 2: Hook de refresh (dispara o trigger)**

Create `src/hooks/useRefreshClientesNaoVinculados.ts`:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { track } from '@/lib/analytics';

export function useRefreshClientesNaoVinculados() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<{ accepted: boolean; already_running?: boolean }> => {
      const { data, error } = await supabase.functions.invoke('omie-analytics-sync', {
        body: { action: 'start_nao_vinculados', account: 'vendas' },
      });
      if (error) throw error;
      return data as { accepted: boolean; already_running?: boolean };
    },
    onSuccess: () => {
      track('carteira.nao_vinculados_atualizar');
      // Invalida → refetch vê status 'running' → refetchInterval faz poll até 'complete'.
      qc.invalidateQueries({ queryKey: ['clientes-nao-vinculados', 'oben'] });
    },
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `heavy bun run typecheck:strict && bunx tsc --noEmit -p tsconfig.app.json 2>&1 | tail -20`
Expected: sem erros novos.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useClientesNaoVinculados.ts src/hooks/useRefreshClientesNaoVinculados.ts
git commit -m "feat(clientes-nv): hooks de leitura (view+state, poll) e refresh (trigger async)"
```

---

## Task 6: Front — página + rota + nav

**Files:**
- Create: `src/pages/ClientesNaoVinculados.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/AppShell.tsx`

- [ ] **Step 1: Criar a página**

Create `src/pages/ClientesNaoVinculados.tsx`:

```tsx
import { RefreshCw, UserX } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useClientesNaoVinculados } from '@/hooks/useClientesNaoVinculados';
import { useRefreshClientesNaoVinculados } from '@/hooks/useRefreshClientesNaoVinculados';

function formatFrescor(iso: string | null): string {
  if (!iso) return 'nunca sincronizado';
  return `atualizado em ${new Date(iso).toLocaleString('pt-BR')}`;
}

export default function ClientesNaoVinculados() {
  const { isMaster, isGestorComercial } = useAuth();
  const podeVer = isMaster || isGestorComercial;
  const { data, isLoading } = useClientesNaoVinculados();
  const refresh = useRefreshClientesNaoVinculados();

  if (!podeVer) {
    return (
      <div className="p-4">
        <EmptyState tone="operational" title="Sem permissão" description="Esta tela é restrita a master e gestão comercial." />
      </div>
    );
  }

  if (isLoading) return <PageSkeleton variant="list" />;

  const state = data?.state ?? null;
  const lista = data?.lista ?? [];
  const running = state?.status === 'running';
  const erro = state?.status === 'error';
  const nuncaSync = !state?.last_complete_synced_at;

  return (
    <div className="p-4 space-y-4 max-w-5xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-display font-medium flex items-center gap-2">
            <UserX className="w-5 h-5 text-muted-foreground" /> Clientes não-vinculados (Oben)
          </h1>
          <p className="text-2xs text-muted-foreground mt-1">
            Clientes no Omie sem conta no app — alvos pra convidar/criar conta. {formatFrescor(state?.last_complete_synced_at ?? null)}.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => refresh.mutate()}
          disabled={running || refresh.isPending}
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${running ? 'animate-spin' : ''}`} />
          {running ? 'Atualizando…' : 'Atualizar'}
        </Button>
      </div>

      {erro && (
        <Card className="border-status-error">
          <CardHeader className="py-3">
            <p className="text-sm text-status-error">
              A última atualização falhou. O relatório abaixo é do último run completo (pode estar velho).
            </p>
            {state?.error_message && (
              <p className="text-2xs text-muted-foreground font-mono mt-1 break-all">{state.error_message}</p>
            )}
          </CardHeader>
        </Card>
      )}

      {running && (
        <Card>
          <CardHeader className="py-3">
            <p className="text-sm text-muted-foreground">
              Enumerando os clientes do Omie… isso pode levar ~1 min. A lista atualiza sozinha quando terminar.
            </p>
          </CardHeader>
        </Card>
      )}

      {nuncaSync && !running ? (
        <EmptyState
          tone="operational"
          title="Ainda não sincronizado"
          description="Clique em Atualizar pra enumerar os clientes do Omie e montar o relatório."
        />
      ) : lista.length === 0 && !running ? (
        <EmptyState
          tone="operational"
          title="Nenhum cliente não-vinculado 🎉"
          description="No último sync, todos os clientes do Omie (Oben) já têm conta no app."
        />
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <h2 className="text-base font-medium">{lista.length} clientes sem conta</h2>
          </CardHeader>
          <div className="divide-y divide-border">
            {lista.map((c) => (
              <div key={c.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {c.razao_social ?? c.nome_fantasia ?? `Cliente Omie ${c.omie_codigo_cliente}`}
                  </div>
                  <div className="text-2xs text-muted-foreground font-tabular">
                    {c.cnpj_cpf || 'sem documento'}
                    {(c.cidade || c.uf) && ` · ${[c.cidade, c.uf].filter(Boolean).join('/')}`}
                  </div>
                </div>
                {c.codigo_vendedor != null && (
                  <Badge variant="outline" className="text-2xs shrink-0">vend. {c.codigo_vendedor}</Badge>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
```

> Se `EmptyState`/`PageSkeleton`/`Badge` tiverem props diferentes, ajustar aos contratos reais (são componentes existentes — checar a assinatura antes de assumir). O default export casa com o padrão de lazy-route do `App.tsx`.

- [ ] **Step 2: Registrar a rota em `App.tsx`**

Adicionar o lazy import junto aos demais (bloco de `lazy(() => import(...))`, linhas ~16-136):

```ts
const ClientesNaoVinculados = lazy(() => import("./pages/ClientesNaoVinculados"));
```

Adicionar a `<Route>` dentro do bloco `<Route element={<ProtectedRoute><AppShellLayout /></ProtectedRoute>}>` (junto das rotas `admin/*`):

```tsx
<Route path="admin/clientes-nao-vinculados" element={<ClientesNaoVinculados />} />
```

- [ ] **Step 3: Adicionar o item de menu em `AppShell.tsx`**

Na seção **Gestão** do array de navegação, adicionar um item com a flag `gestorComercialOuMaster: true` (o filtro em `AppShell.tsx:567/577/702` já respeita `isMaster || isGestorComercial`). Importar o ícone `UserX` de `lucide-react` se ainda não estiver importado.

```tsx
{ label: 'Clientes não-vinculados', to: '/admin/clientes-nao-vinculados', icon: UserX, gestorComercialOuMaster: true },
```

> Localizar a seção exata por `grep -n "Gestão\|gestmanagement\|masterOnly" src/components/AppShell.tsx` e inserir o item no array `items` daquela seção, seguindo o shape dos itens vizinhos (alguns usam `masterOnly`; aqui é `gestorComercialOuMaster`).

- [ ] **Step 4: Typecheck + build + lint**

Run: `heavy bun run typecheck:strict && bunx tsc --noEmit -p tsconfig.app.json 2>&1 | tail -20 && heavy bun run build 2>&1 | tail -5`
Expected: typecheck sem erros novos; build sucesso.

- [ ] **Step 5: Commit**

```bash
git add src/pages/ClientesNaoVinculados.tsx src/App.tsx src/components/AppShell.tsx
git commit -m "feat(clientes-nv): página /admin/clientes-nao-vinculados + rota + item de menu (gestor/master)"
```

---

## Task 7: Validação final + PR + rollout

**Files:** nenhum novo.

- [ ] **Step 1: Suíte completa**

Run: `heavy bun run test`
Expected: tudo verde (os 6 testes novos do helper inclusos).

- [ ] **Step 2: Regenerar o audit de migrations (evita conflito recorrente)**

Run: `bun run audit:migrations`
Then: `git add docs/migrations-audit.md scripts/audit-custom-migrations.sql && git commit -m "chore: regenera audit (clientes-nv migration)" || true`

- [ ] **Step 3: Atualizar a main e abrir o PR**

```bash
git fetch origin && git merge --no-edit origin/main
heavy bun run test   # re-valida pós-merge
git push -u origin HEAD
gh pr create --title "feat(clientes-nv): relatório de clientes não-vinculados (carona no analytics-sync)" --body "$(cat <<'EOF'
## Summary
- Carona no `omie-analytics-sync` (`syncCustomers`): grava os clientes Omie sem `omie_clientes` E sem `profile` por documento num snapshot, com integridade de run (finalize transacional, UI lê só o último run completo).
- Relatório master/gestor em `/admin/clientes-nao-vinculados` + botão Atualizar (trigger assíncrono).

## ATENÇÃO: migration manual necessária
Colar `supabase/migrations/20260527120000_clientes_nao_vinculados.sql` (BLOCO A) no SQL Editor. Deploy do edge `omie-analytics-sync` via chat do Lovable (lê a main verbatim).

## Task 0 (gate de correção)
profiles.document normalizado: [confirmado / corrigido via UPDATE] — preencher.

## Test plan
- [ ] BLOCO A aplicado (tabelas=2, views=1, fns=1, policies=2)
- [ ] Edge `omie-analytics-sync` redeployado
- [ ] Front publicado; abrir /admin/clientes-nao-vinculados como master → Atualizar → status running→complete, lista popula
- [ ] Run vazio mostra "Nenhum cliente não-vinculado", não "sem dados"
EOF
)"
```

- [ ] **Step 4: Rollout coordenado (founder + Claude) — ordem importa**

  1. **BLOCO A** no SQL Editor (tabelas/RLS/view/RPC). Confirmar a validação (`tabelas=2, views=1, fns=1, policies=2`).
  2. **Deploy do edge** `omie-analytics-sync` via chat do Lovable (ler `supabase/functions/omie-analytics-sync/index.ts` da main verbatim — função grande, usar o caminho "ler do repo").
  3. **Merge do PR** (`gh pr merge --squash`) + sync/publish do front pelo Lovable.
  4. **Smoke**: como master, abrir `/admin/clientes-nao-vinculados` → "Atualizar" → ver `running` → poll → `complete` + lista. Conferir 1-2 clientes da lista no Omie (devem realmente não ter conta no app).

> O snapshot também popula no **cron** do analytics-sync (quando ele roda `sync_customers`/`sync_all` pra `vendas`) — o botão é só o atalho on-demand.

---

## Self-Review (preenchido)

- **Cobertura do spec #360:** definição correta de não-vinculado ✅ (else sem profile); carona no analytics-sync ✅; leitura master/gestor via `pode_ver_carteira_completa` ✅; snapshot table ✅; runs/cursor standalone removido ✅ (integridade via run_ts + state, sem cursor). Premissa "sob demanda" relaxada pro cron + trigger async ✅ (documentado).
- **Não-negociáveis do Codex:** finalize transacional ✅; concorrência benigna (último finalizador vence com set completo) + guard de UX ✅; trigger async honesto (sem full-scan síncrono) ✅; gate master/gestor server-side ✅; validação de account ✅; normalização de documento (Task 0) ✅; limitação `omie_clientes` documentada ✅.
- **Placeholders:** nenhum — todo código está completo.
- **Consistência de tipos:** `NaoVinculadoRow`/`accountToEmpresa`/`buildNaoVinculadoRow` batem entre `src/lib` (Task 1) e o espelho Deno (Task 3); `pode_ver_carteira_completa(_uid)` bate com prod; `start_nao_vinculados`/`account:'vendas'` batem entre edge (Task 4) e hook (Task 5); `queryKey ['clientes-nao-vinculados','oben']` bate entre leitura (Task 5) e invalidate (Task 5).
