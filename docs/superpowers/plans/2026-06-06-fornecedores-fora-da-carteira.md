# Fornecedores fora da carteira — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tirar fornecedores/transportadoras (tag do Omie) da carteira comercial — eles deixam de aparecer em sugestão de visita, lista de ligação, positivação e KPIs — de forma reversível e curada pelo founder.

**Architecture:** Captura a tag do cadastro Omie (`c.tags`) → tabela `cliente_classificacao` (por `user_id`). Uma RPC deriva `excluir_da_carteira = tem tag {Fornecedor,Transportadora} AND NOT exceção curada`. O corte usa `carteira_assignments.eligible=false` (já respeitado pela positivação, reversível) + DELETE dos scores; todos os escritores de score que não partem da carteira ganham o filtro. Rollout manual no Lovable, filtros no ar **antes** de marcar.

**Tech Stack:** Supabase (Postgres + RLS + RPC `plpgsql` + Edge Deno), React + TanStack Query, vitest (helpers puros), validação SQL local em PostgreSQL 17 (`db/test-*.sh`).

> **Spec:** [docs/superpowers/specs/2026-06-06-fornecedores-fora-da-carteira-design.md](../specs/2026-06-06-fornecedores-fora-da-carteira-design.md). **Contexto Lovable (CLAUDE.md §5):** migrations aplicadas **manualmente** no SQL Editor; edges deployadas **via chat do Lovable**; frontend via **Publish**. NENHUMA acontece no merge.

---

## File Structure

| Arquivo | Resp. | Ação |
|---|---|---|
| `src/lib/fornecedores/classificacao.ts` | regra pura de tag→exclusão (oráculo do SQL) | criar |
| `src/lib/fornecedores/__tests__/classificacao.test.ts` | testes vitest | criar |
| `supabase/migrations/20260606170000_fornecedores_classificacao_schema.sql` | 3 tabelas + RLS | criar |
| `supabase/migrations/20260606170100_fornecedores_classificacao_rpcs.sql` | RPCs classificar/reverter + trigger | criar |
| `supabase/functions/omie-analytics-sync/index.ts` | capturar `c.tags` no `syncCustomers` → `cliente_classificacao` | modificar |
| `supabase/functions/scoring-recalc-client/index.ts` | filtrar `excluir_da_carteira` antes do upsert | modificar |
| `supabase/functions/scoring-recalc-batch/index.ts` | pular flaggeds na enumeração | modificar |
| `supabase/functions/visit-score-recalc-client/index.ts` | filtrar flaggeds (single/drain) | modificar |
| `supabase/functions/visit-score-recalc-batch/index.ts` | pular sem assignment elegível | modificar |
| `supabase/functions/calculate-scores/index.ts` | seed só de `eligible` | modificar |
| `supabase/functions/carteira-rebuild/index.ts` | `eligible = NOT excluir_da_carteira` + aplicar a cada run | modificar |
| `src/hooks/useFarmerScoring.ts` | filtrar universo (`sales_orders`) antes do cálculo | modificar |
| `db/test-fornecedores-classificacao.sh` | validação PG17 das RPCs/cleanup/reversão | criar |
| `docs/superpowers/plans/_diagnostico-fornecedores.sql` | query de curadoria + blocos de cleanup | criar |

**Constante compartilhada:** `TAGS_NAO_CLIENTE = ['fornecedor','transportadora']` (comparação **case/acento-insensível**: `lower(trim(...))`). Espelhada no TS e no SQL — lição do projeto: case-mismatch morde (`'OBEN'` vs `'oben'`).

---

## Task 1: Helper puro de classificação (TDD)

**Files:**
- Create: `src/lib/fornecedores/classificacao.ts`
- Test: `src/lib/fornecedores/__tests__/classificacao.test.ts`

- [ ] **Step 1: Escrever o teste falhando**

```ts
// src/lib/fornecedores/__tests__/classificacao.test.ts
import { describe, it, expect } from 'vitest';
import { TAGS_NAO_CLIENTE, temTagNaoCliente, deveExcluirDaCarteira } from '../classificacao';

describe('temTagNaoCliente', () => {
  it('detecta Fornecedor com case/acento variável', () => {
    expect(temTagNaoCliente(['Fornecedor'])).toBe(true);
    expect(temTagNaoCliente(['FORNECEDOR'])).toBe(true);
    expect(temTagNaoCliente([' transportadora '])).toBe(true);
  });
  it('cliente comum não tem tag', () => {
    expect(temTagNaoCliente(['Cliente VIP', 'Moveleiro'])).toBe(false);
    expect(temTagNaoCliente([])).toBe(false);
    expect(temTagNaoCliente(null as unknown as string[])).toBe(false);
  });
  it('TAGS_NAO_CLIENTE é a lista canônica', () => {
    expect(TAGS_NAO_CLIENTE).toEqual(['fornecedor', 'transportadora']);
  });
});

describe('deveExcluirDaCarteira', () => {
  it('fornecedor sem exceção → exclui', () => {
    expect(deveExcluirDaCarteira({ tags: ['Fornecedor'], isExcecao: false })).toBe(true);
  });
  it('fornecedor COM exceção (cliente real) → mantém', () => {
    expect(deveExcluirDaCarteira({ tags: ['Fornecedor'], isExcecao: true })).toBe(false);
  });
  it('não-fornecedor → mantém (independe de exceção)', () => {
    expect(deveExcluirDaCarteira({ tags: ['Cliente'], isExcecao: false })).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `heavy bun run test src/lib/fornecedores` → FAIL ("Cannot find module '../classificacao'").

- [ ] **Step 3: Implementar**

```ts
// src/lib/fornecedores/classificacao.ts
/** Tags do Omie que marcam "não é cliente de venda". Comparação case/acento-insensível. */
export const TAGS_NAO_CLIENTE = ['fornecedor', 'transportadora'] as const;

export function temTagNaoCliente(tags: string[] | null | undefined): boolean {
  if (!tags) return false;
  return tags.some((t) => (TAGS_NAO_CLIENTE as readonly string[]).includes(t.trim().toLowerCase()));
}

export function deveExcluirDaCarteira(input: { tags: string[] | null | undefined; isExcecao: boolean }): boolean {
  return temTagNaoCliente(input.tags) && !input.isExcecao;
}
```

- [ ] **Step 4: Rodar e ver passar** — `heavy bun run test src/lib/fornecedores` → PASS.

- [ ] **Step 5: Commit** — `git add src/lib/fornecedores && git commit -m "feat(fornecedores): helper puro de classificação por tag (TDD)"`

---

## Task 2: Migration A — schema (3 tabelas + RLS)

**Files:** Create `supabase/migrations/20260606170000_fornecedores_classificacao_schema.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- cliente_classificacao: fonte da verdade reversível, por user_id (não por empresa — omie_clientes é mal-modelado)
CREATE TABLE IF NOT EXISTS public.cliente_classificacao (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tags_omie text[] NOT NULL DEFAULT '{}',
  is_fornecedor boolean NOT NULL DEFAULT false,
  excluir_da_carteira boolean NOT NULL DEFAULT false,
  tem_venda_real boolean NOT NULL DEFAULT false,
  tags_synced_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.cliente_classificacao ENABLE ROW LEVEL SECURITY;
-- leitura: staff; escrita: só service_role/RPC (employee NÃO mexe na flag — P1 Codex)
CREATE POLICY "staff read classificacao" ON public.cliente_classificacao
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'master') OR public.has_role(auth.uid(),'employee'));
CREATE POLICY "service_role manage classificacao" ON public.cliente_classificacao
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- fornecedor_excecao: curadoria do founder (fornecedor que É cliente real → fica)
CREATE TABLE IF NOT EXISTS public.fornecedor_excecao (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  motivo text,
  criado_por uuid,
  criado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.fornecedor_excecao ENABLE ROW LEVEL SECURITY;
CREATE POLICY "staff read excecao" ON public.fornecedor_excecao
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'master') OR public.has_role(auth.uid(),'employee'));
CREATE POLICY "master manage excecao" ON public.fornecedor_excecao
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'master')) WITH CHECK (public.has_role(auth.uid(),'master'));
CREATE POLICY "service_role manage excecao" ON public.fornecedor_excecao
  FOR ALL TO service_role USING (true) WITH CHECK (true);

SELECT 'MIGRATION A OK' AS status,
  (SELECT count(*) FROM information_schema.tables WHERE table_name IN ('cliente_classificacao','fornecedor_excecao')) AS tabelas;
```

- [ ] **Step 2: Validar em PG17** (parte do `db/test-*.sh` da Task 5) — aplica limpo, `tabelas = 2`.
- [ ] **Step 3: Commit** — `git commit -m "feat(fornecedores): migration A — schema cliente_classificacao + fornecedor_excecao + RLS"`
- [ ] **Step 4 (rollout, manual):** colar no SQL Editor do Lovable → "Success" + `tabelas = 2`.

---

## Task 3: Migration B — RPCs (classificar + reverter) + trigger de recorrência

**Files:** Create `supabase/migrations/20260606170100_fornecedores_classificacao_rpcs.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- Classifica todos os cadastros. Regra espelha o helper TS (Task 1).
CREATE OR REPLACE FUNCTION public.classificar_clientes_fornecedores()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_classificados int; v_excluidos int;
BEGIN
  UPDATE public.cliente_classificacao cc SET
    is_fornecedor = EXISTS (
      SELECT 1 FROM unnest(cc.tags_omie) t
      WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora'])
    ),
    tem_venda_real = EXISTS (
      SELECT 1 FROM public.sales_orders so
      WHERE so.customer_user_id = cc.user_id
        AND so.status NOT IN ('cancelado','rascunho','pendente')
    ),
    excluir_da_carteira = (
      EXISTS (SELECT 1 FROM unnest(cc.tags_omie) t
              WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora']))
      AND NOT EXISTS (SELECT 1 FROM public.fornecedor_excecao e WHERE e.user_id = cc.user_id)
    ),
    updated_at = now();
  GET DIAGNOSTICS v_classificados = ROW_COUNT;
  SELECT count(*) INTO v_excluidos FROM public.cliente_classificacao WHERE excluir_da_carteira;
  RETURN jsonb_build_object('classificados', v_classificados, 'excluidos', v_excluidos);
END $$;
REVOKE ALL ON FUNCTION public.classificar_clientes_fornecedores() FROM anon, authenticated;

-- Reverter (adiciona exceção + traz o cadastro de volta à carteira E aos scores — P1 reversibilidade).
CREATE OR REPLACE FUNCTION public.reverter_exclusao_fornecedor(p_user_id uuid, p_motivo text DEFAULT 'reversão manual')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(),'master')) THEN
    RAISE EXCEPTION 'apenas master pode reverter';
  END IF;
  INSERT INTO public.fornecedor_excecao (user_id, motivo, criado_por)
  VALUES (p_user_id, p_motivo, auth.uid())
  ON CONFLICT (user_id) DO NOTHING;
  UPDATE public.cliente_classificacao SET excluir_da_carteira = false, updated_at = now() WHERE user_id = p_user_id;
  UPDATE public.carteira_assignments SET eligible = true, updated_at = now() WHERE customer_user_id = p_user_id;
  -- backfill dos scores: re-enfileira AMBOS os recalcs (visit + score). A fila é a TABELA *_queue
  -- (⚠️ visit_score_recalc_pending é VIEW, não-inserível; reason é NOT NULL; índice único parcial cobre o ON CONFLICT).
  INSERT INTO public.visit_score_recalc_queue (customer_user_id, farmer_id, reason)
  SELECT customer_user_id, owner_user_id, 'reversao_fornecedor' FROM public.carteira_assignments WHERE customer_user_id = p_user_id
  ON CONFLICT DO NOTHING;
  INSERT INTO public.score_recalc_queue (customer_user_id, farmer_id, reason)
  SELECT customer_user_id, owner_user_id, 'reversao_fornecedor' FROM public.carteira_assignments WHERE customer_user_id = p_user_id
  ON CONFLICT DO NOTHING;
  RETURN jsonb_build_object('revertido', p_user_id);
END $$;
REVOKE ALL ON FUNCTION public.reverter_exclusao_fornecedor(uuid, text) FROM anon;

-- Recorrência: cadastro novo (NF de devolução futura) nasce com a classificação correta.
-- Linha nova em cliente_classificacao → re-deriva is_fornecedor/excluir (default false até o sync trazer tags).
-- A classificação real roda após cada sync (Task 4); o trigger garante consistência em insert manual.
CREATE OR REPLACE FUNCTION public.cliente_classificacao_after_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.is_fornecedor := EXISTS (SELECT 1 FROM unnest(NEW.tags_omie) t WHERE lower(trim(t)) = ANY (ARRAY['fornecedor','transportadora']));
  NEW.excluir_da_carteira := NEW.is_fornecedor AND NOT EXISTS (SELECT 1 FROM public.fornecedor_excecao e WHERE e.user_id = NEW.user_id);
  RETURN NEW;
END $$;
CREATE TRIGGER trg_cliente_classificacao_derive
  BEFORE INSERT OR UPDATE OF tags_omie ON public.cliente_classificacao
  FOR EACH ROW EXECUTE FUNCTION public.cliente_classificacao_after_write();

SELECT 'MIGRATION B OK' AS status,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('classificar_clientes_fornecedores','reverter_exclusao_fornecedor')) AS rpcs,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_cliente_classificacao_derive') AS trigger_ok;
```

> ⚠️ **Canônico = o ARQUIVO** `supabase/migrations/20260606170100_fornecedores_classificacao_rpcs.sql` (não o embed acima). O arquivo foi validado em PG17 (Task 5) e corrige 2 bugs que estavam no embed: (a) reverter escrevia na VIEW `visit_score_recalc_pending` (→ tabela `visit_score_recalc_queue` + `score_recalc_queue`, com `reason`); (b) função do trigger renomeada p/ `cliente_classificacao_derive` + `DROP TRIGGER IF EXISTS` (idempotente).

- [ ] **Step 2: Validar em PG17** (Task 5). ✅ `db/test-fornecedores-classificacao.sh` — 12 asserts PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(fornecedores): migration B — RPCs classificar/reverter + trigger de derivação"`
- [ ] **Step 4 (rollout, manual):** colar **o arquivo** `20260606170100_*.sql` no SQL Editor → "Success" + `rpcs = 2, trigger_ok = 1`.

---

## Task 4: Captura das tags no sync (edge `omie-analytics-sync`)

**Files:** Modify `supabase/functions/omie-analytics-sync/index.ts` (função `syncCustomers`, ~linhas 296-367, e o tipo `OmieListarClientesResponse`)

**Abordagem:** o `syncCustomers` JÁ enumera `ListarClientes` e resolve `userId`. Adicionar: (a) ler `c.tags` (array `[{tag}|string]`, mesmo shape do `omie-vendas-sync:536`); (b) acumular `Map<user_id, string[]>`; (c) ao fim, **upsert** em `cliente_classificacao` (`tags_omie`, `tags_synced_at`). Não tocar a lógica de `omie_clientes`. A derivação `is_fornecedor`/`excluir_da_carteira` vem do trigger (Task 3) no upsert.

- [ ] **Step 1:** No tipo do cliente, incluir `tags?: Array<{ tag?: string } | string>`.
- [ ] **Step 2:** No laço de páginas, após resolver `userId`, extrair `const tags = (c.tags || []).map(t => typeof t === 'string' ? t : (t.tag ?? '')).filter(Boolean);` e guardar `tagsByUser.set(userId, tags)`.
- [ ] **Step 3:** Após o upsert de `omie_clientes`, fazer o upsert das tags em chunks:

```ts
const nowIso = new Date().toISOString();
const tagRows = Array.from(tagsByUser.entries()).map(([user_id, tags_omie]) => ({ user_id, tags_omie, tags_synced_at: nowIso }));
for (let i = 0; i < tagRows.length; i += 500) {
  const { error } = await db.from('cliente_classificacao').upsert(tagRows.slice(i, i + 500), { onConflict: 'user_id' });
  if (error) throw new Error(`upsert cliente_classificacao: ${error.message}`);
}
```

- [ ] **Step 4: Verificação de comportamento** (não há teste unitário de edge): o sub-PR cita que o upsert é idempotente (onConflict user_id) e que carga parcial é **fail-safe** (ausência de tag = não-fornecedor = fica na carteira). Documentar no PR.
- [ ] **Step 5: Commit** — `git commit -m "feat(fornecedores): syncCustomers captura tags do Omie → cliente_classificacao"`
- [ ] **Step 6 (rollout, manual):** deploy do `omie-analytics-sync` via chat do Lovable (verbatim da main) — **só depois** das migrations A/B aplicadas.

---

## Task 5: Validação SQL local (PG17) — RPCs, cleanup, reversão, multi-linha

**Files:** Create `db/test-fornecedores-classificacao.sh` (base `db/verify-snapshot-replay.sh`)

- [ ] **Step 1:** Script PG17 que: aplica migrations A+B sobre stubs (`auth.users`, `sales_orders`, `carteira_assignments`, `visit_score_recalc_pending`), semeia cenários, e roda asserts:

```
A1  fornecedor (tag) sem exceção → classificar → excluir_da_carteira=true
A2  fornecedor COM exceção → excluir_da_carteira=false (curadoria vence)
A3  cliente comum (sem tag) → excluir_da_carteira=false
A4  tag 'FORNECEDOR' maiúscula e ' Transportadora ' → detectadas (case/trim)
A5  cleanup: eligible=false para flaggeds; eligible permanece true p/ não-flaggeds
A6  transportadora pura no cleanup → eligible=false (carteira é 1:1 por UNIQUE(customer_user_id); multi-linha por user é IMPOSSÍVEL — descoberto no PG17)
A7  reverter_exclusao_fornecedor → exceção criada, excluir=false, eligible=true, fila visit_recalc tem a linha
A8  tem_venda_real reflete sales_orders válido (informativo, NÃO altera excluir)
A9  trigger: UPDATE de tags_omie re-deriva is_fornecedor/excluir sem chamar a RPC
```

- [ ] **Step 2: Rodar** — `heavy bash db/test-fornecedores-classificacao.sh` → todos os asserts PASS.
- [ ] **Step 3: Commit** — `git commit -m "test(fornecedores): validação PG17 das RPCs/cleanup/reversão"`

---

## Task 6: Filtro nos escritores que NÃO partem da carteira

**Files:** Modify `scoring-recalc-client/index.ts`, `scoring-recalc-batch/index.ts`, `visit-score-recalc-client/index.ts`

**Abordagem:** antes do upsert de score (ou na resolução do conjunto a processar), checar `cliente_classificacao.excluir_da_carteira` e **pular** o cliente flaggeado. Padrão: pré-carregar `Set<user_id>` dos flaggeds (1 query paginada) e `if (flaggeds.has(customer_user_id)) continue;`.

- [ ] **Step 1:** `scoring-recalc-client`: na função que faz upsert em `farmer_client_scores` (~linha 277), pular se o `customer_user_id` estiver em `cliente_classificacao` com `excluir_da_carteira=true`.
- [ ] **Step 2:** `scoring-recalc-batch`: ao enumerar clientes com atividade (fallback no ator), excluir os flaggeds do conjunto.
- [ ] **Step 3:** `visit-score-recalc-client`: no single E no drain da fila, pular flaggeds.
- [ ] **Step 4: Verificação:** sub-PR documenta que um registro de contato num fornecedor NÃO recria score (era o vazamento P1).
- [ ] **Step 5: Commit** — `git commit -m "fix(fornecedores): scoring/visit recalc respeitam excluir_da_carteira (anti-ressurreição)"`
- [ ] **Step 6 (rollout):** deploy dos 3 edges via Lovable — **antes** de marcar a flag (passo 2 do rollout).

---

## Task 7: Filtro nos escritores que partem da carteira

**Files:** Modify `carteira-rebuild/index.ts`, `calculate-scores/index.ts`, `visit-score-recalc-batch/index.ts`

- [ ] **Step 1:** `carteira-rebuild`: após computar assignments, setar `eligible = NOT (customer_user_id ∈ flaggeds)` no upsert; e a cada run, `UPDATE carteira_assignments SET eligible=false WHERE customer_user_id ∈ flaggeds` (aplica mesmo a quem já estava). Pré-carregar `flaggeds` (paginado).
- [ ] **Step 2:** `calculate-scores` (auto-seed ~linha 185-226): ao enumerar `omie_clientes`/`carteira_assignments` para seed, considerar só `eligible=true` (ou excluir flaggeds).
- [ ] **Step 3:** `visit-score-recalc-batch`: ao resolver owner via `carteira_assignments`, pular quem não tem assignment **elegível**.
- [ ] **Step 4: Commit** — `git commit -m "fix(fornecedores): carteira-rebuild/calculate-scores/visit-batch respeitam eligible"`
- [ ] **Step 5 (rollout):** deploy via Lovable — junto da Task 6 (antes da flag).

---

## Task 8: Front — `useFarmerScoring` filtra o universo

**Files:** Modify `src/hooks/useFarmerScoring.ts`

- [ ] **Step 1:** Após carregar `sales_orders` e ANTES do cálculo/upsert (~linha 131 e 418), carregar os flaggeds (`select user_id from cliente_classificacao where excluir_da_carteira`) e **remover** esses `customer_user_id` do universo. (Filtra antes de calcular, não só no upsert — P1 Codex.)
- [ ] **Step 2: Verificação:** abrir `/farmer/calls` não recria score de fornecedor.
- [ ] **Step 3: Commit** — `git commit -m "fix(fornecedores): useFarmerScoring filtra fornecedores do universo"`
- [ ] **Step 4 (rollout):** **Publish** do frontend.

---

## Task 9: Diagnóstico + curadoria + cleanup (operacional, SQL Editor)

**Files:** Create `docs/superpowers/plans/_diagnostico-fornecedores.sql`

- [ ] **Step 1: Query de diagnóstico/curadoria** (founder cola, revisa, decide exceções):

```sql
-- Candidatos: tem tag Fornecedor/Transportadora E está na carteira de alguém.
SELECT cc.user_id, p.razao_social, p.name, a.city, a.state,
       cc.tags_omie, cc.tem_venda_real,
       (SELECT count(*) FROM sales_orders so WHERE so.customer_user_id = cc.user_id
          AND so.status NOT IN ('cancelado','rascunho','pendente')) AS vendas_validas,
       (SELECT max(coalesce(order_date_kpi, created_at::date)) FROM sales_orders so WHERE so.customer_user_id = cc.user_id) AS ultima_compra,
       owner.name AS vendedor
FROM cliente_classificacao cc
JOIN carteira_assignments ca ON ca.customer_user_id = cc.user_id AND ca.eligible = true
LEFT JOIN profiles p ON p.user_id = cc.user_id
LEFT JOIN profiles owner ON owner.user_id = ca.owner_user_id
LEFT JOIN addresses a ON a.user_id = cc.user_id AND a.is_default = true
WHERE cc.is_fornecedor
ORDER BY vendas_validas ASC, ultima_compra ASC NULLS FIRST;  -- prováveis fornecedor-puro primeiro; quem tem venda = "revise"
```

- [ ] **Step 2: Curadoria** (founder): para cada cliente real, `INSERT INTO fornecedor_excecao (user_id, motivo) VALUES (...);`
- [ ] **Step 3: Classificar + cleanup (sob lock, após curadoria)**:

```sql
SELECT classificar_clientes_fornecedores();  -- seta excluir_da_carteira
-- cleanup reversível:
UPDATE carteira_assignments SET eligible = false, updated_at = now()
 WHERE customer_user_id IN (SELECT user_id FROM cliente_classificacao WHERE excluir_da_carteira);
DELETE FROM customer_visit_scores WHERE customer_user_id IN (SELECT user_id FROM cliente_classificacao WHERE excluir_da_carteira);
DELETE FROM farmer_client_scores  WHERE customer_user_id IN (SELECT user_id FROM cliente_classificacao WHERE excluir_da_carteira);
```

- [ ] **Step 4: Verificação antes/depois**: contar fornecedores na carteira antes/depois; conferir que Caxias do Sul esvaziou; reverter 1 caso de teste com `reverter_exclusao_fornecedor()` e confirmar volta.
- [ ] **Step 5: Commit** — `git commit -m "docs(fornecedores): diagnóstico + curadoria + cleanup SQL"`

---

## ROLLOUT (ordem manual no Lovable — filtros ANTES da flag)

1. **Migrations A + B** no SQL Editor (Tasks 2, 3). Flags nascem `false` (no-op).
2. **Deploy** dos consumidores COM filtro (Tasks 6, 7) — enquanto tudo é `false` (zero efeito).
3. **Deploy + rodar** o `omie-analytics-sync` (Task 4) → popula `cliente_classificacao.tags_omie`.
4. **Diagnóstico** (Task 9 Step 1) → founder cura exceções (Step 2).
5. **Classificar + cleanup** (Task 9 Step 3) — sob lock, após curadoria.
6. **Publish** do front (Task 8) + **verificação** (Step 4).

---

## Self-Review

- **Spec coverage:** §4.1→T2; §4.2→T4; §4.3→T3; §4.4→T6/T7/T8; §4.5→T9; §4.6→T3 (reverter); §4.7→T9; §6 rollout→seção ROLLOUT; §8 RLS→T2; §10 testes→T1/T5. ✅
- **Placeholders:** as RPCs e o helper têm código real; os edges descrevem o filtro exato + arquivo/região (o subagente lê o arquivo pro diff). `tem_venda_real` não distingue devolução na v1 (informativo) — registrado.
- **Type consistency:** `excluir_da_carteira`/`is_fornecedor`/`tags_omie`/`tem_venda_real` idênticos em TS, SQL e queries. `TAGS_NAO_CLIENTE` = `['fornecedor','transportadora']` em TS e SQL (lower).
- **Risco aberto p/ a execução:** confirmar em prod (diagnóstico) que `ListarClientes` realmente retorna `tags` populadas (o app lê na busca pontual; o batch pode diferir) — se vier vazio, a captura é no-op e o sinal precisa de outra rota. **Validar com 1 cadastro conhecido (JAMEF) antes do cleanup.**
