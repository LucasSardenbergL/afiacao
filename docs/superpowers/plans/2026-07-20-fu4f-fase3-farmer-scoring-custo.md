# FU4-F fase 3 — fechamento de custo no scoring do farmer

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `useFarmerScoring` para de baixar o catálogo de custo (`product_costs`, 3.637 linhas) para o browser; a margem por cliente passa a vir de uma RPC gateada que devolve **faixa**, não número.

**Architecture:** Espelha `get_preco_cockpit` (já em prod) um nível acima — de por-SKU para por-cliente. RPC `SECURITY DEFINER` lê custo internamente, classifica em `verde|amarelo|vermelho|neutro` e projeta o número só sob `private.cap_custo_ler`. O hook troca o `fetch` de custo por uma chamada `.rpc()`.

**Tech Stack:** PostgreSQL 17 (plpgsql), Supabase/PostgREST, React + TypeScript, vitest, harness bash PG17.

**Spec:** [`docs/superpowers/specs/2026-07-20-fechamento-custo-farmer-scoring-design.md`](../specs/2026-07-20-fechamento-custo-farmer-scoring-design.md)

## ⛔ DEPENDÊNCIA — ler antes de começar (revisão de 2026-07-21)

Este plano **não calcula mais a margem**. Ele consome `private.margem_cliente_agregada()`, entregue no **PR #1519** (branch `feat/margem-cliente-helper-compartilhado`).

**Por quê:** a sessão paralela do PR #1495 construiu, ao mesmo tempo, o cálculo server-side da margem (`get_customer_margin_summary()`, para popular `farmer_client_scores.gross_margin_pct`). Medidas lado a lado sobre a prod, as duas lógicas divergem em **346 de 1.215 clientes (28,5%) na FAIXA**, com delta máximo de 112,57 p.p. Duas autoridades money-path discordando no sinal que o vendedor vê. Decisão do dono (2026-07-21): **um helper compartilhado, e o FU4-F fase 3 entra depois** do #1495 absorvê-lo.

**Consequências para este plano:**

1. A Task 2 vira uma função **fina** — classifica em faixa e aplica os dois gates. O JOIN, o custo canônico e o filtro de status vivem no helper.
2. O helper **preserva o filtro de status do hook** (`'confirmado','faturado','entregue'` — dois inexistentes, 33% dos pedidos invisíveis). É deliberado: corrigir muda o score de todo cliente e é o chip **"Corrigir filtro de status do scoring do farmer"**, PR próprio com baseline. ⇒ a paridade da Task 4 continua válida.
3. O helper resolve custo por `omie_codigo_produto → product_id`, **o mesmo caminho do hook** (`src/lib/scoring/margin.ts:23-24` + `costMap` por `product_id`). A paridade fica mais forte, não mais fraca.
4. Cliente **sem custo conhecido agora VEM na resposta** com `margem_pct = NULL` (antes o INNER JOIN o descartava). O fallback `?? neutro` do hook segue necessário só para cliente **sem pedido nenhum**.

**Ordem de merge:** #1519 → #1495 → este PR. Não comece a Task 2 antes do #1519 estar mergeado ou, no mínimo, com a migration do helper aplicada em prod.

## Global Constraints

- **Idioma:** código, rotas e commits em **pt-BR**.
- **Migration de nome custom NÃO auto-aplica no Lovable** — o founder cola no SQL Editor. Toda migration sai com bloco pronto + query de validação read-only.
- **Validação pós-apply LÊ CATÁLOGO** (`pg_proc`/`pg_get_functiondef`/`has_function_privilege`) — **nunca invoca** a função (invocar exige `EXECUTE`; sob `psql-ro` dá falso-negativo).
- **`REVOKE` revoga de `PUBLIC` E por nome** (`anon`, `authenticated`) — só de `PUBLIC` é no-op no Supabase.
- **`SET search_path` com `pg_temp` por último** em toda SECDEF nova.
- **Atribuição no CORPO, nunca no `DECLARE`** — erro em inicialização de `DECLARE` não é capturável pelo `EXCEPTION` do próprio bloco.
- **Comandos pesados prefixados com `heavy`** (semáforo de RAM da M2 8GB).
- **Gate nunca com `| tail`** — engole o exit code. Use `> log 2>&1; echo $?`.
- **Logs no scratchpad da sessão**, nunca `/tmp/<nome-genérico>` (compartilhado entre ~30 worktrees).
- **Sessões paralelas ativas:** dois chips rodando tocam `useCrossSellEngine`/`useBundleEngine`/`calculate-scores`. **Não tocar nesses arquivos.** Conflito possível em `src/lib/custo/custoCanonico.ts` (compartilhado) e em timestamp de migration — conferir `origin/main` antes de commitar.

## Fatos medidos em prod (2026-07-20) — não re-derivar

| fato | valor |
|---|---|
| `farmer_client_scores.gross_margin_pct` | 0 em 6.632/6.632, sem writer |
| `product_costs` | 3.637 linhas, 3.637 com custo, policy `master OR employee` |
| universo de pedidos (3 status) | 20.095 pedidos |
| itens: jsonb × relacional | 46.653 × 46.645 — **delta 8 (0,017%)**, 0 pedidos divergentes |
| `order_items.product_id` NULL | 1.835/68.459 (2,7%) — **usar `omie_codigo_produto`, que é 100%** |
| `omie_codigo_produto` em `omie_products` | único: 7.962/7.962, 1 account por código |
| clientes com faixa real | 746 de 854 com pedido (87%); 108 → `neutro` |
| distribuição da margem | p10 24,8% · mediana 52,9% · p90 73,5% · 7 negativos |

## File Structure

| arquivo | responsabilidade |
|---|---|
| `supabase/migrations/20260724130000_authz_custo_fu4f_fase3_farmer_faixa.sql` | RPC + seeds de config + ACL |
| `db/test-authz-custo-fu4f-fase3.sql` | validação pós-apply (catálogo, roda em `psql-ro`) |
| `db/test-authz-custo-fu4f-fase3.sh` | harness PG17: prova + falsificação |
| `db/test-fu4f-fase3-paridade-margem.sh` | paridade TS×SQL (a faixa tem de bater) |
| `src/lib/scoring/faixaMargem.ts` | mapeamento faixa→`g` + tipo `FaixaMargem` (puro, testável) |
| `src/lib/scoring/__tests__/faixaMargem.test.ts` | testes do mapeamento |
| `src/hooks/useFarmerScoring.ts` | remove o fetch de custo, chama a RPC |
| `src/pages/FarmerDashboard.tsx` | exibe faixa no lugar do `%` |
| `src/integrations/supabase/types.ts` | assinatura da RPC nova (à mão, ordem alfabética) |

---

### Task 1: Helper puro do mapeamento faixa→`g`

Começa aqui porque é TS puro, sem banco, e fixa o vocabulário que todo o resto usa.

**Files:**
- Create: `src/lib/scoring/faixaMargem.ts`
- Test: `src/lib/scoring/__tests__/faixaMargem.test.ts`

**Interfaces:**
- Consumes: nada
- Produces: `type FaixaMargem = 'verde' | 'amarelo' | 'vermelho' | 'neutro'`; `gDaFaixa(faixa: FaixaMargem): number`; `FAIXA_LABEL: Record<FaixaMargem, string>`

- [ ] **Step 1: Escrever o teste que falha**

```ts
// src/lib/scoring/__tests__/faixaMargem.test.ts
import { describe, it, expect } from 'vitest';
import { gDaFaixa, FAIXA_LABEL, type FaixaMargem } from '../faixaMargem';

describe('gDaFaixa', () => {
  it('mapeia as quatro faixas para o componente G do health score', () => {
    expect(gDaFaixa('verde')).toBe(1);
    expect(gDaFaixa('amarelo')).toBe(0.5);
    expect(gDaFaixa('vermelho')).toBe(0);
  });

  // Preserva o comportamento ATUAL (cliente sem custo conhecido já recebia g≈0).
  // A fabricação está registrada como follow-up na spec §3.3 — NÃO consertar aqui.
  it('mapeia neutro para 0, preservando o comportamento anterior', () => {
    expect(gDaFaixa('neutro')).toBe(0);
  });

  it('devolve g dentro de [0,1] para toda faixa', () => {
    const faixas: FaixaMargem[] = ['verde', 'amarelo', 'vermelho', 'neutro'];
    for (const f of faixas) {
      const g = gDaFaixa(f);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
    }
  });

  it('tem rótulo para toda faixa', () => {
    const faixas: FaixaMargem[] = ['verde', 'amarelo', 'vermelho', 'neutro'];
    for (const f of faixas) {
      expect(FAIXA_LABEL[f]).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/youthful-wright-ca4cec
heavy bun run test -- src/lib/scoring/__tests__/faixaMargem.test.ts > "$SCRATCH/t1.log" 2>&1; echo "exit=$?"
```

Esperado: `exit=1`, com `Cannot find module '../faixaMargem'`. **Confirme que a contagem de testes falhados é 4** — exit≠0 sozinho não distingue "pegou" de "não rodou nada".

- [ ] **Step 3: Implementar o mínimo**

```ts
// src/lib/scoring/faixaMargem.ts

/**
 * Faixa de margem do cliente — vocabulário herdado de `get_preco_cockpit` (FU4-F).
 *
 * `neutro` NÃO é uma cor pálida: é a degradação honesta para "sem custo conhecido".
 * Sem ele, cliente sem custo seria empurrado para uma cor, fabricando sinal.
 */
export type FaixaMargem = 'verde' | 'amarelo' | 'vermelho' | 'neutro';

export const FAIXA_LABEL: Record<FaixaMargem, string> = {
  verde: 'Margem saudável',
  amarelo: 'Margem abaixo do piso',
  vermelho: 'Abaixo do custo',
  neutro: 'Sem custo conhecido',
};

/**
 * Componente G do health score a partir da faixa.
 *
 * ⚠️ `neutro → 0` preserva o comportamento ANTERIOR (o hook já dava g≈0 ao cliente sem
 * custo conhecido, via `clientMargin = 0`). É uma fabricação conhecida — ausente ≠ zero —
 * registrada como follow-up na spec §3.3. Consertá-la aqui misturaria mudança de score
 * com conserto de autorização e destruiria o baseline de paridade.
 */
export function gDaFaixa(faixa: FaixaMargem): number {
  switch (faixa) {
    case 'verde': return 1;
    case 'amarelo': return 0.5;
    case 'vermelho': return 0;
    case 'neutro': return 0;
  }
}
```

- [ ] **Step 4: Rodar e confirmar verde**

```bash
heavy bun run test -- src/lib/scoring/__tests__/faixaMargem.test.ts > "$SCRATCH/t1b.log" 2>&1; echo "exit=$?"
```

Esperado: `exit=0`, **4 testes passando**.

- [ ] **Step 5: Registrar no manifesto de módulos**

Arquivo novo em `src/` precisa de dono em `src/lib/modulos/manifesto.ts` (`codigo`/`testes`) — senão `manifesto.gate` falha **só no CI**, não no typecheck local. Abra o manifesto, ache a entrada do módulo que já possui `src/lib/scoring/` e acrescente os dois caminhos novos aos globs existentes.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scoring/faixaMargem.ts src/lib/scoring/__tests__/faixaMargem.test.ts src/lib/modulos/manifesto.ts
git commit -m "feat(scoring): helper puro de faixa de margem (vocabulário do cockpit)"
```

---

### Task 2: Migration — a RPC gateada

**Files:**
- Create: `supabase/migrations/20260724130000_authz_custo_fu4f_fase3_farmer_faixa.sql`

**Interfaces:**
- Consumes: `private.cap_custo_ler(_uid uuid) → boolean`, `private.cap_carteira_ler(_uid uuid) → boolean`, `private.carteira_visivel_para(_customer_user_id uuid, _uid uuid) → boolean` (todas SECDEF, medidas em prod)
- Produces: `public.get_carteira_margem_faixa()` → `TABLE(customer_user_id uuid, faixa text, motivo text, margem_pct numeric)`

⚠️ **O timestamp NÃO é a data de hoje — e isso é deliberado.** Os timestamps de migration deste repo estão **à frente do calendário**: em 2026-07-20 a maior na `main` era `20260724120000`. Um timestamp "de hoje" (`20260720…`) ordenaria **antes** das já aplicadas, violando a regra de que a sua ordena depois da última. Por isso `20260724130000`.

**Antes de escrever, re-confirme o máximo** (as duas sessões paralelas podem ter criado uma nova):

```bash
git fetch -q origin
git ls-tree --name-only origin/main supabase/migrations/ | command grep -oE '2026[0-9]{10}' | sort | tail -1
```

Se o retorno for ≥ `20260724130000`, escolha um timestamp maior e ajuste **todas** as referências neste plano (nome do arquivo, `git add`, os dois `psql -f` do harness da Task 3, e o corpo do PR).

- [ ] **Step 1: Escrever a migration**

```sql
-- supabase/migrations/20260724130000_authz_custo_fu4f_fase3_farmer_faixa.sql
--
-- FU4-F fase 3 — o scoring do farmer para de baixar o catálogo de custo.
--
-- Espelha `get_preco_cockpit` um nível acima (por CLIENTE, não por SKU): a função lê o custo
-- internamente e devolve a FAIXA; o número só sai sob `private.cap_custo_ler` (gate de projeção).
--
-- ⚠️ MIGRATION MANUAL: nome custom não auto-aplica no Lovable. Colar no SQL Editor → Run.
-- Validação pós-apply: db/test-authz-custo-fu4f-fase3.sql (lê catálogo, não invoca).

BEGIN;

-- ── 1. Limiares da faixa (config, não código) ────────────────────────────────
-- Semeados da distribuição REAL medida em 2026-07-20 sobre 746 clientes:
--   p10 24,8% · p25 37,7% · mediana 52,9% · p75 65,4% · p90 73,5% · 7 negativos
-- Com piso 30 / meta 50: 1% vermelho · 14% amarelo · 31% abaixo-da-meta · 54% saudável.
-- Mudar os limiares é UPDATE nesta tabela, não deploy.
INSERT INTO public.farmer_algorithm_config (key, value)
VALUES ('margem_faixa_piso_pct', '30'),
       ('margem_faixa_meta_pct', '50')
ON CONFLICT (key) DO NOTHING;

-- ── 2. A RPC ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.get_carteira_margem_faixa()
RETURNS TABLE (customer_user_id uuid, faixa text, motivo text, margem_pct numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_uid      uuid;
  v_pode_num boolean;
  v_piso     numeric;
  v_meta     numeric;
BEGIN
  -- Atribuição no CORPO: erro na inicialização de DECLARE não é capturável pelo
  -- EXCEPTION do próprio bloco e derrubaria a função inteira.
  v_uid := (SELECT auth.uid());

  -- Fail-closed: sem identidade, zero linhas.
  IF v_uid IS NULL THEN
    RETURN;
  END IF;

  v_pode_num := COALESCE(private.cap_custo_ler(v_uid), false);

  SELECT COALESCE(max(c.value::numeric) FILTER (WHERE c.key = 'margem_faixa_piso_pct'), 30),
         COALESCE(max(c.value::numeric) FILTER (WHERE c.key = 'margem_faixa_meta_pct'), 50)
    INTO v_piso, v_meta
    FROM public.farmer_algorithm_config c
   WHERE c.key IN ('margem_faixa_piso_pct', 'margem_faixa_meta_pct');

  -- O CÁLCULO não mora aqui — mora em private.margem_cliente_agregada() (PR #1519), que é
  -- também a fonte do #1495. Esta função só CLASSIFICA e aplica os dois gates. Duplicar o
  -- cálculo foi exatamente o que produziu 28,5% de divergência entre as duas frentes.
  RETURN QUERY
  SELECT m.customer_user_id,
         CASE WHEN m.margem_pct IS NULL  THEN 'neutro'
              WHEN m.margem_pct < 0      THEN 'vermelho'
              WHEN m.margem_pct < v_piso THEN 'amarelo'
              ELSE                            'verde'   END,
         CASE WHEN m.margem_pct IS NULL  THEN 'sem_custo'
              WHEN m.margem_pct < 0      THEN 'abaixo_do_custo'
              WHEN m.margem_pct < v_piso THEN 'abaixo_do_piso'
              WHEN m.margem_pct < v_meta THEN 'abaixo_da_meta'
              ELSE                            'saudavel' END,
         -- Gate de PROJEÇÃO: o cálculo usa o valor real, a SAÍDA esconde.
         -- A chave fica presente com NULL para o front tolerar.
         CASE WHEN v_pode_num THEN m.margem_pct END
    FROM private.margem_cliente_agregada() m
   -- Escopo espelhando a RLS de farmer_client_scores (policy fcs_select_carteira).
   WHERE COALESCE((SELECT private.cap_carteira_ler(v_uid)), false)
      OR COALESCE(private.carteira_visivel_para(m.customer_user_id, v_uid), false);
END;
$fn$;

-- ── 3. ACL ───────────────────────────────────────────────────────────────────
-- O objeto NASCE aberto (default privilege do Supabase concede EXECUTE a anon/
-- authenticated/service_role em toda função nova). Revogar de PUBLIC E por nome:
-- só de PUBLIC é no-op.
REVOKE ALL ON FUNCTION public.get_carteira_margem_faixa() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_carteira_margem_faixa() TO authenticated, service_role;

COMMENT ON FUNCTION public.get_carteira_margem_faixa() IS
  'FU4-F fase 3: faixa de margem por cliente da carteira. O custo é lido internamente e '
  'nunca sai; margem_pct só é projetada sob private.cap_custo_ler. Escopo espelha a RLS '
  'de farmer_client_scores.';

COMMIT;
```

- [ ] **Step 2: Conferir que o SQL é sintaticamente válido antes de qualquer coisa**

⚠️ plpgsql é **late-bound**: `CREATE` passa com SQL inválido no corpo e só falha ao EXECUTAR. Este passo só pega erro de *sintaxe*, não de referência — a prova real é a Task 3.

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/youthful-wright-ca4cec
/opt/homebrew/opt/postgresql@17/bin/psql --version   # confirma o PG17 disponível
```

- [ ] **Step 3: Commit (sem aplicar — a prova vem na Task 3)**

```bash
git add supabase/migrations/20260724130000_authz_custo_fu4f_fase3_farmer_faixa.sql
git commit -m "feat(authz): RPC get_carteira_margem_faixa — faixa por cliente, custo fechado"
```

⚠️ **NÃO peça o apply ao founder ainda.** A migration só vai para o SQL Editor depois da Task 3 verde + falsificação.

---

### Task 3: Harness PG17 — prova + falsificação

**Files:**
- Create: `db/test-authz-custo-fu4f-fase3.sh`

**Interfaces:**
- Consumes: a migration da Task 2 (aplicada REAL, não reescrita)
- Produces: exit 0 com contagem explícita de asserts

Use `db/test-authz-custo-fu4f-fase1.sh` como template estrutural (mesmo `initdb`/`pg_ctl`/`trap cleanup`/`P()`/`Pq()`, `LC_ALL=C`, `db/stubs-supabase.sql`).

- [ ] **Step 1: Escrever o harness com os asserts**

Cabeçalho e bootstrap idênticos ao `fase1.sh`, trocando `SLUG="fu4f3"` e `PORT="${PGPORT_TEST:-5463}"`. Depois dos stubs:

```bash
# ── stubs de identidade (iguais ao fase1) ────────────────────────────────────
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;

-- Default privilege do Supabase: sem isto o harness nasce FECHADO por acidente
-- e o teste de ACL dá falso-verde.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS private;

-- Capabilities controláveis por GUC, para o teste variar o perfil do caller.
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_custo', true),'')::boolean, false) $f$;
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_carteira', true),'')::boolean, false) $f$;
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS (SELECT 1 FROM public.carteira_teste ct WHERE ct.cid=_customer_user_id AND ct.dono=_uid) $f$;

-- Tabelas mínimas espelhando a PROD (tipos e nullability reais).
CREATE TABLE public.carteira_teste (cid uuid, dono uuid);
CREATE TABLE public.farmer_algorithm_config (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, omie_codigo_produto bigint UNIQUE);
CREATE TABLE public.product_costs (product_id uuid PRIMARY KEY, cost_final numeric, cost_price numeric);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, customer_user_id uuid, status text);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid, omie_codigo_produto bigint,
  product_id uuid, quantity numeric, unit_price numeric, discount numeric);
CREATE TABLE public.cliente_classificacao (user_id uuid PRIMARY KEY, excluir_da_carteira boolean);
SQL

# ── aplica a migration REAL (não uma cópia) ──────────────────────────────────
P -q -f "$REPO_ROOT/supabase/migrations/20260724130000_authz_custo_fu4f_fase3_farmer_faixa.sql"

# ── semeia ───────────────────────────────────────────────────────────────────
P -q <<'SQL'
-- vendedor A e vendedor B, cada um com 1 cliente
INSERT INTO public.carteira_teste VALUES
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-0000-0000-0000-000000000002');

INSERT INTO public.omie_products VALUES
  ('dddddddd-0000-0000-0000-000000000001', 1001),
  ('dddddddd-0000-0000-0000-000000000002', 1002),
  ('dddddddd-0000-0000-0000-000000000003', 1003);

-- SKU 1001: custo 60 → margem 40% (amarelo com piso 30? não: 40 >= 30 → verde/abaixo_da_meta)
-- SKU 1002: custo 95 → margem  5% (amarelo)
-- SKU 1003: SEM custo → cliente que só compra 1003 vira `neutro`
INSERT INTO public.product_costs VALUES
  ('dddddddd-0000-0000-0000-000000000001', 60, NULL),
  ('dddddddd-0000-0000-0000-000000000002', 95, NULL);

-- cliente 1 (do vendedor A): 1 pedido do SKU 1001 a 100 → margem 40% → verde/abaixo_da_meta
INSERT INTO public.sales_orders VALUES
  ('50000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','faturado'),
  ('50000000-0000-0000-0000-000000000002','22222222-2222-2222-2222-222222222222','faturado');
INSERT INTO public.order_items (sales_order_id, omie_codigo_produto, quantity, unit_price) VALUES
  ('50000000-0000-0000-0000-000000000001', 1001, 1, 100),
  ('50000000-0000-0000-0000-000000000002', 1002, 1, 100);
SQL

fail=0
ok()  { echo "  ✅ $1"; }
bad() { echo "  ❌ $1 — esperado [$2], veio [$3]"; fail=$((fail+1)); }
eq()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "$2" "$3"; fi; }

# Helper: roda a RPC como um caller específico.
como() { # $1=uid $2=cap_custo $3=cap_carteira $4=sql
  Pq -c "SET test.uid='$1'; SET test.cap_custo='$2'; SET test.cap_carteira='$3'; $4"
}

echo "── A. escopo de carteira ──"
eq "A1 vendedor A vê o próprio cliente" "1" \
  "$(como aaaaaaaa-0000-0000-0000-000000000001 false false \
     "SELECT count(*) FROM public.get_carteira_margem_faixa();")"

eq "A2 vendedor A NÃO vê o cliente de B" "0" \
  "$(como aaaaaaaa-0000-0000-0000-000000000001 false false \
     "SELECT count(*) FROM public.get_carteira_margem_faixa() WHERE customer_user_id='22222222-2222-2222-2222-222222222222';")"

eq "A3 gestor (cap_carteira_ler) vê os dois" "2" \
  "$(como aaaaaaaa-0000-0000-0000-000000000001 false true \
     "SELECT count(*) FROM public.get_carteira_margem_faixa();")"

eq "A4 fail-closed: sem auth.uid() devolve zero linhas" "0" \
  "$(Pq -c "SET test.uid=''; SELECT count(*) FROM public.get_carteira_margem_faixa();")"

echo "── B. gate de projeção do NÚMERO ──"
# Valor EXATO, não "diferente de": um erro de SQL não pode contar como assert com dente.
eq "B1 com cap_custo_ler, margem_pct é o valor exato" "40.0" \
  "$(como aaaaaaaa-0000-0000-0000-000000000001 true false \
     "SELECT margem_pct FROM public.get_carteira_margem_faixa();")"

eq "B2 SEM cap_custo_ler, margem_pct é NULL" "" \
  "$(como aaaaaaaa-0000-0000-0000-000000000001 false false \
     "SELECT coalesce(margem_pct::text,'') FROM public.get_carteira_margem_faixa();")"

eq "B3 a FAIXA sai mesmo sem cap_custo_ler (o sinal fica)" "verde" \
  "$(como aaaaaaaa-0000-0000-0000-000000000001 false false \
     "SELECT faixa FROM public.get_carteira_margem_faixa();")"

eq "B4 o MOTIVO sai mesmo sem cap_custo_ler" "abaixo_da_meta" \
  "$(como aaaaaaaa-0000-0000-0000-000000000001 false false \
     "SELECT motivo FROM public.get_carteira_margem_faixa();")"

echo "── C. classificação ──"
eq "C1 margem 5% cai em amarelo/abaixo_do_piso" "amarelo|abaixo_do_piso" \
  "$(como bbbbbbbb-0000-0000-0000-000000000002 false false \
     "SELECT faixa||'|'||motivo FROM public.get_carteira_margem_faixa();")"

P -q -c "INSERT INTO public.order_items (sales_order_id, omie_codigo_produto, quantity, unit_price) VALUES ('50000000-0000-0000-0000-000000000001', 1002, 1, 50);"
# cliente 1 agora: receita 150, custo 155 → margem negativa
eq "C2 margem negativa cai em vermelho/abaixo_do_custo" "vermelho|abaixo_do_custo" \
  "$(como aaaaaaaa-0000-0000-0000-000000000001 false false \
     "SELECT faixa||'|'||motivo FROM public.get_carteira_margem_faixa();")"

echo "── D. neutro e exclusão ──"
P -q <<'SQL'
INSERT INTO public.carteira_teste VALUES ('33333333-3333-3333-3333-333333333333','cccccccc-0000-0000-0000-000000000003');
INSERT INTO public.sales_orders VALUES ('50000000-0000-0000-0000-000000000003','33333333-3333-3333-3333-333333333333','faturado');
INSERT INTO public.order_items (sales_order_id, omie_codigo_produto, quantity, unit_price) VALUES
  ('50000000-0000-0000-0000-000000000003', 1003, 1, 100);   -- SKU sem custo
SQL
# Cliente que só compra SKU sem custo NÃO aparece (INNER JOIN o descarta) — o hook
# trata "sem linha" como neutro. Este assert trava esse contrato.
eq "D1 cliente só com SKU sem custo não retorna linha (=> neutro no hook)" "0" \
  "$(como cccccccc-0000-0000-0000-000000000003 false false \
     "SELECT count(*) FROM public.get_carteira_margem_faixa();")"

P -q -c "INSERT INTO public.cliente_classificacao VALUES ('11111111-1111-1111-1111-111111111111', true);"
eq "D2 cliente excluído da carteira some do resultado" "0" \
  "$(como aaaaaaaa-0000-0000-0000-000000000001 false false \
     "SELECT count(*) FROM public.get_carteira_margem_faixa();")"
P -q -c "DELETE FROM public.cliente_classificacao;"

echo "── E. ACL ──"
eq "E1 anon NÃO executa" "f" \
  "$(Pq -c "SELECT has_function_privilege('anon','public.get_carteira_margem_faixa()','EXECUTE');")"
eq "E2 authenticated executa" "t" \
  "$(Pq -c "SELECT has_function_privilege('authenticated','public.get_carteira_margem_faixa()','EXECUTE');")"
eq "E3 PUBLIC não executa" "f" \
  "$(Pq -c "SELECT has_function_privilege('public','public.get_carteira_margem_faixa()','EXECUTE');")"

echo "── F. idempotência ──"
P -q -f "$REPO_ROOT/supabase/migrations/20260724130000_authz_custo_fu4f_fase3_farmer_faixa.sql"
eq "F1 re-aplicar a migration não muda o resultado" "verde" \
  "$(como aaaaaaaa-0000-0000-0000-000000000001 false false \
     "SELECT faixa FROM public.get_carteira_margem_faixa() WHERE customer_user_id='11111111-1111-1111-1111-111111111111';")"
eq "F2 re-aplicar não duplica os seeds de config" "2" \
  "$(Pq -c "SELECT count(*) FROM public.farmer_algorithm_config WHERE key LIKE 'margem_faixa_%';")"

echo "════════════════════════════════"
if [ "$fail" -eq 0 ]; then echo "TODOS OS ASSERTS PASSARAM"; else echo "$fail ASSERT(S) VERMELHO(S)"; exit 1; fi
```

⚠️ Ao rodar pela primeira vez, se der `column reference "customer_user_id" is ambiguous`: os OUT params de `RETURNS TABLE` são visíveis como variáveis no corpo. Todo acesso já está qualificado (`so.customer_user_id`, `k.cid`) — se ainda ocorrer, adicione `#variable_conflict use_column` na primeira linha do bloco `DECLARE`.

- [ ] **Step 2: Rodar o baseline e exigir VERDE**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/youthful-wright-ca4cec
bash db/test-authz-custo-fu4f-fase3.sh > "$SCRATCH/fase3.log" 2>&1; echo "exit=$?"
grep -c "✅" "$SCRATCH/fase3.log"
```

Esperado: `exit=0` e **15 asserts verdes**. Baseline verde ANTES de falsificar é obrigatório — sem ele, um exit≠0 na falsificação pode ser o comando quebrado, não o assert com dente.

- [ ] **Step 3: Falsificação 1 — o gate de projeção**

Edite a migration trocando `CASE WHEN v_pode_num THEN round(k.pct, 1) END` por `round(k.pct, 1)`. Rode de novo.

Esperado: `exit=1` com **exatamente 1 vermelho: `B2`**. Se outro assert cair junto, a sabotagem foi mais larga do que se pretendia — reverta e refaça. **Reverta a sabotagem depois.**

- [ ] **Step 4: Falsificação 2 — o gate de escopo**

Troque o `WHERE` final por `WHERE true`. Rode.

Esperado: `exit=1` com vermelhos em **`A2`** (A passa a ver o cliente de B) e **`D2`**. **Reverta.**

- [ ] **Step 5: Falsificação 3 — o limiar da faixa**

A falsificação do **caminho do JOIN** mudou de casa: agora ela vive no harness do helper (`db/test-margem-cliente-helper-compartilhado.sh`, F1), porque o JOIN mudou de casa junto. Aqui a sabotagem certa é o limiar.

Troque `WHEN m.margem_pct < v_piso THEN 'amarelo'` por `WHEN m.margem_pct < 0 THEN 'amarelo'`. Rode.

Esperado: `exit=1` com **`C1`** vermelho (margem 5% deixa de cair em amarelo e vira verde). Prova que a faixa lê o limiar de config, e não uma constante embutida. **Reverta.**

⚠️ O harness desta task precisa **stubar** `private.margem_cliente_agregada()` — a função real vem do PR #1519 e não está no repo desta branch. O stub deve devolver `(customer_user_id, margem_pct)` controlável por seed, e o comentário tem de dizer que a fidelidade do CÁLCULO é provada lá, não aqui. Stubar o helper aqui é legítimo (esta função não o implementa); stubar o **gate** não seria.

- [ ] **Step 6: Confirmar verde após reverter as três sabotagens**

```bash
bash db/test-authz-custo-fu4f-fase3.sh > "$SCRATCH/fase3-final.log" 2>&1; echo "exit=$?"
grep -c "✅" "$SCRATCH/fase3-final.log"
git diff --stat supabase/migrations/   # tem de vir VAZIO
```

Esperado: `exit=0`, 15 verdes, e **diff vazio na migration** (todas as sabotagens revertidas).

- [ ] **Step 7: Commit**

```bash
git add db/test-authz-custo-fu4f-fase3.sh
git commit -m "test(authz): prova PG17 da RPC de faixa de margem (15 asserts + 3 falsificações)"
```

---

### Task 4: Harness de paridade TS×SQL

Prova que a RPC não muda score — o baseline da entrega.

**Files:**
- Create: `db/test-fu4f-fase3-paridade-margem.sh`

**Interfaces:**
- Consumes: `accumulateMarginFromItems` (`src/lib/scoring/margin.ts`), a RPC da Task 2
- Produces: exit 0 se **toda** faixa bate entre TS e SQL

- [ ] **Step 1: Escrever o harness**

Mesma estrutura PG17 (`SLUG="fu4f3par"`, `PORT="${PGPORT_TEST:-5464}"`), mas o cenário é: semear N clientes com margens em torno dos limiares, calcular a faixa **pelos dois caminhos** e exigir igualdade.

O lado TS roda via `bun`, lendo o mesmo seed exportado como JSON:

```bash
# Exporta o seed do PG17 no formato que o helper TS consome.
Pq -c "SELECT json_agg(row_to_json(t)) FROM (
  SELECT so.customer_user_id AS cid,
         json_agg(json_build_object(
           'omie_codigo_produto', oi.omie_codigo_produto,
           'quantity', oi.quantity,
           'unit_price', oi.unit_price)) AS items
    FROM public.sales_orders so JOIN public.order_items oi ON oi.sales_order_id=so.id
   WHERE so.status IN ('confirmado','faturado','entregue')
   GROUP BY 1) t;" > "$TMPSEED/pedidos.json"

Pq -c "SELECT json_agg(row_to_json(t)) FROM (
  SELECT op.omie_codigo_produto AS cod, op.id AS pid,
         COALESCE(NULLIF(pc.cost_final,'NaN'), NULLIF(pc.cost_price,'NaN')) AS custo
    FROM public.omie_products op JOIN public.product_costs pc ON pc.product_id=op.id
   WHERE COALESCE(NULLIF(pc.cost_final,'NaN'), NULLIF(pc.cost_price,'NaN')) > 0) t;" > "$TMPSEED/custos.json"

# Lado TS: replica exatamente o que o hook faz.
cat > "$TMPSEED/paridade.ts" <<'TS'
import { accumulateMarginFromItems } from '../../src/lib/scoring/margin';
const pedidos = JSON.parse(await Bun.file(process.argv[2]).text() || '[]');
const custos  = JSON.parse(await Bun.file(process.argv[3]).text() || '[]');
const piso = Number(process.argv[4]); const meta = Number(process.argv[5]);

const costMap = new Map<string, number>();
const omieToProductId = new Map<number, string>();
for (const c of custos) { costMap.set(c.pid, Number(c.custo)); omieToProductId.set(Number(c.cod), c.pid); }

const out: Record<string, string> = {};
for (const p of pedidos) {
  const { revenue, cost } = accumulateMarginFromItems(p.items, costMap, omieToProductId);
  if (revenue <= 0) { out[p.cid] = 'neutro'; continue; }
  const pct = (revenue - cost) / revenue * 100;
  out[p.cid] = pct < 0 ? 'vermelho' : pct < piso ? 'amarelo' : 'verde';
}
console.log(JSON.stringify(out));
TS

TS_OUT="$(bun run "$TMPSEED/paridade.ts" "$TMPSEED/pedidos.json" "$TMPSEED/custos.json" 30 50)"
SQL_OUT="$(como <gestor-uid> false true \
  "SELECT json_object_agg(customer_user_id, faixa)::text FROM public.get_carteira_margem_faixa();")"
```

Assert final:

```bash
# Compara chave a chave, com os dois lados NORMALIZADOS pelo mesmo jq.
DIFF="$(printf '%s' "$TS_OUT"  | jq -S . > "$TMPSEED/ts.json";
        printf '%s' "$SQL_OUT" | jq -S . > "$TMPSEED/sql.json";
        diff "$TMPSEED/ts.json" "$TMPSEED/sql.json" || true)"
if [ -z "$DIFF" ]; then ok "P1 TS e SQL produzem a MESMA faixa para todos os clientes";
else bad "P1 divergência TS×SQL" "(sem diferença)" "$DIFF"; fi
```

⚠️ `printf '%s'`, **nunca `echo`** — no zsh o `echo` interpreta o `\n` escapado e corrompe o JSON antes do `jq`.

- [ ] **Step 2: Semear os casos de fronteira**

Semeie clientes com margem **exatamente** em 0%, 30% e 50% (os limiares) e ±0,05 em volta. É onde o delta de 8 itens entre jsonb e relacional poderia mover uma faixa.

- [ ] **Step 3: Rodar e exigir verde**

```bash
bash db/test-fu4f-fase3-paridade-margem.sh > "$SCRATCH/par.log" 2>&1; echo "exit=$?"
```

Esperado: `exit=0`.

- [ ] **Step 4: Falsificar a paridade**

Mude o piso do lado TS para `35` (só no comando `bun run`, argumento 4). Rode.

Esperado: `exit=1` com `P1` vermelho listando os clientes que mudaram de faixa. Prova que o comparador tem dente — sem isso, um `P1` verde poderia significar "os dois lados devolveram vazio". **Reverta para 30.**

- [ ] **Step 5: Commit**

```bash
git add db/test-fu4f-fase3-paridade-margem.sh
git commit -m "test(scoring): paridade TS×SQL da faixa de margem (com falsificação)"
```

---

### Task 5: O hook para de baixar custo

**Files:**
- Modify: `src/hooks/useFarmerScoring.ts`

**Interfaces:**
- Consumes: `gDaFaixa`, `FaixaMargem` (Task 1); `get_carteira_margem_faixa()` (Task 2)
- Produces: `ClientScore.margemFaixa: FaixaMargem`, `ClientScore.margemPct: number | null` (substituem `grossMarginPct: number`)

- [ ] **Step 1: Trocar o tipo `ClientScore`**

Em `src/hooks/useFarmerScoring.ts`, na interface `ClientScore` (bloco "// Raw"), substitua:

```ts
  grossMarginPct: number;
```

por:

```ts
  /** Faixa de margem vinda da RPC gateada. O número só vem com cap_custo_ler. */
  margemFaixa: FaixaMargem;
  margemPct: number | null;
```

E acrescente ao topo do arquivo:

```ts
import { gDaFaixa, type FaixaMargem } from '@/lib/scoring/faixaMargem';
```

- [ ] **Step 2: Remover o fetch de custo**

Apague o bloco inteiro das linhas ~180-193 (comentário `// 2. Load product costs...`, o `fetchAllPages` de `product_costs`, a construção do `costMap` e o `import { custoCanonico }` se ficar órfão).

⚠️ **Não remova** o fetch de `omie_products` (linhas ~195-210): o `omieToProductId` ainda é usado por `resolveProductIdsFromItems` para o componente X (diversidade de mix).

- [ ] **Step 3: Substituir por a chamada à RPC**

No lugar do bloco removido:

```ts
      // 2. Faixa de margem por cliente — o custo é lido no SERVIDOR e não vem para cá.
      // FU4-F fase 3: a RPC devolve a faixa; `margem_pct` só é projetada sob cap_custo_ler.
      const { data: faixasData, error: faixasErr } = await supabase
        .rpc('get_carteira_margem_faixa');
      // FAIL-CLOSED (money-path): se a faixa não vier, aborta em vez de pontuar todo
      // mundo como neutro — um erro de RPC não pode virar "margem desconhecida" silenciosa.
      if (faixasErr) {
        console.warn('[useFarmerScoring] erro ao ler faixa de margem, abortando:', faixasErr.message);
        setCalculating(false);
        setLoading(false);
        return;
      }
      const faixaPorCliente = new Map<string, { faixa: FaixaMargem; pct: number | null }>();
      for (const r of faixasData ?? []) {
        faixaPorCliente.set(r.customer_user_id, {
          faixa: r.faixa as FaixaMargem,
          pct: r.margem_pct == null ? null : Number(r.margem_pct),
        });
      }
```

- [ ] **Step 4: Remover a acumulação de custo do laço de pedidos**

Nas linhas ~277-281, apague as três linhas de margem:

```ts
        const { revenue, cost } = accumulateMarginFromItems(items, costMap, omieToProductId);
        cd.totalRevenue += revenue;
        cd.totalCost += cost;
```

Remova também `totalRevenue`/`totalCost` da interface `CustomerData` e da inicialização em `customerMap.set(...)`.

⚠️ **Mantenha** o laço `for (const pid of resolveProductIdsFromItems(...)) cd.categories.add(pid);` — é o componente X.

- [ ] **Step 5: Remover o cálculo de percentis de margem**

Nas linhas ~302-311, apague `allMargins` e o `if (cd.totalRevenue > 0) allMargins.push(...)`. Apague também `p10Margin`, `p90Margin` e `marginRange` onde forem computados. Os percentis agora vivem no servidor (nos limiares de config).

- [ ] **Step 6: Trocar o cálculo de `g`**

Na linha ~350-351, substitua:

```ts
        const clientMargin = cd.totalRevenue > 0 ? (cd.totalRevenue - cd.totalCost) / cd.totalRevenue : 0;
        const g = clamp((clientMargin - p10Margin) / marginRange, 0, 1);
```

por:

```ts
        // Cliente sem linha na RPC = sem custo conhecido = neutro (o INNER JOIN o descarta).
        const mf = faixaPorCliente.get(cid) ?? { faixa: 'neutro' as FaixaMargem, pct: null };
        const g = gDaFaixa(mf.faixa);
```

- [ ] **Step 7: Trocar o campo emitido**

Na linha ~410, substitua `grossMarginPct: Math.round(clientMargin * 1000) / 10,` por:

```ts
          margemFaixa: mf.faixa,
          margemPct: mf.pct,
```

- [ ] **Step 8: Typecheck e lint**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/youthful-wright-ca4cec
heavy bun run typecheck > "$SCRATCH/tc.log" 2>&1; echo "typecheck=$?"
heavy bun run lint      > "$SCRATCH/lint.log" 2>&1; echo "lint=$?"
```

Esperado: ambos `=0`. O typecheck vai apontar `FarmerDashboard.tsx:442` (ainda usa `grossMarginPct`) — é a Task 6. Se quiser os dois verdes juntos, faça a Task 6 antes de commitar.

- [ ] **Step 9: Commit (junto com a Task 6)**

---

### Task 6: A UI exibe a faixa

**Files:**
- Modify: `src/pages/FarmerDashboard.tsx:442`

**Interfaces:**
- Consumes: `ClientScore.margemFaixa`, `ClientScore.margemPct`, `FAIXA_LABEL` (Task 1)

- [ ] **Step 1: Substituir a linha de métrica**

Em `src/pages/FarmerDashboard.tsx:442`, troque:

```tsx
          <MetricRow label="Margem bruta" value={`${client.grossMarginPct.toFixed(1)}%`} />
```

por:

```tsx
          <MetricRow
            label="Margem bruta"
            value={
              client.margemPct != null
                ? `${client.margemPct.toFixed(1)}%`
                : FAIXA_LABEL[client.margemFaixa]
            }
          />
```

E importe: `import { FAIXA_LABEL } from '@/lib/scoring/faixaMargem';`

Quem tem `cap_custo_ler` continua vendo o número; quem não tem vê o rótulo da faixa.

- [ ] **Step 2: Usar as cores de status do design system**

Se acrescentar indicador visual, use `text-status-success/warning/error` — **não** `text-emerald-600`/`text-red-600`.

- [ ] **Step 3: Rodar a stack de saúde inteira**

```bash
cd /Users/lucassardenberg/Projetos/afiacao/.claude/worktrees/youthful-wright-ca4cec
heavy bun run typecheck > "$SCRATCH/h-tc.log"   2>&1; echo "typecheck=$?"
heavy bun run test      > "$SCRATCH/h-test.log" 2>&1; echo "test=$?"
heavy bun run lint      > "$SCRATCH/h-lint.log" 2>&1; echo "lint=$?"
bunx knip               > "$SCRATCH/h-knip.log" 2>&1; echo "knip=$?"
```

Esperado: os quatro `=0`. **Espere TODOS** antes de commitar — o gate que você não esperou é o que pega a classe de erro que você não previu.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useFarmerScoring.ts src/pages/FarmerDashboard.tsx
git commit -m "feat(farmer): scoring lê faixa de margem por RPC e para de baixar product_costs"
```

---

### Task 7: Tipos, validação pós-apply e PR

**Files:**
- Modify: `src/integrations/supabase/types.ts`
- Create: `db/test-authz-custo-fu4f-fase3.sql`

- [ ] **Step 1: Acrescentar a RPC aos tipos**

`types.ts` é gerado pelo **Lovable** e só regenera quando ELE aplica a migration. Migration colada à mão **não toca os tipos** — e o primeiro PR que referenciar a RPC deixa a `main` vermelha, travando o auto-merge de todos os PRs abertos.

Em `types.ts`, no bloco `Functions:`, insira **em ordem alfabética** (convenção do gerador, para o diff ser mínimo quando o Lovable regenerar):

```ts
      get_carteira_margem_faixa: {
        Args: Record<PropertyKey, never>
        Returns: {
          customer_user_id: string
          faixa: string
          motivo: string
          margem_pct: number | null
        }[]
      }
```

- [ ] **Step 2: Escrever a validação pós-apply**

```sql
-- db/test-authz-custo-fu4f-fase3.sql
-- Validação pós-apply do FU4-F fase 3. LÊ CATÁLOGO — nunca invoca a função
-- (invocar exige EXECUTE e dá falso-negativo sob psql-ro, que é o REVOKE funcionando).
--   ~/.config/afiacao/psql-ro -f db/test-authz-custo-fu4f-fase3.sql

\echo '=== 1. a função existe e é SECURITY DEFINER STABLE ==='
SELECT p.proname, p.prosecdef AS secdef, p.provolatile AS volatilidade,
       p.proconfig AS search_path
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'get_carteira_margem_faixa';
-- Esperado: 1 linha, secdef=t, volatilidade=s, search_path={"search_path=public, pg_temp"}

\echo '=== 2. ACL: anon e PUBLIC fora; authenticated dentro ==='
SELECT has_function_privilege('anon',          'public.get_carteira_margem_faixa()','EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', 'public.get_carteira_margem_faixa()','EXECUTE') AS auth_exec,
       has_function_privilege('public',        'public.get_carteira_margem_faixa()','EXECUTE') AS public_exec;
-- Esperado: f | t | f

\echo '=== 3. o gate de projeção está no CORPO (âncora ESTRUTURAL, não substring) ==='
SELECT (pg_get_functiondef(p.oid) ~ 'cap_custo_ler\(v_uid\)')                      AS tem_gate_custo,
       (pg_get_functiondef(p.oid) ~ 'CASE WHEN v_pode_num THEN round')             AS tem_projecao,
       (pg_get_functiondef(p.oid) ~ 'carteira_visivel_para\(k\.cid, v_uid\)')      AS tem_gate_escopo,
       (pg_get_functiondef(p.oid) ~ 'omie_codigo_produto')                         AS usa_caminho_certo,
       (pg_get_functiondef(p.oid) !~ 'cu\.cod = oi\.product_id')                   AS nao_usa_atalho
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'get_carteira_margem_faixa';
-- Esperado: t | t | t | t | t

\echo '=== 4. os limiares foram semeados ==='
SELECT key, value FROM public.farmer_algorithm_config
 WHERE key IN ('margem_faixa_piso_pct','margem_faixa_meta_pct') ORDER BY key;
-- Esperado: 2 linhas — margem_faixa_meta_pct=50, margem_faixa_piso_pct=30
```

⚠️ **Teste os regexes contra a PROD antes de entregar** — validação que não casa nada é pior que nenhuma.

- [ ] **Step 3: Commit**

```bash
git add src/integrations/supabase/types.ts db/test-authz-custo-fu4f-fase3.sql
git commit -m "chore(authz): tipos da RPC de faixa + validação pós-apply do FU4-F fase 3"
```

- [ ] **Step 4: Abrir o PR em DRAFT**

```bash
git push -u origin feat/authz-fu4f-fase3-farmer-scoring-custo
gh pr create --draft --title "feat(authz): FU4-F fase 3 — scoring do farmer para de baixar o catálogo de custo [money-path]" --body-file <(cat <<'MD'
Fecha a maior via browser→custo: `useFarmerScoring` baixava `product_costs` INTEIRA
(3.637 linhas, paginada de propósito para furar a capa de 1.000) e calculava margem em memória.

**Decisão de produto (dono, 2026-07-20):** o NÚMERO de custo fecha, o SINAL fica.

## O follow-up que originou isto estava errado — e vale registrar

O enunciado apontava `farmer_client_scores.gross_margin_pct` como derivado invertível do custo.
Medido em prod: **0 em 6.632/6.632 linhas, 1 valor distinto, sem writer nenhum**. Com margem 0
para todos, não há custo a deduzir. A nota de desenho também errava ao propor `g_score` como
substituto: o `g_score` persistido é **diversidade**, não margem (841 não-zero, acompanha
`category_count`). Detalhe na spec.

## O que este PR NÃO fecha

**Faixa não é divulgação zero, é divulgação limitada.** Por cliente, a faixa agrega a cesta
inteira e não se inverte para custo unitário — o estreitamento é forte, mas não nulo.
`product_costs` continua com policy `master OR employee` e legível por outras vias
(cross-sell/bundle, no chip irmão). Este PR fecha **uma** via e não altera a tabela.

## ⚠️ Migration manual

`20260724130000_authz_custo_fu4f_fase3_farmer_faixa.sql` — nome custom **não** auto-aplica.
Colar no SQL Editor do Lovable → Run. Validar com `db/test-authz-custo-fu4f-fase3.sql`.
Ordem: **migration → Publish do frontend** (o front novo depende da RPC).

## Prova

- `db/test-authz-custo-fu4f-fase3.sh` — 15 asserts + 3 falsificações (gate de projeção, gate de escopo, caminho do JOIN)
- `db/test-fu4f-fase3-paridade-margem.sh` — paridade TS×SQL: a faixa tem de bater entre o cálculo do hook e o da RPC
MD
)
```

- [ ] **Step 5: Armar o watcher do PR**

```bash
bash scripts/pr-watch.sh <nº> &
```

Rodar com `run_in_background: true`. **Exit 6 ≠ 5**: 6 = não consegui consultar (estado DESCONHECIDO) → confirmar com `gh pr view` antes de avisar qualquer coisa.

- [ ] **Step 6: Codex adversarial antes de tirar do draft**

```bash
bash scripts/codex-async.sh challenge --model gpt-5.6-sol --effort xhigh ...
```

Rodar em background. Apresentar o parecer **CRU** + a calibração **SEPARADA** — nunca só a síntese. Não deixar o Codex abrir `supabase/schema-snapshot.sql` (estoura o contexto e trava): pôr os fatos de schema no próprio prompt.

---

## Self-Review

**Cobertura da spec:**

| seção da spec | task |
|---|---|
| §3.1 contrato da RPC | Task 2 |
| §3.1b limiar fixo configurável | Task 2 (seeds) |
| §3.2 mudança no hook | Task 5 |
| §3.3 `neutro → g=0` | Task 1 (`gDaFaixa`) + Task 5 |
| §4 paridade TS×SQL | Task 4 |
| §4 unicidade do JOIN | Task 3 (falsificação 3) + Task 7 (validação, `nao_usa_atalho`) |
| §5 prova + falsificação | Tasks 3 e 4 |
| §6 entrega (migration manual, tipos, Publish) | Task 7 |
| §7 o que não fecha | Task 7 (corpo do PR) |

**Consistência de tipos:** `FaixaMargem` (Task 1) é usado em Tasks 5 e 6; `gDaFaixa` só em Task 5; `FAIXA_LABEL` só em Task 6; a RPC devolve `customer_user_id/faixa/motivo/margem_pct` e as Tasks 5 e 7 usam exatamente esses quatro nomes.

**Risco residual conhecido:** o delta de 8 itens (0,017%) entre o jsonb que o hook lê e o `order_items` que a RPC lê. Coberto pela Task 4 (paridade com casos de fronteira nos limiares) — se mover alguma faixa, aparece lá.
