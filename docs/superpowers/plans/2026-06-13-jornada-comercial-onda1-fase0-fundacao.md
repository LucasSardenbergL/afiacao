# Onda 1 / Fase 0 — Idempotência do pedido de venda (zero duplicado no Omie) — Implementation Plan (v3 — 2 rounds de Codex incorporados)

> **v3 (decisão "proporcional" do founder):** round 1 do Codex (9 P1) reescreveu o desenho de v1→v2 (lean: chave determinística + reconciliação). Round 2 (7 P1) endureceu o v2→v3: `codigo_pedido` positivo antes de 'enviado' (T5), write-back exige 1 linha (T5), `checkout_id` amarrado por impressão digital (T7), `items:Json` + `allConfirmed` em todo return (T1/T6). Concorrência cross-aba (P1-4/P1-5) e afiação-OS (P1-6) ficaram como **residuais conscientes** (ver "Riscos residuais"), não bloqueadores — mitigados pelo guard `submitting` + chaves determinísticas + aviso honesto.

> **🔴 v4 — CORREÇÃO DE ROLLOUT (descoberta ao aplicar a migração em prod):** o `CREATE UNIQUE INDEX sales_orders_account_omiepedido_uq` **FALHOU** (`(oben, 12083739866)` já duplicado em prod). Causa: o app grava `omie_pedido_id` em **DUAS linhas por pedido por design** — o ENVIO (push, `ensureSalesOrderRow`) cria uma linha (`hash_payload` NULL) e o SYNC DE ENTRADA (`omie-vendas-sync sync_pedidos`) puxa o mesmo pedido e insere outra (dedup do sync é por `hash_payload='omie_<account>_<codigo>'`, NÃO por `omie_pedido_id`). O índice único é **arquiteturalmente incompatível** (falha + quebraria o sync de entrada). **A idempotência da Fase 0 NÃO depende dele** (núcleo = `UNIQUE(checkout_id, account)` + chave determinística `PV_<id>` + dedup do Omie; o retry acha a linha EMPURRADA pelo `checkout_id` → skip; a linha PUXADA `checkout_id`=NULL não interfere). **Correção aplicada:** índice removido da migração, do teste PG17 (agora prova que push+pull duplicado É permitido) e o ramo morto de 23505 no write-back do edge foi simplificado. **Re-unificar push×pull numa linha só** (o pull casar por `omie_pedido_id` e ATUALIZAR a linha empurrada) é trabalho de data-model de fase futura, fora do escopo da idempotência do ENVIO. Objetivo real ("zero pedido duplicado **no Omie**") segue cumprido.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o envio de pedido de venda **idempotente ponta-a-ponta** — re-enviar o mesmo pedido (retry, duplo-clique, refresh) **nunca** cria um 2º pedido no Omie — sem depender de timing nem de comportamento não-verificado.

**Architecture (desenho LEAN, escolhido pelo founder):** dedup em duas camadas. (1) **Client**: um `checkout_id` **durável** por tentativa de envio + `UNIQUE(checkout_id, account)` + `ensureSalesOrderRow` (insert-or-get) → o `sales_order_id` é **reusado** no retry. (2) **Edge**: chave de integração **determinística** `PV_<sales_order_id>` → re-enviar produz a mesma chave → o **Omie rejeita a duplicata** e o edge **reconcilia** (consulta + vincula) em vez de falhar. A reconciliação é **obrigatória** (não opcional). O sinal de "já enviado" é **`omie_pedido_id IS NOT NULL`** (nunca o `status`, que o sync de entrada muda pra `faturado`/`separacao`). O reset do `checkout_id`/carrinho só acontece em **sucesso TOTAL**.

> 🔴 **PREMISSA QUE GOVERNA O DESENHO (verificar — Task 8):** o Omie **rejeita `codigo_pedido_integracao` duplicado em `IncluirPedido` (pedido de venda)**. Já é **fato provado no pedido de COMPRA** (PR #628 trata "já cadastrado" como reconciliação) — mesma família de campo. **Se a verificação mostrar que o Omie de VENDA NÃO rejeita duplicata**, este desenho lean é insuficiente para concorrência real → escalar para **claim atômico no servidor** (`rascunho→enviando` com TTL, padrão do `envio_portal_claim_ids` #592). A verificação é **gate** do rollout.

**Tech Stack:** React 18 + TS (strict) + Vite · Supabase (Postgres + Edge Functions Deno) · Omie · vitest · PostgreSQL 17 local (`db/`). Migração + deploy de edge + Publish = **manuais via Lovable** (CLAUDE.md §5).

> **Refoco vs v1 (decisão pós-Codex):** a Fase 0 agora é **só idempotência**. As colunas `origem`/`atendimento_id` entram na migração (baratas, forward-looking) mas **quem as ESCREVE é a Fase 1** (a ponte grava `origem='ligacao_sainte'` + `atendimento_id`). O **`currentParty` no `WebRTCCallContext` MOVEU para a Fase 1** (é lá que é consumido pela ponte/HUD; e tem uma corrida de resolução-async a tratar — registrado pra Fase 1).

> **Correção de premissa da v1:** `inventory_position` **já é staff-gated** (não `USING(true)`) → a RPC de CMC segue **adiada p/ Fase 2**.

---

## O que o passe adversário do Codex mudou (rastreabilidade)

| Achado Codex | Onde estava | Correção nesta v2 |
|---|---|---|
| **P1-1** dedup dependia de "Omie rejeita chave duplicada" (não-documentado p/ venda) | premissa | **Task 8 verifica** (gate); precedente de compra (#628) sustenta o lean; senão escala p/ claim server-side |
| **P1-2** reset do `checkout_id`/carrinho em sucesso PARCIAL duplica | Task 5/caller | **`allConfirmed`**: só reseta/limpa em sucesso TOTAL (Task 7) |
| **P1-3** `checkout_id` em `useRef` morre no refresh / não roda na troca de cliente | caller | **durável** (localStorage) + reseta em troca de cliente e sucesso total (Task 7) |
| **P1-5** write-back do edge ignora erro → linha órfã `rascunho` c/ pedido no Omie | edge | **checa o erro do write-back**; reconciliação **obrigatória** (Task 5) |
| **P1-6** "já enviado" = `status='enviado'` perde `faturado`/`separacao` → reenvia | Task 2 | predicado = **`omie_pedido_id IS NOT NULL`** (Task 2) |
| **P1-8** OP duplica/omite | edge | chave da OP **determinística** (Task 5) + janela de omissão registrada |
| **P1-9** `types.ts` não tem as colunas novas → não compila | Task 1 | **atualizar `types.ts`** na migração (Task 1) |
| **P2** detector lê `result.faultstring`, mas `callOmieVendasApi` **lança** | Task 7 | detector lê **`Error.message`** (Task 4) |
| **P2** corrida do `currentParty` | (era Task 8) | **movido p/ Fase 1** com guard de geração |
| Omie confirmado (Codex/docs) | — | `codigo_pedido_integracao`=60ch (`PV_<uuid>`=39 cabe ✅) · `ConsultarPedido` aceita `codigo_pedido_integracao` ✅ · troca de chave não quebra edição (usa id numérico) ✅ |

---

## File Structure

| Arquivo | Papel | Tarefa |
|---|---|---|
| `supabase/migrations/20260613120000_onda1_fase0_sales_orders_identidade.sql` | **Criar** — colunas + `UNIQUE(checkout_id,account)` + `UNIQUE(account,omie_pedido_id)` parciais | T1 |
| `src/integrations/supabase/types.ts` | **Modificar** — add `checkout_id`/`origem`/`atendimento_id` no Row/Insert/Update de `sales_orders` | T1 |
| `db/test-fase0-sales-orders-identity.sh` | **Criar** — PG17 (colunas, índices, semântica) | T1 |
| `src/services/orderSubmission/idempotency.ts` | **Criar** — `decideSalesOrderAction` (puro) + `ensureSalesOrderRow` (I/O) | T2, T3 |
| `src/services/orderSubmission/__tests__/idempotency.test.ts` | **Criar** — testes | T2, T3 |
| `src/lib/omie/pedido-integration-code.ts` + `pedido-duplicate.ts` | **Criar** — helpers puros (espelhados no edge) | T4 |
| `src/lib/omie/__tests__/*.test.ts` | **Criar** — testes | T4 |
| `supabase/functions/omie-vendas-sync/index.ts` | **Modificar** — chave determinística + write-back checado + reconciliação + chave OP determinística | T5 |
| `src/services/orderSubmission/types.ts` + `submitOrder.ts` | **Modificar** — `checkoutId` param + `ensureSalesOrderRow` + `allConfirmed` | T6 |
| `src/hooks/useUnifiedOrder.ts` | **Modificar** — `checkout_id` durável + reset só em sucesso total | T7 |
| (operacional) | **Rollout** — verificar dedup Omie (gate) + deploy coordenado | T8 |

---

## Task 1: Migração + tipos gerados

**Files:**
- Create: `supabase/migrations/20260613120000_onda1_fase0_sales_orders_identidade.sql`
- Modify: `src/integrations/supabase/types.ts`
- Create: `db/test-fase0-sales-orders-identity.sh`

**Contexto:** `sales_orders` não tem `checkout_id`/`origem`/`atendimento_id` e não tem UNIQUE (snapshot `:5465-5487`). Tem `omie_pedido_id bigint` (sinal de "enviado"). O `types.ts` gerado **também não tem** as colunas (`:9061`) → sem atualizar, `.eq('checkout_id', …)`/`.insert({checkout_id})` **não compilam** (P1-9).

- [ ] **Step 1: Escrever a migração**

Criar `supabase/migrations/20260613120000_onda1_fase0_sales_orders_identidade.sql`:

```sql
-- Onda 1 / Fase 0 — Idempotência do pedido de venda.
-- checkout_id: chave de idempotência por TENTATIVA de envio (estável entre retries).
-- origem / atendimento_id: plumbing forward-looking (a FASE 1 os escreve; nulos aqui).
-- ⚠️ MONEY-PATH: aplicar via SQL Editor do Lovable; validar com a query no fim.

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS checkout_id uuid,
  ADD COLUMN IF NOT EXISTS origem text,
  ADD COLUMN IF NOT EXISTS atendimento_id uuid;

-- (1) Idempotência por tentativa: impede 2 linhas para o mesmo (checkout_id, account).
--     PARCIAL → linhas legadas (checkout_id nulo) não colidem nem são afetadas.
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_checkout_account_uq
  ON public.sales_orders (checkout_id, account)
  WHERE checkout_id IS NOT NULL;

-- (2) Âncora de reconciliação: 1 pedido Omie só pode estar vinculado a 1 linha por conta.
--     Suporta a reconciliação (Task 5) e protege contra dupla-vinculação.
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_account_omiepedido_uq
  ON public.sales_orders (account, omie_pedido_id)
  WHERE omie_pedido_id IS NOT NULL;

-- (3) Métrica "conversão por origem" (Fase 1+), sem seq-scan.
CREATE INDEX IF NOT EXISTS idx_sales_orders_origem
  ON public.sales_orders (origem)
  WHERE origem IS NOT NULL;
```

- [ ] **Step 2: Atualizar os tipos gerados**

Em `src/integrations/supabase/types.ts`, no bloco `sales_orders`, adicionar as 3 colunas em **`Row`**, **`Insert`** e **`Update`** (Row: tipos concretos; Insert/Update: opcionais):

```ts
// Em Row:
        checkout_id: string | null
        origem: string | null
        atendimento_id: string | null
// Em Insert:
        checkout_id?: string | null
        origem?: string | null
        atendimento_id?: string | null
// Em Update:
        checkout_id?: string | null
        origem?: string | null
        atendimento_id?: string | null
```

> ⚠️ O `types.ts` é gerado pelo Lovable. Editar **só** o bloco `sales_orders` (não re-adicionar tabelas inteiras — CLAUDE.md alerta sobre `Duplicate identifier`). Na próxima regeneração do Lovable isso é sobrescrito (idempotente — as colunas vêm iguais).

- [ ] **Step 3: Escrever o teste PG17**

Criar `db/test-fase0-sales-orders-identity.sh` (molde de `db/verify-snapshot-replay.sh`):

```bash
#!/usr/bin/env bash
# Onda1/Fase0 — valida a migração de idempotência de sales_orders num PG17 local.
# Prova: (a) as 3 colunas + os 3 índices; (b) UNIQUE(checkout_id,account) parcial bloqueia
# duplicata na MESMA conta, permite contas distintas, ignora checkout_id NULO; (c)
# UNIQUE(account,omie_pedido_id) parcial bloqueia dupla-vinculação. Base: verify-snapshot-replay.sh.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17; PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"; PORT=5434
DATA="$(mktemp -d /tmp/pgtest-fase0.XXXXXX)/data"; export LC_ALL=C LANG=C
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"; cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-fase0.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres fase0_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d fase0_verify "$@"; }
RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" | grep -vE '^\\(un)?restrict ' > "$RR"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613120000_onda1_fase0_sales_orders_identidade.sql"
echo "── asserts ──"
P -v ON_ERROR_STOP=1 -tA <<'SQL'
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_orders'
    AND column_name IN ('checkout_id','origem','atendimento_id'))=3, 'faltam colunas';
  ASSERT (SELECT count(*) FROM pg_indexes WHERE indexname='sales_orders_checkout_account_uq')=1, 'falta uq checkout';
  ASSERT (SELECT count(*) FROM pg_indexes WHERE indexname='sales_orders_account_omiepedido_uq')=1, 'falta uq omie';
  ASSERT (SELECT count(*) FROM pg_indexes WHERE indexname='idx_sales_orders_origem')=1, 'falta idx origem';
  RAISE NOTICE 'OK colunas+indices';
END $$;
SQL
P -v ON_ERROR_STOP=1 -tA <<'SQL'
SET session_replication_role = replica;  -- desliga FK/trigger p/ semear; unique segue enforçado
DO $$
DECLARE ck uuid := gen_random_uuid();
BEGIN
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, checkout_id)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 0,0,'rascunho','oben', ck);
  BEGIN
    INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, checkout_id)
      VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 0,0,'rascunho','oben', ck);
    RAISE EXCEPTION 'FALHA: 2a (checkout,oben) deveria violar';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, checkout_id)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 0,0,'rascunho','colacor', ck);  -- conta diferente ok
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account) VALUES
    (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb,0,0,'rascunho','oben'),
    (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb,0,0,'rascunho','oben');  -- 2 com checkout nulo ok
  -- âncora omie_pedido_id: 2 linhas oben com o MESMO omie_pedido_id deve violar
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, omie_pedido_id)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb,0,0,'enviado','oben', 999001);
  BEGIN
    INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, omie_pedido_id)
      VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb,0,0,'enviado','oben', 999001);
    RAISE EXCEPTION 'FALHA: 2a (oben,999001) deveria violar';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  RAISE NOTICE 'OK semantica dos uniques parciais';
END $$;
SQL
echo "FASE0 MIGRATION OK"
```

- [ ] **Step 4: Rodar o teste**

```bash
chmod +x db/test-fase0-sales-orders-identity.sh
bash db/test-fase0-sales-orders-identity.sh
```
Esperado: `OK colunas+indices`, `OK semantica dos uniques parciais`, `FASE0 MIGRATION OK`.

- [ ] **Step 5: Typecheck (os tipos novos não quebram nada) + commit**

```bash
bun run typecheck
git add supabase/migrations/20260613120000_onda1_fase0_sales_orders_identidade.sql src/integrations/supabase/types.ts db/test-fase0-sales-orders-identity.sh
git commit -m "feat(onda1/fase0): migração idempotência sales_orders (checkout_id + uniques parciais) + types"
```

---

## Task 2: `decideSalesOrderAction` (predicado por `omie_pedido_id`)

**Files:**
- Create: `src/services/orderSubmission/idempotency.ts`
- Test: `src/services/orderSubmission/__tests__/idempotency.test.ts`

**Contexto (P1-6):** o sinal de "já no Omie" é **`omie_pedido_id`**, NÃO o `status` — o sync de entrada muda `status` para `faturado`/`separacao`/`importado` (`omie-vendas-sync:1018`), então um pedido faturado com `status≠'enviado'` cairia em "reusar" e seria **reenviado**.

- [ ] **Step 1: Teste que falha**

Criar `src/services/orderSubmission/__tests__/idempotency.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decideSalesOrderAction } from '../idempotency';

describe('decideSalesOrderAction', () => {
  it('linha inexistente → insert', () => {
    expect(decideSalesOrderAction(null)).toBe('insert');
  });
  it('já tem omie_pedido_id → skip (no Omie; não reenviar)', () => {
    expect(decideSalesOrderAction({ omie_pedido_id: 12345 })).toBe('skip');
  });
  it('omie_pedido_id null → reuse (rascunho de tentativa que não chegou no Omie)', () => {
    expect(decideSalesOrderAction({ omie_pedido_id: null })).toBe('reuse');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun run test -- src/services/orderSubmission/__tests__/idempotency.test.ts
```
Esperado: FALHA (módulo não existe).

- [ ] **Step 3: Implementar**

Criar `src/services/orderSubmission/idempotency.ts`:

```ts
import type { SubmitClient } from './types';
import type { Json } from '@/integrations/supabase/types';

export type SalesOrderAction = 'insert' | 'reuse' | 'skip';

/**
 * Decide o que fazer com a linha de sales_orders de um (checkout_id, account).
 * O sinal de "já no Omie" é omie_pedido_id (NÃO o status — o sync de entrada muda
 * o status p/ faturado/separacao/importado após o envio; usar status reenviaria).
 *  - null                → 'insert'
 *  - omie_pedido_id != null → 'skip'  (idempotência: já está no Omie)
 *  - omie_pedido_id null    → 'reuse' (tentativa anterior não chegou no Omie)
 */
export function decideSalesOrderAction(
  existing: { omie_pedido_id: number | null } | null,
): SalesOrderAction {
  if (!existing) return 'insert';
  if (existing.omie_pedido_id != null) return 'skip';
  return 'reuse';
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
bun run test -- src/services/orderSubmission/__tests__/idempotency.test.ts
```
Esperado: PASS (3 testes).

- [ ] **Step 5: Commit**

```bash
git add src/services/orderSubmission/idempotency.ts src/services/orderSubmission/__tests__/idempotency.test.ts
git commit -m "feat(onda1/fase0): decideSalesOrderAction (predicado por omie_pedido_id)"
```

---

## Task 3: `ensureSalesOrderRow` (insert-or-get idempotente)

**Files:**
- Modify: `src/services/orderSubmission/idempotency.ts`
- Modify: `src/services/orderSubmission/__tests__/idempotency.test.ts`

**Contexto:** busca por `(checkout_id, account)` → decide (Task 2) → pula (já no Omie) / atualiza itens (rascunho reusado) / insere (com 23505→re-busca). Retorna `{ id, alreadySent }`.

- [ ] **Step 1: Teste que falha**

Adicionar a `idempotency.test.ts`:

```ts
import { ensureSalesOrderRow } from '../idempotency';
import type { SubmitClient } from '../types';

function makeFakeSupabase(opts: {
  existing?: { id: string; omie_pedido_id: number | null } | null;
  insertResult?: { data: { id: string } | null; error: { code?: string } | null };
}) {
  const calls = { inserted: false, updated: false };
  const fake = {
    from() { return this; },
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => ({ data: opts.existing ?? null, error: null }),
    insert(_r: unknown) { calls.inserted = true; return {
      select() { return this; },
      single: async () => opts.insertResult ?? { data: { id: 'NEW' }, error: null },
    }; },
    update(_f: unknown) { calls.updated = true; return { eq: async () => ({ error: null }) }; },
  };
  return { fake: fake as unknown as SubmitClient, calls };
}

const baseArgs = {
  checkoutId: 'ck-1', account: 'oben', origem: null, atendimentoId: null,
  fields: { customer_user_id: 'u1', created_by: 'u1', items: [], subtotal: 0, total: 0,
    notes: null, customer_address: null, customer_phone: null, ready_by_date: null },
};

describe('ensureSalesOrderRow', () => {
  it('não existe → insere (alreadySent=false)', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: null, insertResult: { data: { id: 'X' }, error: null } });
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'X', alreadySent: false });
    expect(calls.inserted).toBe(true);
  });
  it('existe com omie_pedido_id → skip (alreadySent=true), não muta', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: { id: 'Y', omie_pedido_id: 99 } });
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'Y', alreadySent: true });
    expect(calls.inserted).toBe(false); expect(calls.updated).toBe(false);
  });
  it('existe sem omie_pedido_id → reusa (update, alreadySent=false)', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: { id: 'Z', omie_pedido_id: null } });
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'Z', alreadySent: false });
    expect(calls.updated).toBe(true); expect(calls.inserted).toBe(false);
  });
  it('corrida: insert 23505 → re-busca e reusa', async () => {
    let n = 0;
    const fake = {
      from() { return this; }, select() { return this; }, eq() { return this; },
      maybeSingle: async () => (++n === 1 ? { data: null, error: null } : { data: { id: 'RACED', omie_pedido_id: null }, error: null }),
      insert() { return { select() { return this; }, single: async () => ({ data: null, error: { code: '23505' } }) }; },
      update() { return { eq: async () => ({ error: null }) }; },
    } as unknown as SubmitClient;
    expect(await ensureSalesOrderRow(fake, baseArgs)).toEqual({ id: 'RACED', alreadySent: false });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun run test -- src/services/orderSubmission/__tests__/idempotency.test.ts
```
Esperado: FALHA (`ensureSalesOrderRow` não existe).

- [ ] **Step 3: Implementar**

Adicionar a `src/services/orderSubmission/idempotency.ts`:

```ts
export interface EnsureSalesOrderArgs {
  checkoutId: string;
  account: string;
  origem: string | null;
  atendimentoId: string | null;
  fields: {
    customer_user_id: string; created_by: string; items: Json;
    subtotal: number; total: number; notes: string | null;
    customer_address: string | null; customer_phone: string | null; ready_by_date: string | null;
  };
}

/**
 * Garante 1 linha de sales_orders por (checkout_id, account), idempotente:
 *  - já no Omie (omie_pedido_id) → não toca; alreadySent=true → o caller PULA o edge.
 *  - rascunho                    → atualiza os campos do carrinho atual; reusa o id.
 *  - inexistente                 → insere; em corrida (23505) re-busca e reusa.
 * O id é estável entre retries do mesmo checkout → a chave determinística PV_<id> também.
 */
export async function ensureSalesOrderRow(
  supabase: SubmitClient,
  args: EnsureSalesOrderArgs,
): Promise<{ id: string; alreadySent: boolean }> {
  const { checkoutId, account, origem, atendimentoId, fields } = args;

  const findExisting = async (): Promise<{ id: string; omie_pedido_id: number | null } | null> => {
    const { data, error } = await supabase
      .from('sales_orders').select('id, omie_pedido_id')
      .eq('checkout_id', checkoutId).eq('account', account).maybeSingle();
    if (error) throw error;
    return (data as { id: string; omie_pedido_id: number | null } | null) ?? null;
  };

  const existing = await findExisting();
  const action = decideSalesOrderAction(existing);

  if (action === 'skip') return { id: existing!.id, alreadySent: true };

  if (action === 'reuse') {
    const { error } = await supabase.from('sales_orders').update({
      items: fields.items, subtotal: fields.subtotal, total: fields.total, notes: fields.notes,
      customer_address: fields.customer_address, customer_phone: fields.customer_phone,
      ready_by_date: fields.ready_by_date,
    }).eq('id', existing!.id);
    if (error) throw error;
    return { id: existing!.id, alreadySent: false };
  }

  const { data, error } = await supabase.from('sales_orders').insert({
    ...fields, status: 'rascunho', account, checkout_id: checkoutId, origem, atendimento_id: atendimentoId,
  }).select('id').single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      const raced = await findExisting();
      if (raced) return { id: raced.id, alreadySent: decideSalesOrderAction(raced) === 'skip' };
    }
    throw error;
  }
  return { id: data.id, alreadySent: false };
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
bun run test -- src/services/orderSubmission/__tests__/idempotency.test.ts
```
Esperado: PASS (7 testes).

- [ ] **Step 5: Commit**

```bash
git add src/services/orderSubmission/idempotency.ts src/services/orderSubmission/__tests__/idempotency.test.ts
git commit -m "feat(onda1/fase0): ensureSalesOrderRow (insert-or-get; skip se já no Omie)"
```

---

## Task 4: Helpers puros do edge — chave determinística + detector de duplicado

**Files:**
- Create: `src/lib/omie/pedido-integration-code.ts` + `src/lib/omie/pedido-duplicate.ts`
- Test: `src/lib/omie/__tests__/pedido-integration-code.test.ts` + `pedido-duplicate.test.ts`

**Contexto:** dois helpers puros, **espelhados verbatim no edge** (Deno não importa de `src/`). (1) chave determinística. (2) detector de duplicado — **lê `Error.message`** porque `callOmieVendasApi` **lança** em fault (P2), não retorna o objeto.

- [ ] **Step 1: Testes que falham**

Criar `src/lib/omie/__tests__/pedido-integration-code.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPedidoIntegrationCode } from '../pedido-integration-code';
describe('buildPedidoIntegrationCode', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  it('determinístico', () => { expect(buildPedidoIntegrationCode(id)).toBe(buildPedidoIntegrationCode(id)); });
  it('formato PV_<uuid> sem timestamp', () => { expect(buildPedidoIntegrationCode(id)).toBe(`PV_${id}`); });
  it('cabe em 60 chars (limite Omie)', () => { expect(buildPedidoIntegrationCode(id).length).toBeLessThan(60); });
});
```

Criar `src/lib/omie/__tests__/pedido-duplicate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isOmieDuplicatePedido } from '../pedido-duplicate';
describe('isOmieDuplicatePedido', () => {
  it('Error com "já cadastrado"', () => { expect(isOmieDuplicatePedido(new Error('Pedido já cadastrado p/ o código de integração'))).toBe(true); });
  it('Error "ja cadastrado" sem acento', () => { expect(isOmieDuplicatePedido(new Error('codigo de integracao ja cadastrado'))).toBe(true); });
  it('string crua também', () => { expect(isOmieDuplicatePedido('integração já cadastrada')).toBe(true); });
  it('outro erro → false', () => { expect(isOmieDuplicatePedido(new Error('Cliente não encontrado'))).toBe(false); });
  it('null/forma inesperada → false', () => {
    expect(isOmieDuplicatePedido(null)).toBe(false);
    expect(isOmieDuplicatePedido({})).toBe(false);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun run test -- src/lib/omie/__tests__/pedido-integration-code.test.ts src/lib/omie/__tests__/pedido-duplicate.test.ts
```
Esperado: FALHA (módulos não existem).

- [ ] **Step 3: Implementar**

Criar `src/lib/omie/pedido-integration-code.ts`:

```ts
/**
 * cCodIntPed determinístico do pedido de venda. PV_<uuid> (39 chars < 60, limite Omie).
 * Determinístico (sem Date.now, sem truncar) → re-enviar o mesmo sales_order_id gera a
 * mesma chave → o Omie rejeita a duplicata → idempotência.
 * ⚠️ ESPELHADO verbatim em supabase/functions/omie-vendas-sync/index.ts.
 */
export function buildPedidoIntegrationCode(salesOrderId: string): string {
  return `PV_${salesOrderId}`;
}
```

Criar `src/lib/omie/pedido-duplicate.ts`:

```ts
/**
 * Detecta a resposta do Omie de codigo_pedido_integracao DUPLICADO. Lê de Error.message
 * (callOmieVendasApi LANÇA em fault) ou string crua. ⚠️ ESPELHADO no edge. As frases
 * devem bater com a faultstring REAL do Omie (confirmar na Task 8).
 */
export function isOmieDuplicatePedido(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : typeof err === 'string' ? err : '').toLowerCase();
  if (!msg) return false;
  return msg.includes('já cadastrad') || msg.includes('ja cadastrad')
    || (msg.includes('integra') && msg.includes('cadastrad'));
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
bun run test -- src/lib/omie/__tests__/pedido-integration-code.test.ts src/lib/omie/__tests__/pedido-duplicate.test.ts
```
Esperado: PASS (8 testes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/omie/pedido-integration-code.ts src/lib/omie/pedido-duplicate.ts src/lib/omie/__tests__/
git commit -m "feat(onda1/fase0): helpers puros — chave determinística + detector de duplicado (Error.message)"
```

---

## Task 5: Edge `criarPedidoVenda` — chave determinística + write-back checado + reconciliação + OP determinística

**Files:**
- Modify: `supabase/functions/omie-vendas-sync/index.ts`

**Contexto:** money-path. Mudanças em `criarPedidoVenda` (e a OP em `criar_ordem_producao`):
1. chave `PV_${salesOrderId}` (determinística).
2. write-back do sucesso **com erro checado** (P1-5 — hoje o `.update()` ignora erro → linha órfã).
3. **reconciliação obrigatória** (P1-5/A6): no fault "já cadastrado" do Omie, `ConsultarPedido({codigo_pedido_integracao})` → write-back → sucesso.
4. chave da OP determinística (P1-8): `OP_${salesOrderId}_${omie_codigo_produto}` (sem `Date.now()`).

- [ ] **Step 1: Ler o tratamento de fault do `callOmieVendasApi`**

Em `supabase/functions/omie-vendas-sync/index.ts`, ler `callOmieVendasApi` (~`:230-260`) e confirmar: ela **lança** `Error` no fault do Omie (Codex apontou `:257`). Isso define que a detecção de duplicado fica num `try/catch` em volta do `IncluirPedido`, lendo `err` (não `result`). Confirmar a forma exata e ajustar o Step 2 se necessário.

- [ ] **Step 2: Aplicar as mudanças em `criarPedidoVenda`**

(a) Trocar a linha da chave:

```ts
  const cCodIntPed = `PV_${salesOrderId.substring(0, 8)}_${Date.now()}`;
```
por (com os mirrors inline — Deno não importa de `src/`):
```ts
  // Determinístico (espelha src/lib/omie/pedido-integration-code.ts): re-enviar o mesmo
  // sales_order_id gera a MESMA chave → o Omie rejeita a duplicata (idempotência).
  const cCodIntPed = `PV_${salesOrderId}`;
  // Espelha src/lib/omie/pedido-duplicate.ts (callOmieVendasApi LANÇA em fault).
  const isOmieDuplicatePedido = (e: unknown): boolean => {
    const m = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').toLowerCase();
    return !!m && (m.includes('já cadastrad') || m.includes('ja cadastrad') || (m.includes('integra') && m.includes('cadastrad')));
  };
```

(b) Envolver a chamada `IncluirPedido` num try/catch que reconcilia o duplicado. Substituir o bloco:

```ts
  const result = await callOmieVendasApi("produtos/pedido/", "IncluirPedido", payload, account);
  if (!result) {
    throw new Error(`Omie (${account}) não respondeu ... Tente novamente em alguns segundos.`);
  }
  const omie_pedido_id = (result.codigo_pedido as number | undefined) || null;
  const omie_numero_pedido = (result.numero_pedido as string | number | undefined) || cCodIntPed;
  // Atualizar sales_order com dados do Omie
  await supabase.from("sales_orders").update({ omie_pedido_id, omie_numero_pedido: String(omie_numero_pedido), omie_payload: payload, omie_response: result, status: "enviado" }).eq("id", salesOrderId);
  return { omie_pedido_id, omie_numero_pedido };
```

por:

```ts
  let omie_pedido_id: number | null;
  let omie_numero_pedido: string | number;
  let omie_response: unknown = null;
  try {
    const result = await callOmieVendasApi("produtos/pedido/", "IncluirPedido", payload, account);
    if (!result) {
      throw new Error(`Omie (${account}) não respondeu ao incluir pedido (provável rate limit 429 após retries). Tente novamente em alguns segundos.`);
    }
    const codPed = result.codigo_pedido as number | undefined;
    if (typeof codPed !== "number" || codPed <= 0) {
      // P1-1: Omie respondeu "ok" mas SEM número → NÃO escrever 'enviado' (senão o retry
      // acha omie_pedido_id=null, reusa e reenvia). Lançar → o retry tenta de novo
      // (e a chave determinística + dedup do Omie reconciliam se o pedido já existir).
      throw new Error(`Omie (${account}) retornou sucesso sem codigo_pedido válido (${JSON.stringify(result?.codigo_pedido)}).`);
    }
    omie_pedido_id = codPed;
    omie_numero_pedido = (result.numero_pedido as string | number | undefined) || cCodIntPed;
    omie_response = result;
  } catch (e) {
    // Reconciliação (idempotência): se a chave determinística já existe no Omie (tentativa
    // anterior criou o pedido mas o write-back falhou), consultar e vincular em vez de falhar.
    if (!isOmieDuplicatePedido(e)) throw e;
    const consulta = await callOmieVendasApi(
      "produtos/pedido/", "ConsultarPedido", { codigo_pedido_integracao: cCodIntPed }, account,
    ) as { pedido_venda_produto?: { cabecalho?: { codigo_pedido?: number; numero_pedido?: string | number } } } | null;
    const cab = consulta?.pedido_venda_produto?.cabecalho;
    if (!cab?.codigo_pedido) {
      throw new Error(`Omie (${account}) reportou pedido duplicado mas ConsultarPedido(${cCodIntPed}) não retornou o pedido — reconciliação falhou.`);
    }
    omie_pedido_id = cab.codigo_pedido;
    omie_numero_pedido = cab.numero_pedido ?? cab.codigo_pedido;
    omie_response = { reconciled: true, consulta };
  }

  // Write-back COM erro checado E exigindo EXATAMENTE 1 linha (P1-2: o PostgREST devolve
  // error:null mesmo atualizando 0 linhas → deixaria pedido órfão no Omie com "sucesso").
  // Casa por id + account.
  const { data: wbRows, error: wbError } = await supabase.from("sales_orders").update({
    omie_pedido_id, omie_numero_pedido: String(omie_numero_pedido),
    omie_payload: payload, omie_response, status: "enviado",
  }).eq("id", salesOrderId).eq("account", account).select("id");
  if (wbError) {
    // 23505 no índice (account, omie_pedido_id) = ESSE omie_pedido_id já está vinculado a OUTRA
    // linha → conflito real, NÃO auto-reconciliável (não dizer "retry resolve"). Surfaça.
    const conflict = (wbError as { code?: string }).code === "23505";
    throw new Error(`Pedido no Omie (${omie_pedido_id}) mas write-back falhou${conflict ? " (CONFLITO de vínculo — investigar manualmente)" : ""}: ${wbError.message}.`);
  }
  if (!wbRows || wbRows.length !== 1) {
    throw new Error(`Pedido no Omie (${omie_pedido_id}) mas o write-back não casou exatamente 1 linha (id=${salesOrderId}, account=${account}) — linha órfã, investigar.`);
  }
  return { omie_pedido_id, omie_numero_pedido };
```

(c) **Chave da OP determinística** (P1-8). Localizar `cCodIntOP: \`OP_${opSalesId.substring(0, 8)}_${opItem.omie_codigo_produto}_${Date.now()}\`` e trocar por:

```ts
            cCodIntOP: `OP_${opSalesId}_${opItem.omie_codigo_produto}`,
```

> ⚠️ **Janela de omissão da OP (registrada, não-objetivo da Fase 0):** após os fixes, a OP **não duplica** (o retry de um PV já-enviado é PULADO no client → `criar_ordem_producao` não re-dispara). O resíduo é **omissão** (browser morre entre o PV ok e a invocação da OP). Recuperar a OP omitida é follow-up (ex.: garantir-OP no skip). A chave determinística é seguro adicional.

- [ ] **Step 3: `deno check` (net-zero de erros) — informativo**

O CI não roda `deno check`; o runtime do Supabase compila. Conferir visualmente que o diff não introduz erro novo de tipo (o `omie-vendas-sync` já tem 4 erros pré-existentes de typing do supabase-js — net-zero).

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/omie-vendas-sync/index.ts
git commit -m "feat(onda1/fase0): edge idempotente — chave determinística + write-back checado + reconciliação + OP determinística"
```

> ⚠️ Deploy manual via Lovable **após o merge** (Task 8). A verificação de comportamento real (dedup + reconciliação) está na Task 8.

---

## Task 6: `submitOrder` — usar `ensureSalesOrderRow` + flag `allConfirmed`

**Files:**
- Modify: `src/services/orderSubmission/types.ts`
- Modify: `src/services/orderSubmission/submitOrder.ts`

**Contexto:** trocar os dois `.insert()` (Oben `:103`, Colacor `:192`) por `ensureSalesOrderRow`; pular o edge se `alreadySent`; e expor **`allConfirmed`** no resultado (P1-2 — o caller só reseta/limpa em sucesso TOTAL). O bloco de afiação (`syncOrderToOmie`) **não** muda.

- [ ] **Step 1: `SubmitOrderParams` + `SubmitOrderResult`**

Em `src/services/orderSubmission/types.ts`, em `SubmitOrderParams` (após `isCustomerMode?`):

```ts
  /** Chave de idempotência por TENTATIVA de envio (estável entre retries; ver useUnifiedOrder). */
  checkoutId: string;
  /** Canal de origem. Na Fase 0 é null/'web_*'; a Fase 1 grava 'ligacao_sainte' etc. */
  origem?: string | null;
  /** Liga ligação ↔ N pedidos. null na Fase 0 (Fase 1 preenche). */
  atendimentoId?: string | null;
```

E em `SubmitOrderResult` (após `errors`):

```ts
  /** true só quando TODA conta com itens foi confirmada/reconciliada (sem 'pendente ERP').
   *  O caller usa isso p/ decidir limpar o carrinho + resetar o checkout_id (idempotência). */
  allConfirmed: boolean;
```

- [ ] **Step 2: Import + destructuring + helper de resultado**

No topo de `submitOrder.ts`:

```ts
import { ensureSalesOrderRow } from './idempotency';
```

No destructuring de `params`, adicionar:

```ts
    checkoutId, origem = null, atendimentoId = null,
```

- [ ] **Step 3: Bloco Oben — `ensureSalesOrderRow` + skip + marca de erro de sync**

Substituir o `let salesOrderId: string; try { ...insert... } catch {...}` do Oben por:

```ts
    let salesOrderId: string;
    let alreadySent: boolean;
    try {
      const ensured = await ensureSalesOrderRow(supabase, {
        checkoutId, account: 'oben', origem, atendimentoId,
        fields: {
          customer_user_id: customerUserId || user.id, created_by: user.id, items: itemsPayload,
          subtotal: subtotals.oben, total: subtotals.oben, notes: meta.notes || null,
          customer_address: storedAddress, customer_phone: storedPhone, ready_by_date: meta.readyByDate || null,
        },
      });
      salesOrderId = ensured.id; alreadySent = ensured.alreadySent;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Erro ao inserir pedido Oben';
      logger.critical('Failed to ensure sales_order in Supabase — aborting', {
        stage: 'supabase_insert', account: 'oben', customerId: customer.codigo_cliente,
        customerUserId: customerUserId || user.id, itemCount: obenProductItems.length, error: e,
      });
      return { success: false, results, printDataList: [], lastOrderData: null,
        errors: [{ step: 'insert_oben', message }], allConfirmed: false };
    }

    if (alreadySent) {
      results.push('PV Oben (já enviado)');
    } else {
      try {
        const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'criar_pedido', account: 'oben', sales_order_id: salesOrderId,
            codigo_cliente: customer.codigo_cliente, codigo_vendedor: customer.codigo_vendedor,
            items: obenProductItems.map(c => ({
              omie_codigo_produto: c.product.omie_codigo_produto, quantidade: c.quantity, valor_unitario: c.unit_price,
              descricao: c.product.descricao,
              ...(c.tint_cor_id ? { tint_cor_id: c.tint_cor_id, tint_nome_cor: c.tint_nome_cor } : {}),
            })),
            observacao: meta.notes, codigo_parcela: payment.parcelaOben,
            quantidade_volumes: volumes.oben || undefined, ordem_compra: meta.ordemCompra || undefined,
          },
        });
        if (!omieError) results.push(`PV Oben ${omieResult?.omie_numero_pedido || ''}`);
        else { results.push('PV Oben (pendente ERP)'); errors.push({ step: 'sync_oben_omie', message: omieError.message || 'Falha ao sincronizar Oben com Omie' }); }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Falha ao sincronizar Oben com Omie';
        logger.error('Oben Omie sync exception', { stage: 'omie_sync', account: 'oben', customerId: customer.codigo_cliente, salesOrderId, error: e });
        results.push('PV Oben (pendente ERP)'); errors.push({ step: 'sync_oben_omie', message });
      }
    }
```

> Mantém os itens no body (o edge usa o body). Como o client grava `itemsPayload` na linha **e** envia os mesmos itens, não há divergência DB×Omie no nosso fluxo (1 vendedora, sem retries-com-edição-concorrente). Belt-and-suspenders "edge lê itens da linha" = follow-up se a concorrência crescer.

- [ ] **Step 4: Bloco Colacor — mesmo padrão**

Repetir o padrão no Colacor (`account: 'colacor'`, `subtotals.colacor`, `customer.codigo_cliente_colacor!`, `customer.codigo_vendedor_colacor ?? null`, `payment.parcelaColacor`, `volumes.colacor`). O bloco da OP (`criar_ordem_producao`) fica **dentro** do `if (!omieError)` (preservar **verbatim** o filtro `produtoAcabadoItems` + invoke) → no `alreadySent`, OP é pulada junto.

- [ ] **Step 5: Computar `allConfirmed` no retorno final**

No `return { success: true, ... }` final, adicionar:

```ts
    allConfirmed: !errors.some(e => e.step === 'sync_oben_omie' || e.step === 'sync_colacor_omie' || e.step === 'sync_os_omie'),
```

E em **TODOS** os `return` de saída antecipada (P1-7) — o de **carrinho vazio** (`submitOrder.ts:38`), o de **`validate_identity`** (`:66`), e os 2 aborts (insert_oben/insert_colacor) — incluir `allConfirmed: false`. (Os 2 aborts já no Step 3; falta adicionar nos 2 do topo.) Como `allConfirmed` virou **obrigatório** em `SubmitOrderResult`, o `tsc` acusa qualquer `return` que esqueça — confiar nele pra não passar nenhum.

- [ ] **Step 6: Typecheck + testes**

```bash
bun run typecheck
heavy bun run test
```
Esperado: typecheck acusa só o caller `useUnifiedOrder` faltando `checkoutId` (resolvido na Task 7) + qualquer teste de `submitOrder` que precise do novo campo no mock (atualizar). Conferir `src/services/orderSubmission/__tests__/submitOrder.test.ts` (Codex citou `:151`) e passar `checkoutId` + assertar `allConfirmed` se fizer sentido.

- [ ] **Step 7: Commit**

```bash
git add src/services/orderSubmission/types.ts src/services/orderSubmission/submitOrder.ts src/services/orderSubmission/__tests__/submitOrder.test.ts
git commit -m "feat(onda1/fase0): submitOrder idempotente (ensureSalesOrderRow) + allConfirmed"
```

---

## Task 7: `useUnifiedOrder` — `checkout_id` durável + amarrado por impressão digital

**Files:**
- Create: `src/services/orderSubmission/checkout-envelope.ts`
- Test: `src/services/orderSubmission/__tests__/checkout-envelope.test.ts`
- Modify: `src/hooks/useUnifiedOrder.ts`

**Contexto (P1-2/P1-3):** o `checkout_id` precisa: (a) ser **durável** (sobreviver a refresh — localStorage); (b) **amarrado a uma impressão digital** (cliente + carrinho de produtos) pra que um pedido GENUINAMENTE diferente nunca reuse um `checkout_id` antigo e **pule em silêncio** uma conta já enviada (= pedido perdido); (c) **resetar só em sucesso TOTAL** (não em parcial — senão o retry duplica a conta já enviada). A impressão digital distingue "retry do mesmo pedido" (mesma fp → reusa) de "pedido novo" (fp diferente, sem commit → novo) de "tem um envio pendente com outro carrinho" (fp diferente + já committed → **conflito**: avisa, NÃO age em silêncio). **Sem efeito de troca-de-cliente** (a fp já inclui o cliente → rotaciona sozinha; e um efeito no `selectedCustomer` dispararia no mount e apagaria o envelope restaurado no refresh — P1-3).

- [ ] **Step 1: Helper puro do envelope + testes (TDD)**

Criar `src/services/orderSubmission/__tests__/checkout-envelope.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeCheckoutFingerprint, decideCheckoutEnvelope } from '../checkout-envelope';

describe('computeCheckoutFingerprint', () => {
  const a = { account: 'oben', omie_codigo_produto: 1, quantity: 2, unit_price: 10 };
  const b = { account: 'colacor', omie_codigo_produto: 9, quantity: 1, unit_price: 5 };
  it('independe da ordem dos itens', () => {
    expect(computeCheckoutFingerprint('c1', [a, b])).toBe(computeCheckoutFingerprint('c1', [b, a]));
  });
  it('muda com quantidade e com cliente', () => {
    expect(computeCheckoutFingerprint('c1', [a])).not.toBe(computeCheckoutFingerprint('c1', [{ ...a, quantity: 3 }]));
    expect(computeCheckoutFingerprint('c1', [a])).not.toBe(computeCheckoutFingerprint('c2', [a]));
  });
});

describe('decideCheckoutEnvelope', () => {
  const env = (fp: string, committed: boolean) => ({ checkoutId: 'k', fingerprint: fp, committed });
  it('sem envelope → new', () => { expect(decideCheckoutEnvelope(null, 'fp')).toBe('new'); });
  it('mesma fp, não committed → reuse', () => { expect(decideCheckoutEnvelope(env('fp', false), 'fp')).toBe('reuse'); });
  it('mesma fp, committed → reuse (retry do mesmo envio)', () => { expect(decideCheckoutEnvelope(env('fp', true), 'fp')).toBe('reuse'); });
  it('fp diferente, não committed → new (pedido mudou antes de enviar)', () => { expect(decideCheckoutEnvelope(env('old', false), 'fp')).toBe('new'); });
  it('fp diferente, committed → conflict (envio pendente de outro carrinho)', () => { expect(decideCheckoutEnvelope(env('old', true), 'fp')).toBe('conflict'); });
});
```

Rodar e ver falhar:
```bash
bun run test -- src/services/orderSubmission/__tests__/checkout-envelope.test.ts
```

Criar `src/services/orderSubmission/checkout-envelope.ts`:

```ts
export interface CheckoutEnvelope { checkoutId: string; fingerprint: string; committed: boolean; }
export type CheckoutDecision = 'reuse' | 'new' | 'conflict';

/** Impressão digital estável do pedido de PRODUTO (cliente + itens oben/colacor). Ordem-independente. */
export function computeCheckoutFingerprint(
  customerKey: string,
  items: ReadonlyArray<{ account: string; omie_codigo_produto: number | string; quantity: number; unit_price: number }>,
): string {
  const sig = items.map(i => `${i.account}:${i.omie_codigo_produto}:${i.quantity}:${i.unit_price}`).sort().join('|');
  return `${customerKey}#${sig}`;
}

/**
 * Decide o que fazer com o envelope persistido dada a impressão digital atual:
 *  - sem envelope                       → 'new'
 *  - mesma fp                           → 'reuse'    (retry do MESMO pedido — com ou sem commit)
 *  - fp diferente E ainda não committed → 'new'      (mudou o pedido antes de qualquer envio)
 *  - fp diferente E já committed        → 'conflict' (há um envio pendente de OUTRO carrinho;
 *                                                      não criar em silêncio → avisar)
 */
export function decideCheckoutEnvelope(stored: CheckoutEnvelope | null, fingerprint: string): CheckoutDecision {
  if (!stored) return 'new';
  if (stored.fingerprint === fingerprint) return 'reuse';
  if (stored.committed) return 'conflict';
  return 'new';
}
```

Rodar e ver passar (7 testes).

- [ ] **Step 2: Persistência do envelope no hook**

No topo de `useUnifiedOrder.ts` (após imports):

```ts
import { computeCheckoutFingerprint, decideCheckoutEnvelope, type CheckoutEnvelope } from '@/services/orderSubmission/checkout-envelope';

const CHECKOUT_ENV_KEY = 'unified_order_checkout_env';
function loadCheckoutEnv(): CheckoutEnvelope | null {
  if (typeof localStorage === 'undefined') return null;
  try { const r = localStorage.getItem(CHECKOUT_ENV_KEY); return r ? JSON.parse(r) as CheckoutEnvelope : null; } catch { return null; }
}
function persistCheckoutEnv(e: CheckoutEnvelope | null) {
  if (typeof localStorage === 'undefined') return;
  try { if (e) localStorage.setItem(CHECKOUT_ENV_KEY, JSON.stringify(e)); else localStorage.removeItem(CHECKOUT_ENV_KEY); } catch { /* quota */ }
}
```

- [ ] **Step 3: Ref do envelope + reset no `clearCustomer`**

Junto das declarações do hook:

```ts
  // Idempotência: envelope {checkout_id, fingerprint, committed} durável (refresh).
  // A fp amarra o checkout ao pedido; reseta só no clearCustomer e no sucesso TOTAL.
  const checkoutEnvRef = useRef<CheckoutEnvelope | null>(loadCheckoutEnv());
```

No `clearCustomer` (escape explícito de um conflito + começar do zero), zerar:

```ts
    checkoutEnvRef.current = null; persistCheckoutEnv(null);
```

> **Sem `useEffect` em `selectedCustomer`** (P1-3): a fp já inclui o cliente → a rotação é automática no submit; um efeito dispararia no mount e apagaria o envelope restaurado no refresh.

- [ ] **Step 4: Resolver o envelope no submit + passar o `checkout_id`**

No `submitOrder` (`:630`), após `setSubmitting(true);`:

```ts
    // Impressão digital do pedido de produto (oben+colacor) + cliente.
    const customerKey = String(selectedCustomer.local_user_id || selectedCustomer.codigo_cliente || '');
    const fpItems = [
      ...obenProductItems.map(c => ({ account: 'oben', omie_codigo_produto: c.product.omie_codigo_produto, quantity: c.quantity, unit_price: c.unit_price })),
      ...colacorProductItems.map(c => ({ account: 'colacor', omie_codigo_produto: c.product.omie_codigo_produto, quantity: c.quantity, unit_price: c.unit_price })),
    ];
    const fingerprint = computeCheckoutFingerprint(customerKey, fpItems);
    const decision = decideCheckoutEnvelope(checkoutEnvRef.current, fingerprint);
    if (decision === 'conflict') {
      setSubmitting(false);
      toast.error('Há um envio pendente para este cliente com outro carrinho', {
        description: 'Reenvie o pedido pendente (mesmo carrinho) ou limpe o cliente para começar um novo.',
      });
      return;
    }
    if (decision === 'new') {
      checkoutEnvRef.current = { checkoutId: crypto.randomUUID(), fingerprint, committed: false };
    }
    // commit: um envio vai acontecer → trava a fp (editar o carrinho depois = conflito até resolver).
    checkoutEnvRef.current = { ...checkoutEnvRef.current!, committed: true };
    persistCheckoutEnv(checkoutEnvRef.current);
    const checkoutId = checkoutEnvRef.current.checkoutId;
```

Na chamada `submitOrderService({ ... })`, adicionar:

```ts
        checkoutId,
        origem: isCustomerMode ? 'web_customer' : 'web_staff',
        atendimentoId: null,
```

- [ ] **Step 5: Tratar o resultado — limpar/resetar só em sucesso TOTAL**

```ts
      if (result.success && result.lastOrderData) {
        setLastOrderData(result.lastOrderData);
        setOrderSuccessOpen(true);
        if (result.allConfirmed) {
          clearCart();
          setNotes('');
          checkoutEnvRef.current = null; persistCheckoutEnv(null); // sucesso TOTAL → próximo pedido = novo envelope
        } else {
          // Sucesso PARCIAL: NÃO limpar o carrinho nem resetar o envelope — o retry (mesma fp)
          // reusa a MESMA linha/chave e não duplica a conta de PRODUTO já enviada.
          toast.warning('Pedido parcialmente enviado', {
            description: serviceItems.length > 0
              ? 'Os produtos não duplicam no reenvio. Atenção: a OS de afiação pode duplicar — confira no Omie.'
              : 'Alguma conta ficou pendente no ERP. Reenvie — os produtos não duplicam.',
          });
        }
        if (result.errors.length > 0) {
          toast.success('Pedido criado com avisos', { description: result.errors.map(e => e.message).join(' | ') });
        }
      } else { /* ...erro... (inalterado) */ }
```

- [ ] **Step 6: Typecheck + testes + build**

```bash
bun run typecheck
heavy bun run test
heavy bun run build
```
Esperado: tudo limpo.

- [ ] **Step 7: Commit**

```bash
git add src/services/orderSubmission/checkout-envelope.ts src/services/orderSubmission/__tests__/checkout-envelope.test.ts src/hooks/useUnifiedOrder.ts
git commit -m "feat(onda1/fase0): checkout_id durável amarrado por impressão digital (fecha pedido-perdido + não duplica em parcial)"
```

---

## Task 8: Rollout coordenado + verificação do dedup do Omie (GATE)

**Files:** nenhum (operacional). Money-path → sequência importa (P1-7).

> 🔴 **GATE (governa o desenho):** antes/durante o rollout, **confirmar que o Omie de VENDA rejeita `codigo_pedido_integracao` duplicado**. Se rejeitar (esperado — igual ao pedido de COMPRA #628), o lean está correto. Se **NÃO** rejeitar, a concorrência/retry pode duplicar → **PARAR** e escalar para o claim atômico no servidor (não shippar o lean).

- [ ] **Step 1: Aplicar a migração (SQL Editor do Lovable)**

🟣 Lovable → SQL Editor → colar `20260613120000_onda1_fase0_sales_orders_identidade.sql` → Run.

- [ ] **Step 2: Validar (SQL Editor)**

```sql
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='sales_orders'
     AND column_name IN ('checkout_id','origem','atendimento_id')) AS colunas_3,
  (SELECT count(*) FROM pg_indexes WHERE indexname='sales_orders_checkout_account_uq') AS uq_checkout_1,
  (SELECT count(*) FROM pg_indexes WHERE indexname='sales_orders_account_omiepedido_uq') AS uq_omie_1;
-- Esperado: colunas_3=3, uq_checkout_1=1, uq_omie_1=1
```

- [ ] **Step 3: Quiescer envios + deploy COORDENADO (edge + frontend juntos)**

P1-7: deployar o edge (chave determinística) com o frontend antigo (que cria `sales_order_id` novo a cada retry) ainda **duplica**. Então, numa janela sem as farmers enviando pedido: **(a)** redeploy do `omie-vendas-sync` (chat do Lovable, **verbatim da main, APÓS o merge**) **e (b)** Publish do frontend — **juntos**. Não reabrir envios até os dois estarem no ar.

- [ ] **Step 4: Verificar o dedup + a reconciliação (smoke, prod)**

Com um cliente de teste, criar 1 pedido Oben → 1 PV no Omie + linha com `checkout_id` + `omie_pedido_id` + `status='enviado'`. Depois **reenviar o mesmo checkout** (retry) → **confirmar que NÃO nasce 2º PV** (a linha é pulada por `alreadySent`). **⚠️ Esse retry pula o edge** (skip client-side) → portanto **NÃO** testa a reconciliação por si só (P2 do Codex). Pra exercitar a **reconciliação de verdade**, forçar uma 2ª invocação do edge com a MESMA chave **sem** o skip (ex.: invocar `omie-vendas-sync criar_pedido` direto com um `sales_order_id` cujo `omie_pedido_id` foi zerado à mão, simulando a janela "Omie criou, write-back falhou") e confirmar: **1 só PV no Omie**, ambas as respostas com sucesso, e a linha vinculada ao mesmo `omie_pedido_id`. Capturar nos logs da edge (Lovable → Edge functions → `omie-vendas-sync`) a `faultstring` real do `IncluirPedido` duplicado e confirmar que casa com `isOmieDuplicatePedido` (ajustar as frases do helper + do espelho no edge se preciso). Conferir:

```sql
SELECT checkout_id, account, status, omie_pedido_id, omie_numero_pedido
FROM sales_orders WHERE checkout_id = '<o do teste>';
```

- [ ] **Step 5: Reconciliar linhas legadas (opcional)**

`rascunho` antigos com `checkout_id` NULL não são afetados (não duplicam — só não têm idempotência). Se houver `rascunho` que na verdade já estão no Omie, é higiene manual (fora do caminho da Fase 0).

---

## Riscos residuais (registrados — decisão "proporcional" do founder, Codex round 2)

> O founder escolheu o caminho **proporcional**: corrigir os bugs reais + fechar o pedido-perdido; e tratar concorrência/afiação como baixo-risco-no-nosso-cenário (2 farmers, 1 aba, botão "Enviar" já travado durante o envio). Os itens abaixo são **conscientes**, não esquecimentos.

- **Concorrência cross-aba (P1-4/P1-5):** 2 envios *simultâneos* do MESMO pedido (2 abas/2 dispositivos) poderiam, em tese, gravar payloads divergentes ou disparar a OP 2×. Mitigado por: o guard `submitting` (trava o duplo-envio na mesma aba) + chaves determinísticas (PV/OP) + dedup do Omie (gate T8). **Não** construímos payload-imutável-no-servidor. Vira relevante só se subir o nº de vendedoras/abas → aí, claim server-side.
- **OP — sem constraint local + omissão (P1-5/P1-8):** `production_orders` não tem UNIQUE; a OP não duplica no fluxo normal (retry de PV-enviado é pulado no client) mas pode ser **omitida** (browser morre entre PV-ok e a OP). Follow-up: garantir-OP no skip + UNIQUE`(sales_order_id, omie_codigo_produto)`.
- **Afiação OS (P1-6):** `omie-sync` (`OS_..._${Date.now()}` + `orderId` aleatório por submit) segue **não-idempotente** — retry pode duplicar a OS. **Escopado pra fora** (fluxo/edge diferente do pedido de produto). O aviso de sucesso-parcial é **honesto** (avisa "a OS de afiação pode duplicar — confira no Omie") quando há `serviceItems`. Follow-up: `orderId` derivado do `checkout_id` + chave OS determinística + reconciliação no `omie-sync`.
- **Edge lê itens do body** (não da linha): seguro no fluxo de 1 vendedora (o client grava a linha E envia os mesmos itens; sem retries-com-edição-concorrente). "Edge lê da linha (payload imutável)" = parte do caminho máximo-rigor, **não** feito.
- **`origem`/`atendimento_id`/`currentParty`** são da **Fase 1** (a ponte os escreve/usa; o `currentParty` tem corrida de resolução-async — guard por geração da chamada — a tratar lá).
- **Premissa do dedup do Omie (P1-1 round1)**: se a Task 8 mostrar que o Omie de venda NÃO rejeita duplicata, escalar p/ claim server-side.

---

## Self-Review (feito — após 2 rounds de Codex)

- **Cobertura:** idempotência (T1-T7) · chave determinística (T4/T5) · reconciliação obrigatória (T4/T5) · write-back **checado + 1-linha** (T5) · `codigo_pedido` positivo antes de 'enviado' (T5) · predicado por `omie_pedido_id` (T2) · não-duplica-em-parcial (T6/T7) · `checkout_id` durável **+ impressão digital** (T7) · tipos `Json` + `allConfirmed` em todo return (T1/T6) · OP determinística (T5) · gate do dedup + rollout coordenado + **teste de reconciliação** (T8). origem/currentParty → Fase 1.
- **Round 1 (9 P1):** A1 dedup→gate T8 · A2 reset-parcial→allConfirmed T6/T7 · A3 ref→durável+fp T7 · A4 payload→deliberadamente body (residual) · A5 write-back→checado T5 · A6 status→`omie_pedido_id` T2 · A7 OP→det. T5 · rollout T8 · types T1.
- **Round 2 (7 P1):** P1-1 `codigo_pedido` positivo (T5) · P1-2 write-back 1-linha+account (T5) · P1-3 impressão digital + sem efeito-no-mount (T7) · P1-4 concorrência→proporcional (residual) · P1-5 OP concorrência→proporcional (residual) · P1-6 afiação→escopo+aviso honesto (residual) · P1-7 `allConfirmed` em todo return + `items:Json` (T1/T6). P2: `callOmieVendasApi` preserva faultstring ✅ (detector funciona) · 23505 do write-back surfado como conflito (T5) · teste de reconciliação no T8.
- **Tipos:** `decideSalesOrderAction({omie_pedido_id})` ↔ `ensureSalesOrderRow` select `id, omie_pedido_id` ✅ · `SubmitOrderParams.checkoutId`/`SubmitOrderResult.allConfirmed` ↔ caller ✅ · `computeCheckoutFingerprint`/`decideCheckoutEnvelope` ↔ `useUnifiedOrder` ✅ · `buildPedidoIntegrationCode` ↔ edge `cCodIntPed` ✅.
- **Placeholders:** nenhum; o que só se verifica no Omie (faultstring, dedup) está no gate T8.
