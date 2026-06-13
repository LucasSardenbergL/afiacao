# Onda 1 / Fase 0 — Fundação (identidade + idempotência + origem + currentParty) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao pedido de venda uma identidade estável e idempotência ponta-a-ponta (zero pedido duplicado no Omie), gravar a `origem` do pedido, e expor o cliente da ligação reativamente no contexto — a fundação que destrava a ponte e o co-piloto das fases seguintes.

**Architecture:** Idempotência em **duas camadas que se compõem**: (1) **client** — um `checkout_id` estável por tentativa de envio + `UNIQUE(checkout_id, account)` fazem o `sales_order_id` ser **reusado** no retry (em vez de criar linha nova); (2) **edge** — a chave de integração do Omie vira **determinística** (`PV_<sales_order_id>`, sem `Date.now()`), então re-enviar o mesmo `sales_order_id` produz a mesma chave → o Omie deduplica. Um skip-se-`enviado` no client evita re-invocar o edge (e de quebra impede OP duplicada). A `origem` e o `atendimento_id` entram como colunas plumadas (a fase 1 preenche o `atendimento_id`). E o `currentParty` no `WebRTCCallContext` expõe quem está na linha. A **RPC de CMC foi adiada para a Fase 2** (decisão de 2026-06-13: `inventory_position` já é staff-gated → sem urgência; melhor desenhar junto do cockpit que a consome).

**Tech Stack:** React 18 + TS (strict) + Vite · Supabase (Postgres + Edge Functions Deno) · Omie (3 contas) · vitest · PostgreSQL 17 local (harness `db/`). Apply de migração + deploy de edge + publish do front = **manuais via Lovable** (CLAUDE.md §5).

> **Correção de premissa da spec (registrar):** a §5/§18-A5 do spec assumiu que `inventory_position` tinha RLS `USING(true)` (cmc exposto). O schema real (`supabase/schema-snapshot.sql`) mostra que **já é staff-gated** (`has_role master/employee`). Isso (a) removeu a urgência de segurança da RPC de CMC → adiada p/ Fase 2; (b) não afeta nada na Fase 0.

> **Escopo (não-objetivos desta fase):** a chave da **OS de afiação** (`omie-sync` `OS_..._${Date.now()}`) e a do **cadastro de cliente** (`APP_..._${Date.now()}`) e a da **ordem de produção** (`OP_..._${Date.now()}`) **também** usam `Date.now()`, mas ficam **fora** desta fase (o spec escopou a Fase 0 ao pedido de venda Oben/Colacor; o caminho da ligação é produto, não afiação). Ver §"Riscos residuais" no fim. A OP, em particular, deixa de ser risco de duplicação **vivo** após esta fase (o skip-se-`enviado` não re-invoca `criar_pedido`, e o bloco da OP roda dentro do sucesso dele).

---

## File Structure

| Arquivo | Papel | Tarefa |
|---|---|---|
| `supabase/migrations/20260613120000_onda1_fase0_sales_orders_identidade.sql` | **Criar** — colunas `origem`/`checkout_id`/`atendimento_id` + índice único parcial + índice de origem | T1 |
| `db/test-fase0-sales-orders-identity.sh` | **Criar** — valida a migração em PG17 (colunas, índices, semântica do único parcial) | T1 |
| `src/services/orderSubmission/idempotency.ts` | **Criar** — `decideSalesOrderAction` (puro) + `ensureSalesOrderRow` (I/O) | T2, T3 |
| `src/services/orderSubmission/__tests__/idempotency.test.ts` | **Criar** — testes vitest | T2, T3 |
| `src/services/orderSubmission/types.ts` | **Modificar** — `checkoutId`/`origem`/`atendimentoId` em `SubmitOrderParams` | T4 |
| `src/services/orderSubmission/submitOrder.ts` | **Modificar** — usar `ensureSalesOrderRow` nos 2 blocos (Oben/Colacor) + skip-se-`alreadySent` | T4 |
| `src/hooks/useUnifiedOrder.ts` | **Modificar** — `checkoutId` estável (ref) + passar `origem`/`atendimentoId` + reset no sucesso | T5 |
| `src/lib/omie/pedido-integration-code.ts` | **Criar** — `buildPedidoIntegrationCode` (puro, espelhado no edge) | T6 |
| `src/lib/omie/__tests__/pedido-integration-code.test.ts` | **Criar** — testes | T6 |
| `supabase/functions/omie-vendas-sync/index.ts` | **Modificar** — chave determinística (T6) + reconciliação de duplicado (T7) | T6, T7 |
| `src/lib/omie/pedido-duplicate.ts` | **Criar** — `isOmieDuplicatePedido` (puro, espelhado no edge) | T7 |
| `src/lib/omie/__tests__/pedido-duplicate.test.ts` | **Criar** — testes | T7 |
| `src/contexts/WebRTCCallContext.tsx` | **Modificar** — `currentParty`/`currentCustomerUserId` (interface + state + wiring + value) | T8 |

---

## Task 1: Migração — identidade + idempotência em `sales_orders`

**Files:**
- Create: `supabase/migrations/20260613120000_onda1_fase0_sales_orders_identidade.sql`
- Create: `db/test-fase0-sales-orders-identity.sh`

**Contexto:** `sales_orders` hoje **não tem** `origem`, `checkout_id` nem `atendimento_id`, e **não tem nenhuma constraint UNIQUE** (confirmado em `supabase/schema-snapshot.sql:5465-5487`). Tem `account` (default `'oben'`), `status` (default `'rascunho'`), `omie_pedido_id` (bigint), `omie_numero_pedido` (text). O índice único é **parcial** (`WHERE checkout_id IS NOT NULL`) pra não afetar as ~milhares de linhas legadas (checkout_id nulo).

- [ ] **Step 1: Escrever a migração**

Criar `supabase/migrations/20260613120000_onda1_fase0_sales_orders_identidade.sql`:

```sql
-- Onda 1 / Fase 0 — Fundação de identidade + idempotência do pedido de venda.
-- Adiciona à sales_orders: origem (canal de origem), checkout_id (chave de
-- idempotência por TENTATIVA de envio) e atendimento_id (liga ligação ↔ N pedidos;
-- preenchido pela Fase 1). Cria o índice único PARCIAL (checkout_id, account) que
-- impede 2 linhas para a mesma tentativa de envio na mesma conta Omie — base da
-- não-duplicação (junto da chave Omie determinística do edge).
-- ⚠️ MONEY-PATH: aplicar via SQL Editor do Lovable; validar com a query no fim.

ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS origem text,
  ADD COLUMN IF NOT EXISTS checkout_id uuid,
  ADD COLUMN IF NOT EXISTS atendimento_id uuid;

-- Único PARCIAL: só vale quando checkout_id IS NOT NULL → linhas legadas (checkout_id
-- nulo) não colidem entre si nem são afetadas. (checkout_id, account) porque cada conta
-- Omie gera 1 pedido próprio por tentativa de checkout (pedido multi-conta = N linhas).
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_checkout_account_uq
  ON public.sales_orders (checkout_id, account)
  WHERE checkout_id IS NOT NULL;

-- Suporta a métrica "conversão por origem" (§14 do spec) sem seq-scan.
CREATE INDEX IF NOT EXISTS idx_sales_orders_origem
  ON public.sales_orders (origem)
  WHERE origem IS NOT NULL;
```

- [ ] **Step 2: Escrever o teste PG17**

Criar `db/test-fase0-sales-orders-identity.sh` (mesmo molde de `db/verify-snapshot-replay.sh`):

```bash
#!/usr/bin/env bash
# Onda1/Fase0 — valida a migração de identidade/idempotência de sales_orders num PG17 local.
# Prova: (a) as 3 colunas + os 2 índices existem após a migração; (b) o índice único PARCIAL
# (checkout_id, account) bloqueia duplicata na MESMA conta, permite contas DISTINTAS, e NÃO
# afeta linhas com checkout_id NULO. Base/armadilhas: db/verify-snapshot-replay.sh.
# Pré-req: brew install postgresql@17 pgvector
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5434
DATA="$(mktemp -d /tmp/pgtest-fase0.XXXXXX)/data"
export LC_ALL=C LANG=C
[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-fase0.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres fase0_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d fase0_verify "$@"; }

# Snapshot restore-ready (remove meta-comandos psql + CREATE SCHEMA public).
RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

# Aplica a migração da Fase 0.
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613120000_onda1_fase0_sales_orders_identidade.sql"

echo "── asserts ──"
# (a) colunas + índices
P -v ON_ERROR_STOP=1 -tA <<'SQL'
DO $$
BEGIN
  ASSERT (SELECT count(*) FROM information_schema.columns
    WHERE table_schema='public' AND table_name='sales_orders'
      AND column_name IN ('origem','checkout_id','atendimento_id')) = 3, 'faltam colunas';
  ASSERT (SELECT count(*) FROM pg_indexes WHERE indexname='sales_orders_checkout_account_uq')=1, 'falta unique idx';
  ASSERT (SELECT count(*) FROM pg_indexes WHERE indexname='idx_sales_orders_origem')=1, 'falta origem idx';
  RAISE NOTICE 'OK colunas+indices';
END $$;
SQL

# (b) semântica do único parcial — replica role desliga FK/trigger pra semear sem cadastros pais
# (unique index continua sendo enforçado em replica role).
P -v ON_ERROR_STOP=1 -tA <<'SQL'
SET session_replication_role = replica;
DO $$
DECLARE ck uuid := gen_random_uuid();
BEGIN
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, checkout_id, origem)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 0,0,'rascunho','oben', ck, 'ligacao_sainte');
  BEGIN
    INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, checkout_id, origem)
      VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 0,0,'rascunho','oben', ck, 'ligacao_sainte');
    RAISE EXCEPTION 'FALHA: 2a linha (checkout,oben) deveria violar o unique';
  EXCEPTION WHEN unique_violation THEN NULL; -- esperado
  END;
  -- mesma checkout, conta DIFERENTE: ok
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account, checkout_id, origem)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 0,0,'rascunho','colacor', ck, 'ligacao_sainte');
  -- checkout_id NULO: 2 linhas ok (parcial não indexa nulos)
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 0,0,'rascunho','oben');
  INSERT INTO sales_orders (customer_user_id, created_by, items, subtotal, total, status, account)
    VALUES (gen_random_uuid(), gen_random_uuid(), '[]'::jsonb, 0,0,'rascunho','oben');
  RAISE NOTICE 'OK semantica do unique parcial';
END $$;
SQL
echo "FASE0 MIGRATION OK"
```

- [ ] **Step 3: Rodar o teste e ver passar**

```bash
chmod +x db/test-fase0-sales-orders-identity.sh
bash db/test-fase0-sales-orders-identity.sh
```
Esperado: `OK colunas+indices`, `OK semantica do unique parcial`, `FASE0 MIGRATION OK`. (Se `postgresql@17` não estiver instalado: `brew install postgresql@17 pgvector` primeiro.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260613120000_onda1_fase0_sales_orders_identidade.sql db/test-fase0-sales-orders-identity.sh
git commit -m "feat(onda1/fase0): migração de identidade+idempotência em sales_orders (origem/checkout_id/atendimento_id + unique parcial)"
```

> ⚠️ **A migração NÃO é aplicada pelo merge** (CLAUDE.md §5). O apply manual via SQL Editor + a query de validação estão na Task 9.

---

## Task 2: Helper puro `decideSalesOrderAction`

**Files:**
- Create: `src/services/orderSubmission/idempotency.ts`
- Test: `src/services/orderSubmission/__tests__/idempotency.test.ts`

**Contexto:** Esta é a regra-mãe da idempotência client-side. Dado o que já existe em `sales_orders` para um `(checkout_id, account)`, decide: inserir (primeira vez), reusar (rascunho de tentativa anterior que não chegou no Omie) ou pular (já foi pro Omio = `status='enviado'`). O edge marca `status='enviado'` **junto** com `omie_pedido_id` no sucesso (`omie-vendas-sync` ~`:1372-1381`), então `status='enviado'` é o sinal confiável de "já enviado".

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/services/orderSubmission/__tests__/idempotency.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decideSalesOrderAction } from '../idempotency';

describe('decideSalesOrderAction', () => {
  it('linha inexistente → insert', () => {
    expect(decideSalesOrderAction(null)).toBe('insert');
  });

  it('status enviado → skip (idempotência: não re-enviar)', () => {
    expect(decideSalesOrderAction({ status: 'enviado' })).toBe('skip');
  });

  it('status rascunho → reuse (tentativa anterior não chegou no Omie)', () => {
    expect(decideSalesOrderAction({ status: 'rascunho' })).toBe('reuse');
  });

  it('qualquer status não-enviado → reuse', () => {
    expect(decideSalesOrderAction({ status: 'cancelado' })).toBe('reuse');
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun run test -- src/services/orderSubmission/__tests__/idempotency.test.ts
```
Esperado: FALHA (`decideSalesOrderAction` não existe / módulo não encontrado).

- [ ] **Step 3: Implementar**

Criar `src/services/orderSubmission/idempotency.ts`:

```ts
import type { SubmitClient } from './types';

export type SalesOrderAction = 'insert' | 'reuse' | 'skip';

/**
 * Decide o que fazer com a linha de sales_orders de um (checkout_id, account):
 *  - null               → 'insert' (primeira tentativa deste checkout/conta)
 *  - status === 'enviado'→ 'skip'   (já foi pro Omie; re-enviar duplicaria → idempotência)
 *  - qualquer outro      → 'reuse'  (rascunho de tentativa anterior que não chegou no Omie;
 *                                     reusa a MESMA linha → mesmo id → mesma chave determinística)
 * O edge grava status='enviado' JUNTO com omie_pedido_id no sucesso, então 'enviado' é o
 * sinal confiável de "já no Omie".
 */
export function decideSalesOrderAction(
  existing: { status: string } | null,
): SalesOrderAction {
  if (!existing) return 'insert';
  if (existing.status === 'enviado') return 'skip';
  return 'reuse';
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
bun run test -- src/services/orderSubmission/__tests__/idempotency.test.ts
```
Esperado: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add src/services/orderSubmission/idempotency.ts src/services/orderSubmission/__tests__/idempotency.test.ts
git commit -m "feat(onda1/fase0): decideSalesOrderAction (regra pura de idempotência do pedido)"
```

---

## Task 3: Helper I/O `ensureSalesOrderRow`

**Files:**
- Modify: `src/services/orderSubmission/idempotency.ts`
- Modify: `src/services/orderSubmission/__tests__/idempotency.test.ts`

**Contexto:** Wrapper de I/O que: busca a linha por `(checkout_id, account)` → decide (via Task 2) → pula / atualiza (refresca itens da tentativa atual) / insere. Trata corrida concorrente (23505 entre o SELECT e o INSERT) re-buscando. Retorna `{ id, alreadySent }`. O `submitOrder` (Task 4) chama isso no lugar dos `.insert()` crus.

- [ ] **Step 1: Escrever o teste que falha**

Adicionar a `src/services/orderSubmission/__tests__/idempotency.test.ts`:

```ts
import { ensureSalesOrderRow } from '../idempotency';
import type { SubmitClient } from '../types';

// Fake mínimo do supabase: só os métodos encadeados que ensureSalesOrderRow usa.
function makeFakeSupabase(opts: {
  existing?: { id: string; status: string } | null;
  insertResult?: { data: { id: string } | null; error: { code?: string } | null };
}) {
  const calls = { inserted: false, updated: false, selected: false };
  const fake = {
    from() { return this; },
    select() { return this; },
    eq() { return this; },
    maybeSingle: async () => {
      calls.selected = true;
      return { data: opts.existing ?? null, error: null };
    },
    insert(_row: unknown) {
      calls.inserted = true;
      return {
        select() { return this; },
        single: async () => opts.insertResult ?? { data: { id: 'new-id' }, error: null },
      };
    },
    update(_fields: unknown) {
      calls.updated = true;
      return { eq: async () => ({ error: null }) };
    },
  };
  return { fake: fake as unknown as SubmitClient, calls };
}

const baseArgs = {
  checkoutId: 'ck-1',
  account: 'oben',
  origem: 'web_staff',
  atendimentoId: null,
  fields: {
    customer_user_id: 'u1', created_by: 'u1', items: [], subtotal: 0, total: 0,
    notes: null, customer_address: null, customer_phone: null, ready_by_date: null,
  },
};

describe('ensureSalesOrderRow', () => {
  it('não existe → insere e retorna alreadySent=false', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: null, insertResult: { data: { id: 'X' }, error: null } });
    const r = await ensureSalesOrderRow(fake, baseArgs);
    expect(r).toEqual({ id: 'X', alreadySent: false });
    expect(calls.inserted).toBe(true);
  });

  it('existe e enviado → pula (alreadySent=true), não insere nem atualiza', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: { id: 'Y', status: 'enviado' } });
    const r = await ensureSalesOrderRow(fake, baseArgs);
    expect(r).toEqual({ id: 'Y', alreadySent: true });
    expect(calls.inserted).toBe(false);
    expect(calls.updated).toBe(false);
  });

  it('existe e rascunho → reusa a linha (update) com alreadySent=false', async () => {
    const { fake, calls } = makeFakeSupabase({ existing: { id: 'Z', status: 'rascunho' } });
    const r = await ensureSalesOrderRow(fake, baseArgs);
    expect(r).toEqual({ id: 'Z', alreadySent: false });
    expect(calls.updated).toBe(true);
    expect(calls.inserted).toBe(false);
  });

  it('corrida: insert dá 23505 → re-busca e reusa', async () => {
    // existing=null no 1º SELECT, mas o INSERT colide; o 2º SELECT acha a linha.
    let selectCount = 0;
    const fake = {
      from() { return this; },
      select() { return this; },
      eq() { return this; },
      maybeSingle: async () => {
        selectCount += 1;
        return selectCount === 1
          ? { data: null, error: null }
          : { data: { id: 'RACED', status: 'rascunho' }, error: null };
      },
      insert() {
        return { select() { return this; }, single: async () => ({ data: null, error: { code: '23505' } }) };
      },
      update() { return { eq: async () => ({ error: null }) }; },
    } as unknown as SubmitClient;
    const r = await ensureSalesOrderRow(fake, baseArgs);
    expect(r).toEqual({ id: 'RACED', alreadySent: false });
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
  origem: string;
  atendimentoId: string | null;
  /** Campos derivados do carrinho (NÃO inclui status/account/checkout_id/origem/atendimento_id). */
  fields: {
    customer_user_id: string;
    created_by: string;
    items: unknown;
    subtotal: number;
    total: number;
    notes: string | null;
    customer_address: string | null;
    customer_phone: string | null;
    ready_by_date: string | null;
  };
}

/**
 * Garante UMA linha de sales_orders por (checkout_id, account), idempotente:
 *  - já 'enviado' → não toca (alreadySent=true) → o caller PULA o edge (sem duplicar).
 *  - rascunho     → atualiza os campos do carrinho atual e reusa o MESMO id.
 *  - inexistente  → insere; em corrida (23505) re-busca e reusa.
 * O id retornado é estável entre retries do mesmo checkout → a chave determinística do
 * edge (PV_<id>) também é → o Omie deduplica.
 */
export async function ensureSalesOrderRow(
  supabase: SubmitClient,
  args: EnsureSalesOrderArgs,
): Promise<{ id: string; alreadySent: boolean }> {
  const { checkoutId, account, origem, atendimentoId, fields } = args;

  const findExisting = async (): Promise<{ id: string; status: string } | null> => {
    const { data, error } = await supabase
      .from('sales_orders')
      .select('id, status')
      .eq('checkout_id', checkoutId)
      .eq('account', account)
      .maybeSingle();
    if (error) throw error;
    return (data as { id: string; status: string } | null) ?? null;
  };

  const existing = await findExisting();
  const action = decideSalesOrderAction(existing);

  if (action === 'skip') {
    return { id: existing!.id, alreadySent: true };
  }

  if (action === 'reuse') {
    const { error } = await supabase
      .from('sales_orders')
      .update({
        items: fields.items,
        subtotal: fields.subtotal,
        total: fields.total,
        notes: fields.notes,
        customer_address: fields.customer_address,
        customer_phone: fields.customer_phone,
        ready_by_date: fields.ready_by_date,
      })
      .eq('id', existing!.id);
    if (error) throw error;
    return { id: existing!.id, alreadySent: false };
  }

  // action === 'insert'
  const { data, error } = await supabase
    .from('sales_orders')
    .insert({
      ...fields,
      status: 'rascunho',
      account,
      checkout_id: checkoutId,
      origem,
      atendimento_id: atendimentoId,
    })
    .select('id')
    .single();

  if (error) {
    // 23505 = unique_violation: corrida concorrente criou a linha entre o SELECT e o INSERT.
    if ((error as { code?: string }).code === '23505') {
      const raced = await findExisting();
      if (raced) {
        return { id: raced.id, alreadySent: decideSalesOrderAction(raced) === 'skip' };
      }
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
Esperado: PASS (8 testes — 4 da Task 2 + 4 desta).

- [ ] **Step 5: Commit**

```bash
git add src/services/orderSubmission/idempotency.ts src/services/orderSubmission/__tests__/idempotency.test.ts
git commit -m "feat(onda1/fase0): ensureSalesOrderRow (insert-or-get idempotente por checkout_id+account)"
```

---

## Task 4: Plumbar idempotência + origem em `submitOrder`

**Files:**
- Modify: `src/services/orderSubmission/types.ts`
- Modify: `src/services/orderSubmission/submitOrder.ts`

**Contexto:** Trocar os dois `.insert()` crus (Oben `:103-116`, Colacor `:192-205`) por `ensureSalesOrderRow`, e **pular o edge** quando `alreadySent`. Os blocos são quase idênticos. A `origem`/`checkout_id`/`atendimento_id` chegam por `params`. O bloco de afiação (`serviceItems`, via `syncOrderToOmie`) **não** muda (não escreve em `sales_orders` — fora do escopo).

- [ ] **Step 1: Adicionar campos a `SubmitOrderParams`**

Em `src/services/orderSubmission/types.ts`, dentro de `SubmitOrderParams` (após `isCustomerMode?`):

```ts
  /** Chave de idempotência por TENTATIVA de envio (estável entre retries do mesmo checkout). */
  checkoutId: string;
  /** Canal de origem do pedido: 'web_staff' | 'web_customer' | 'ligacao_sainte' | ... (Fase 1+). */
  origem: string;
  /** Liga a ligação (ou atendimento) aos N pedidos gerados. null na Fase 0 (Fase 1 preenche). */
  atendimentoId?: string | null;
```

- [ ] **Step 2: Importar o helper + destruturar os novos params em `submitOrder.ts`**

No topo de `src/services/orderSubmission/submitOrder.ts`, adicionar ao bloco de imports:

```ts
import { ensureSalesOrderRow } from './idempotency';
```

No destructuring de `params` (atualmente termina em `isCustomerMode = false,`), adicionar:

```ts
    checkoutId, origem, atendimentoId = null,
```

- [ ] **Step 3: Substituir o bloco de insert Oben**

Substituir TODO o bloco do insert Oben (de `let salesOrderId: string;` até o fim do `catch` que retorna `errors: [{ step: 'insert_oben', message }]`) por:

```ts
    let salesOrderId: string;
    let alreadySent: boolean;
    try {
      const ensured = await ensureSalesOrderRow(supabase, {
        checkoutId, account: 'oben', origem, atendimentoId,
        fields: {
          customer_user_id: customerUserId || user.id,
          created_by: user.id,
          items: itemsPayload,
          subtotal: subtotals.oben,
          total: subtotals.oben,
          notes: meta.notes || null,
          customer_address: storedAddress,
          customer_phone: storedPhone,
          ready_by_date: meta.readyByDate || null,
        },
      });
      salesOrderId = ensured.id;
      alreadySent = ensured.alreadySent;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Erro ao inserir pedido Oben';
      logger.critical('Failed to ensure sales_order in Supabase — aborting', {
        stage: 'supabase_insert',
        account: 'oben',
        customerId: customer.codigo_cliente,
        customerUserId: customerUserId || user.id,
        itemCount: obenProductItems.length,
        error: e,
      });
      return {
        success: false,
        results,
        printDataList: [],
        lastOrderData: null,
        errors: [{ step: 'insert_oben', message }],
      };
    }
```

E logo em seguida, **envolver o invoke do edge** num guard `alreadySent`. O bloco `try { const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {...}) ... }` vira:

```ts
    if (alreadySent) {
      // Idempotência: este checkout/conta já foi pro Omie numa tentativa anterior.
      // NÃO re-invocar o edge (evita 2ª chamada + protege a OP do bloco Colacor).
      results.push('PV Oben (já enviado)');
    } else {
      try {
        const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'criar_pedido', account: 'oben', sales_order_id: salesOrderId,
            codigo_cliente: customer.codigo_cliente,
            codigo_vendedor: customer.codigo_vendedor,
            items: obenProductItems.map(c => ({
              omie_codigo_produto: c.product.omie_codigo_produto,
              quantidade: c.quantity,
              valor_unitario: c.unit_price,
              descricao: c.product.descricao,
              ...(c.tint_cor_id ? { tint_cor_id: c.tint_cor_id, tint_nome_cor: c.tint_nome_cor } : {}),
            })),
            observacao: meta.notes,
            codigo_parcela: payment.parcelaOben,
            quantidade_volumes: volumes.oben || undefined,
            ordem_compra: meta.ordemCompra || undefined,
          },
        });
        if (!omieError) {
          results.push(`PV Oben ${omieResult?.omie_numero_pedido || ''}`);
        } else {
          results.push('PV Oben (pendente ERP)');
          errors.push({ step: 'sync_oben_omie', message: omieError.message || 'Falha ao sincronizar Oben com Omie' });
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Falha ao sincronizar Oben com Omie';
        logger.error('Oben Omie sync exception', {
          stage: 'omie_sync', account: 'oben', customerId: customer.codigo_cliente, salesOrderId, error: e,
        });
        results.push('PV Oben (pendente ERP)');
        errors.push({ step: 'sync_oben_omie', message });
      }
    }
```

- [ ] **Step 4: Substituir o bloco de insert Colacor (mesmo padrão)**

No bloco Colacor, substituir o `let salesOrderId: string; try { ...insert... } catch {...}` por `ensureSalesOrderRow` (igual ao Oben, trocando `account: 'colacor'`, `subtotals.colacor`, `colacorProductItems.length`, e `customerId: customer.codigo_cliente_colacor || customer.codigo_cliente`):

```ts
    let salesOrderId: string;
    let alreadySent: boolean;
    try {
      const ensured = await ensureSalesOrderRow(supabase, {
        checkoutId, account: 'colacor', origem, atendimentoId,
        fields: {
          customer_user_id: customerUserId || user.id,
          created_by: user.id,
          items: itemsPayload,
          subtotal: subtotals.colacor,
          total: subtotals.colacor,
          notes: meta.notes || null,
          customer_address: storedAddress,
          customer_phone: storedPhone,
          ready_by_date: meta.readyByDate || null,
        },
      });
      salesOrderId = ensured.id;
      alreadySent = ensured.alreadySent;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Erro ao inserir pedido Colacor';
      logger.critical('Failed to ensure sales_order in Supabase — aborting', {
        stage: 'supabase_insert', account: 'colacor',
        customerId: customer.codigo_cliente_colacor || customer.codigo_cliente,
        customerUserId: customerUserId || user.id,
        itemCount: colacorProductItems.length, error: e,
      });
      return {
        success: false, results, printDataList: [], lastOrderData: null,
        errors: [...errors, { step: 'insert_colacor', message }],
      };
    }
```

E envolver o invoke Colacor com o mesmo guard. **Importante:** o bloco da OP (`criar_ordem_producao`, dentro do `if (!omieError)`) fica **dentro** do `else { ... }` — então, quando `alreadySent`, o edge E a OP são pulados (a OP já foi criada na tentativa que enviou):

```ts
    if (alreadySent) {
      results.push('PV Colacor (já enviado)');
    } else {
      try {
        const { data: omieResult, error: omieError } = await supabase.functions.invoke('omie-vendas-sync', {
          body: {
            action: 'criar_pedido', account: 'colacor', sales_order_id: salesOrderId,
            codigo_cliente: customer.codigo_cliente_colacor!,
            codigo_vendedor: customer.codigo_vendedor_colacor ?? null,
            items: colacorProductItems.map(c => ({
              omie_codigo_produto: c.product.omie_codigo_produto,
              quantidade: c.quantity,
              valor_unitario: c.unit_price,
            })),
            observacao: meta.notes,
            codigo_parcela: payment.parcelaColacor,
            quantidade_volumes: volumes.colacor || undefined,
            ordem_compra: meta.ordemCompra || undefined,
          },
        });
        if (!omieError) {
          results.push(`PV Colacor ${omieResult?.omie_numero_pedido || ''}`);
          // ⬇️ MANTER o bloco existente de auto-create production orders (produto acabado)
          //    verbatim aqui dentro — ele não muda. (filtro produtoAcabadoItems + criar_ordem_producao)
        } else {
          results.push('PV Colacor (pendente ERP)');
          errors.push({ step: 'sync_colacor_omie', message: omieError.message || 'Falha ao sincronizar Colacor com Omie' });
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : 'Falha ao sincronizar Colacor com Omie';
        logger.error('Colacor Omie sync exception', {
          stage: 'omie_sync', account: 'colacor',
          customerId: customer.codigo_cliente_colacor || customer.codigo_cliente, salesOrderId, error: e,
        });
        results.push('PV Colacor (pendente ERP)');
        errors.push({ step: 'sync_colacor_omie', message });
      }
    }
```

> ⚠️ Preservar o bloco interno de `produtoAcabadoItems` / `criar_ordem_producao` **verbatim** dentro do `if (!omieError)` — só está indicado por comentário acima pra não repetir aqui. Não alterar sua lógica.

- [ ] **Step 5: Typecheck + testes + build**

```bash
bun run typecheck
heavy bun run test
```
Esperado: typecheck limpo (a falta de `checkoutId`/`origem` nos CALLERS do `submitOrder` que ainda não passam vai aparecer — o único caller real é `useUnifiedOrder` (Task 5); se o typecheck acusar lá, é esperado e resolvido na Task 5). Se houver outros callers (ex.: testes), atualizá-los. Confirmar que só `useUnifiedOrder.ts` falta.

- [ ] **Step 6: Commit**

```bash
git add src/services/orderSubmission/types.ts src/services/orderSubmission/submitOrder.ts
git commit -m "feat(onda1/fase0): submitOrder idempotente (ensureSalesOrderRow) + grava origem/atendimento_id"
```

---

## Task 5: Gerar `checkoutId` estável no caller + passar `origem`

**Files:**
- Modify: `src/hooks/useUnifiedOrder.ts`

**Contexto:** O `checkoutId` precisa ser **estável entre retries** do mesmo pedido (re-clicar "Enviar" após falha = mesmo `checkoutId`), e **resetar no sucesso** (próximo pedido = novo `checkoutId`). Um `useRef` resolve. A `origem` na Fase 0 = `'web_staff'`/`'web_customer'` (a origem da ligação chega na Fase 1). `atendimentoId` = `null` por ora.

- [ ] **Step 1: Adicionar o ref do checkout**

No corpo do hook `useUnifiedOrder` (junto das outras declarações de `useRef`/estado no topo do hook — `useRef` já é importado no arquivo), adicionar:

```ts
  // Idempotência: 1 checkout_id por TENTATIVA de envio, estável entre retries.
  // Reseta no sucesso (próximo pedido = novo id). Ver services/orderSubmission/idempotency.ts.
  const checkoutIdRef = useRef<string | null>(null);
```

- [ ] **Step 2: Gerar/passar no `submitOrder` + resetar no sucesso**

No `submitOrder` (useCallback em `:630`), logo após `setSubmitting(true);`:

```ts
    if (!checkoutIdRef.current) checkoutIdRef.current = crypto.randomUUID();
```

Na chamada `submitOrderService({ ... })`, adicionar os três campos (ex.: após `isCustomerMode,`):

```ts
        checkoutId: checkoutIdRef.current,
        origem: isCustomerMode ? 'web_customer' : 'web_staff',
        atendimentoId: null,
```

No ramo de sucesso (`if (result.success && result.lastOrderData) { ... }`), após `clearCart();`:

```ts
        checkoutIdRef.current = null; // sucesso → próximo pedido começa um novo checkout
```

- [ ] **Step 3: Typecheck + testes + build**

```bash
bun run typecheck
heavy bun run test
heavy bun run build
```
Esperado: tudo limpo (o caller agora satisfaz `SubmitOrderParams`).

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useUnifiedOrder.ts
git commit -m "feat(onda1/fase0): checkoutId estável por tentativa + origem web no useUnifiedOrder"
```

---

## Task 6: Chave de integração determinística no edge

**Files:**
- Create: `src/lib/omie/pedido-integration-code.ts`
- Test: `src/lib/omie/__tests__/pedido-integration-code.test.ts`
- Modify: `supabase/functions/omie-vendas-sync/index.ts`

**Contexto:** A chave atual `PV_${salesOrderId.substring(0, 8)}_${Date.now()}` (em `omie-vendas-sync`, `criarPedidoVenda`) é **não-determinística** (Date.now muda a cada chamada) e usa só 8 chars do UUID (colisão possível). Trocar por `PV_<uuid completo>` (39 chars < 60, o limite do Omie). Como o `salesOrderId` agora é estável entre retries (Tasks 3-5), a mesma chave é gerada → o Omie deduplica. Helper puro testável + espelho verbatim no edge (Deno não importa de `src/` — CLAUDE.md §5).

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/lib/omie/__tests__/pedido-integration-code.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildPedidoIntegrationCode } from '../pedido-integration-code';

describe('buildPedidoIntegrationCode', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';

  it('é determinístico (mesma entrada → mesma saída)', () => {
    expect(buildPedidoIntegrationCode(id)).toBe(buildPedidoIntegrationCode(id));
  });

  it('formato PV_<uuid completo> (sem timestamp, sem truncar)', () => {
    expect(buildPedidoIntegrationCode(id)).toBe(`PV_${id}`);
  });

  it('cabe no limite do Omie (< 60 chars)', () => {
    expect(buildPedidoIntegrationCode(id).length).toBeLessThan(60);
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

```bash
bun run test -- src/lib/omie/__tests__/pedido-integration-code.test.ts
```
Esperado: FALHA (módulo não existe).

- [ ] **Step 3: Implementar o helper**

Criar `src/lib/omie/pedido-integration-code.ts`:

```ts
/**
 * Código de integração determinístico do pedido de venda no Omie (cCodIntPed).
 * DETERMINÍSTICO por sales_order (sem Date.now, sem truncar): re-enviar o MESMO
 * sales_order_id produz o MESMO código → o Omie REJEITA codigo_pedido_integracao
 * repetido → não duplica. É o backstop server-side da idempotência (a camada client
 * garante que o retry reusa o mesmo sales_order_id via checkout_id + UNIQUE).
 * Formato: PV_<uuid> (3 + 36 = 39 chars < 60, limite do Omie).
 * ⚠️ ESPELHADO verbatim em supabase/functions/omie-vendas-sync/index.ts (Deno não
 *    importa de src/). Mudou aqui → mudar lá.
 */
export function buildPedidoIntegrationCode(salesOrderId: string): string {
  return `PV_${salesOrderId}`;
}
```

- [ ] **Step 4: Rodar e ver passar**

```bash
bun run test -- src/lib/omie/__tests__/pedido-integration-code.test.ts
```
Esperado: PASS (3 testes).

- [ ] **Step 5: Aplicar no edge (espelho)**

Em `supabase/functions/omie-vendas-sync/index.ts`, na função `criarPedidoVenda`, substituir a linha:

```ts
  const cCodIntPed = `PV_${salesOrderId.substring(0, 8)}_${Date.now()}`;
```

por:

```ts
  // Determinístico (espelha src/lib/omie/pedido-integration-code.ts): re-enviar o mesmo
  // sales_order_id gera a MESMA chave → o Omie deduplica (idempotência). NÃO usar Date.now()
  // nem substring (8 chars colidem). PV_<uuid> = 39 chars < 60 (limite Omie).
  const cCodIntPed = `PV_${salesOrderId}`;
```

- [ ] **Step 6: Typecheck (front) — o edge é Deno, não entra no tsc do app**

```bash
bun run typecheck
```
Esperado: limpo.

- [ ] **Step 7: Commit**

```bash
git add src/lib/omie/pedido-integration-code.ts src/lib/omie/__tests__/pedido-integration-code.test.ts supabase/functions/omie-vendas-sync/index.ts
git commit -m "feat(onda1/fase0): chave de integração determinística PV_<uuid> (idempotência no Omie)"
```

> ⚠️ **A chave determinística (T6) é a garantia de NÃO-DUPLICAÇÃO.** Sozinha (com Tasks 3-5) já elimina pedido duplicado: o caso comum (envio falhou antes do Omie / resposta perdida após o write-back server-side) é coberto pelo reuse + skip-se-`enviado`. A Task 7 só refina a **janela estreita** (Omie criou, write-back não completou): sem ela, o retry mostra erro "já cadastrado" (mas NÃO duplica); com ela, vira sucesso. **A T7 é gated em verificação do Omie — pode ser fast-follow sem comprometer a garantia.**

---

## Task 7: Reconciliação de duplicado no edge (gated em verificação)

**Files:**
- Create: `src/lib/omie/pedido-duplicate.ts`
- Test: `src/lib/omie/__tests__/pedido-duplicate.test.ts`
- Modify: `supabase/functions/omie-vendas-sync/index.ts`

**Contexto:** Na janela estreita (Omie criou o pedido com a chave determinística, mas o write-back em `sales_orders` não completou → linha fica `rascunho`), o retry re-invoca `IncluirPedido` com a MESMA chave → o Omie responde "já cadastrado". Em vez de virar `falha`, **reconciliar**: consultar o pedido por código de integração (`ConsultarPedido` já existe no edge, `:1567`, mas hoje só por `codigo_pedido` numérico) → fazer o write-back → retornar sucesso. Padrão do PR #628 (compras) aplicado a vendas.

> 🔴 **GATE DE VERIFICAÇÃO (money-path, founder via Lovable):** antes de finalizar, confirmar contra o Omie real **dois** fatos: (a) qual a `faultstring`/código exato que o `IncluirPedido` retorna para `codigo_pedido_integracao` duplicado; (b) que o `ConsultarPedido` (`produtos/pedido/`) aceita o filtro `codigo_pedido_integracao` (e não só `codigo_pedido`). Sem isso confirmado, **não fazer merge da T7** — as Tasks 1-6+8 já entregam a não-duplicação. Forma de verificar: reenviar 2× um pedido de teste em prod (após a T6 deployada) e capturar a resposta crua do 2º envio nos logs da edge (Lovable → Edge functions → omie-vendas-sync).

- [ ] **Step 1: Ler como o `callOmieVendasApi` trata fault do Omie**

Antes de implementar, ler em `supabase/functions/omie-vendas-sync/index.ts` a função `callOmieVendasApi` e o ponto pós-`IncluirPedido` (`:1355-1369`): descobrir se um fault do Omie (a) **lança** exceção, ou (b) **retorna** o objeto de fault. Isso decide se a detecção fica num `try/catch` (lança) ou num `if (isOmieDuplicatePedido(result))` (retorna). Anotar o resultado e ajustar o Step 4.

- [ ] **Step 2: Escrever o teste do detector (puro)**

Criar `src/lib/omie/__tests__/pedido-duplicate.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isOmieDuplicatePedido } from '../pedido-duplicate';

describe('isOmieDuplicatePedido', () => {
  it('detecta "já cadastrado" (com acento)', () => {
    expect(isOmieDuplicatePedido({ faultstring: 'O pedido já cadastrado para o código de integração.' })).toBe(true);
  });
  it('detecta "ja cadastrado" (sem acento)', () => {
    expect(isOmieDuplicatePedido({ faultstring: 'codigo de integracao ja cadastrado' })).toBe(true);
  });
  it('NÃO marca outros erros', () => {
    expect(isOmieDuplicatePedido({ faultstring: 'Cliente não encontrado' })).toBe(false);
  });
  it('robusto a null/forma inesperada', () => {
    expect(isOmieDuplicatePedido(null)).toBe(false);
    expect(isOmieDuplicatePedido({})).toBe(false);
    expect(isOmieDuplicatePedido('x')).toBe(false);
  });
});
```

> ⚠️ Ajustar as strings de teste conforme a `faultstring` REAL capturada no Gate de Verificação.

- [ ] **Step 3: Implementar o detector**

Criar `src/lib/omie/pedido-duplicate.ts`:

```ts
/**
 * Detecta se a resposta do Omie ao IncluirPedido indica codigo_pedido_integracao
 * DUPLICADO (uma tentativa anterior criou o pedido; o write-back não completou).
 * Tratado como reconciliação (consultar + vincular), não como falha.
 * ⚠️ ESPELHADO no edge omie-vendas-sync. As frases devem bater com a faultstring
 *    REAL do Omie (confirmar no Gate de Verificação da Task 7).
 */
export function isOmieDuplicatePedido(resp: unknown): boolean {
  if (!resp || typeof resp !== 'object') return false;
  const fs = (resp as { faultstring?: unknown }).faultstring;
  const msg = typeof fs === 'string' ? fs.toLowerCase() : '';
  return msg.includes('já cadastrad') || msg.includes('ja cadastrad')
    || (msg.includes('integra') && msg.includes('cadastrad'));
}
```

- [ ] **Step 4: Rodar o teste, depois implementar a reconciliação no edge**

```bash
bun run test -- src/lib/omie/__tests__/pedido-duplicate.test.ts
```
Esperado: PASS.

Depois, no `criarPedidoVenda` do edge, na falha pós-`IncluirPedido`, adicionar (forma conforme o Step 1 — exemplo para o caso "Omie retorna o fault no result"):

```ts
  // Reconciliação de idempotência: se a chave determinística já existe no Omie
  // (tentativa anterior criou o pedido mas o write-back falhou), consultar e vincular
  // em vez de falhar. (Espelha src/lib/omie/pedido-duplicate.ts.)
  function isOmieDuplicatePedido(r: unknown): boolean {
    if (!r || typeof r !== 'object') return false;
    const fs = (r as { faultstring?: unknown }).faultstring;
    const msg = typeof fs === 'string' ? fs.toLowerCase() : '';
    return msg.includes('já cadastrad') || msg.includes('ja cadastrad')
      || (msg.includes('integra') && msg.includes('cadastrad'));
  }

  // ... após o IncluirPedido, se detectar duplicado:
  if (isOmieDuplicatePedido(result)) {
    const consulta = await callOmieVendasApi(
      "produtos/pedido/", "ConsultarPedido",
      { codigo_pedido_integracao: cCodIntPed }, // ⚠️ confirmar no Gate que o Omie aceita este filtro
      account,
    ) as { pedido_venda_produto?: { cabecalho?: { codigo_pedido?: number; numero_pedido?: string } } } | null;
    const cab = consulta?.pedido_venda_produto?.cabecalho;
    if (cab?.codigo_pedido) {
      await supabase.from("sales_orders").update({
        omie_pedido_id: cab.codigo_pedido,
        omie_numero_pedido: String(cab.numero_pedido ?? cab.codigo_pedido),
        status: "enviado",
      }).eq("id", salesOrderId);
      return { omie_pedido_id: cab.codigo_pedido, omie_numero_pedido: cab.numero_pedido ?? cab.codigo_pedido, reconciled: true };
    }
  }
```

> A forma exata (try/catch vs if) depende do Step 1. O essencial: **detectar duplicado → consultar por `cCodIntPed` → write-back → retornar sucesso (não throw).**

- [ ] **Step 5: Typecheck + commit (após o Gate)**

```bash
bun run typecheck
git add src/lib/omie/pedido-duplicate.ts src/lib/omie/__tests__/pedido-duplicate.test.ts supabase/functions/omie-vendas-sync/index.ts
git commit -m "feat(onda1/fase0): reconciliação de pedido duplicado no Omie (idempotência completa)"
```

---

## Task 8: `currentParty` reativo no `WebRTCCallContext`

**Files:**
- Modify: `src/contexts/WebRTCCallContext.tsx`

**Contexto:** Hoje o cliente resolvido da ligação (`resolveCallParty`) fica só em variáveis locais do `makeCall`/inbound — **não é exposto reativamente** (a ponte/HUD da Fase 1 precisa dele pro `?customer=<user_id>`). Expor `currentParty` (set ao resolver, limpo ao voltar a idle) + `currentCustomerUserId` derivado. Totalmente frontend, independente das outras tasks.

- [ ] **Step 1: Importar o tipo + adicionar à interface**

Em `src/contexts/WebRTCCallContext.tsx`, o import de `:15` já traz `resolveCallParty`/`shouldAutoRecord` de `@/lib/call-log/recording-policy`. Adicionar o tipo:

```ts
import { resolveCallParty, shouldAutoRecord, type ResolvedCallParty } from '@/lib/call-log/recording-policy';
```

Na interface `WebRTCCallContextValue` (após `incomingCall`/`acceptIncoming`/`rejectIncoming`, antes do `}`):

```ts
  /** Cliente resolvido da ligação atual (BINA/telefone). null fora de ligação ou desconhecido. */
  currentParty: ResolvedCallParty | null;
  /** Atalho: user_id do cliente da ligação (pro deep-link ?customer=). null se não identificado. */
  currentCustomerUserId: string | null;
```

- [ ] **Step 2: Adicionar o state**

Após `const [incomingCall, setIncomingCall] = useState<IncomingCallInfo | null>(null);` (`:143`):

```ts
  const [currentParty, setCurrentParty] = useState<ResolvedCallParty | null>(null);
```

- [ ] **Step 3: Setar no outbound (`makeCall`)**

No `makeCall`, no bloco de reset (perto de `setError(null); setCallDuration(0);`, `:328-329`), adicionar:

```ts
    setCurrentParty(null);
```

E logo após `const party = await resolveCallParty(phoneNumber);` (`:347`):

```ts
    setCurrentParty(party);
```

- [ ] **Step 4: Setar no inbound**

No handler `client.on('incomingCall', ...)`, após `const party = await resolveCallParty(info.phone);` (`:209`):

```ts
          setCurrentParty(party);
```

- [ ] **Step 5: Limpar ao voltar a idle**

No `useEffect` que libera o dono em idle (`:562-564`), adicionar a limpeza junto:

```ts
  useEffect(() => {
    if (callState === 'idle') {
      setCallOwnerId(null);
      setCurrentParty(null);
    }
  }, [callState]);
```

- [ ] **Step 6: Expor no `value`**

No objeto `value` (`:566-594`), após `rejectIncoming,`:

```ts
    currentParty,
    currentCustomerUserId: currentParty?.customerUserId ?? null,
```

- [ ] **Step 7: Typecheck + build**

```bash
bun run typecheck
heavy bun run build
```
Esperado: limpo.

- [ ] **Step 8: Commit**

```bash
git add src/contexts/WebRTCCallContext.tsx
git commit -m "feat(onda1/fase0): expõe currentParty/currentCustomerUserId no WebRTCCallContext"
```

> **Nota de teste honesta:** Task 8 é wiring de contexto React em volta do SipClient — um teste unitário real seria desproporcional (precisa montar o provider + mockar SIP). A verificação é: `typecheck` + a Fase 1 (HUD) consumindo `currentCustomerUserId` + um smoke manual de 1 ligação (o cliente identificado aparece no contexto). Sem lógica pura nova a isolar aqui.

---

## Task 9: Rollout coordenado (founder, via Lovable)

**Files:** nenhum (operacional). Money-path → sequência importa.

> Nada disto acontece no merge (CLAUDE.md §5/§"Deploy do FRONTEND"). Sequência:

- [ ] **Step 1: Aplicar a migração (SQL Editor do Lovable)**

🟣 Lovable → SQL Editor → colar o conteúdo de `20260613120000_onda1_fase0_sales_orders_identidade.sql` → Run.

- [ ] **Step 2: Validar a migração (SQL Editor)**

```sql
SELECT
  (SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name='sales_orders'
       AND column_name IN ('origem','checkout_id','atendimento_id')) AS colunas_3,
  (SELECT count(*) FROM pg_indexes
     WHERE schemaname='public' AND indexname='sales_orders_checkout_account_uq') AS unique_idx_1,
  (SELECT count(*) FROM pg_indexes
     WHERE schemaname='public' AND indexname='idx_sales_orders_origem') AS origem_idx_1;
-- Esperado: colunas_3=3, unique_idx_1=1, origem_idx_1=1
```

- [ ] **Step 3: Redeploy do edge `omie-vendas-sync`**

Chat do Lovable: "Edit the existing edge function `omie-vendas-sync` — leia `supabase/functions/omie-vendas-sync/index.ts` da branch main e faça deploy verbatim (não reinterprete o código)." Confirmar **Active**. ⚠️ Deployar **só depois do merge** (deployar "da main" com PR aberto pega a main velha — lição recorrente do §5/§10).

- [ ] **Step 4: Publish do frontend**

Lovable → editor → Publish (sincronizar com GitHub antes se preciso). Sem isso, `steu.lovable.app` segue servindo o build velho.

- [ ] **Step 5: Smoke de não-duplicação (prod)**

Com um cliente de teste: criar 1 pedido Oben → confirmar 1 PV no Omie + a linha em `sales_orders` com `checkout_id` preenchido + `status='enviado'` + `origem='web_staff'`. Depois forçar um retry (re-clicar "Enviar" se a UI permitir, ou reinvocar) → confirmar que **NÃO** nasce um 2º PV no Omie (a 1ª linha é reusada/pulada). Conferir `SELECT checkout_id, account, status, omie_numero_pedido, origem FROM sales_orders WHERE checkout_id = '<o do teste>'`.

---

## Riscos residuais (registrados, fora do escopo da Fase 0)

- **Chave da OS de afiação** (`omie-sync`, `OS_..._${Date.now()}`) e do **cadastro de cliente** (`APP_..._${Date.now()}`) seguem não-determinísticas. Fora do escopo (o caminho da ligação é produto, não afiação). Follow-up se a afiação entrar numa onda futura.
- **OP (ordem de produção)** `OP_..._${Date.now()}`: deixa de ser risco de duplicação **vivo** após a Fase 0 (o skip-se-`enviado` não re-invoca `criar_pedido`, e a OP roda dentro do sucesso dele). A chave em si não foi trocada — registrar.
- **Edição de carrinho após envio parcial:** se a vendedora editar itens e reenviar com o MESMO `checkoutId` após uma falha em que o Omie JÁ recebeu, o skip-se-`enviado` mantém o pedido original (não aplica a edição). Editar pedido já enviado = fluxo de EDIÇÃO (separado), não reenvio. Aceitável na v1.
- **Reconciliação (T7) gated:** se não verificada a tempo, fica de fast-follow — a não-duplicação (T1-6+8) não depende dela.

---

## Self-Review (feito)

- **Cobertura do escopo da Fase 0 (§10 do spec):** `origem` ✅ (T1+T4+T5) · `atendimento_id`/`checkout_id` ✅ (T1+T3+T4+T5) · chave Omie determinística ✅ (T6) · unicidade/idempotência ✅ (T1+T3+T6, reconciliação T7) · `currentParty` no contexto ✅ (T8) · CMC RPC **adiada p/ Fase 2** (decisão registrada).
- **Placeholders:** nenhum — todo passo de código tem o código; os pontos verificáveis só no Omie estão isolados na T7 (gated) e marcados.
- **Consistência de tipos:** `decideSalesOrderAction(existing: {status} | null)` ↔ `ensureSalesOrderRow` passa `{id,status}` ✅ · `EnsureSalesOrderArgs.fields` ↔ colunas reais de `sales_orders` ✅ · `SubmitOrderParams` novos campos ↔ uso em `submitOrder.ts` ↔ caller em `useUnifiedOrder` ✅ · `buildPedidoIntegrationCode(salesOrderId)` ↔ edge `cCodIntPed` ✅ · `currentParty: ResolvedCallParty | null` ↔ import do tipo + value ✅.
- **Ordem/risco:** migração + helpers (sem efeito em prod) → submitOrder/caller (idempotência client) → edge (chave determinística) → reconciliação (gated) → context (independente) → rollout coordenado. A não-duplicação está garantida por T1-6 mesmo sem T7.
