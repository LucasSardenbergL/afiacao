# Identidade Omie por conta (derivada no servidor) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derivar/provar a identidade Omie (codigo_cliente/vendedor) por conta NO SERVIDOR (fronteira `criar_pedido`), ancorada no documento do cliente, fechando os 4 resíduos do P0-A e destravando a conversão de orçamento OBEN.

**Architecture:** A fronteira (edge `omie-vendas-sync`) deriva a identidade autoritativa de `(documento, account)` via espelho→Omie-por-documento→fail-closed, usa o derivado, e faz fail-closed em divergência/ambiguidade. Uma coluna `customer_document` em `sales_orders` dá a âncora confiável (imune ao fallback-vendedor `customer_user_id || user.id`); uma RPC `SECURITY DEFINER` faz o backfill do espelho com invariante atômica.

**Tech Stack:** Supabase (Postgres 17 + edge Deno), React/TS, vitest, `prove-sql-money-path` (PG17 local), `lovable-db-operator` + `lovable-deploy-verify` (deploys manuais).

**Spec:** [docs/superpowers/specs/2026-07-05-identidade-omie-por-conta-design.md](../specs/2026-07-05-identidade-omie-por-conta-design.md)

**Coordenação multi-sessão:** #1194 (P0-A) mergeada ✅, worktree rebasado ✅. PR #928 (`elastic-banzai`) toca `omie-vendas-sync/index.ts` na função de PULL (`syncPedidos`) — região diferente de `criar_pedido`/`alterar_pedido`; se #928 mergear antes, rebasar (conflito improvável). Migration nova: timestamp posterior aos existentes; conferir colisão antes de nomear.

---

## Ordem e granularidade

Ordem por dependência/risco: **SQL provado primeiro** (Task 1), depois a **decisão pura testável** (Task 2), depois a **fronteira** que as usa (Task 3), depois **âncora + conversão** (Task 4), depois **vias-cliente** (Task 5), por fim **verificação + follow-up** (Tasks 6-7). Commits frequentes.

---

### Task 1: Migration — coluna `customer_document` + RPC `omie_cliente_upsert_mapping` (prove-sql)

**Files:**
- Create: `supabase/migrations/2026070522XXXX_omie_identidade_por_conta.sql` (timestamp real via `date +%Y%m%d%H%M%S`; confirmar que não colide com migration paralela)
- Create (prove): `db/test-omie-identidade-backfill.sh` (harness PG17, espelha o padrão de `db/test-criar-pedidos-com-itens.sh`)

- [ ] **Step 1: Escrever a migration**

```sql
-- Âncora confiável do cliente por pedido (imune ao fallback customer_user_id || user.id).
ALTER TABLE public.sales_orders ADD COLUMN IF NOT EXISTS customer_document text;

-- Backfill guardado do espelho omie_clientes. Invariante money-path:
--  - insere se ausente (user_id, empresa);
--  - no-op se já existe com o MESMO código;
--  - 'contested' se existe com código DIFERENTE, ou se o código já é de OUTRO user na empresa
--    (NUNCA overwrite; identidade contestada → caller fail-closa o PV).
CREATE OR REPLACE FUNCTION public.omie_cliente_upsert_mapping(
  p_user_id uuid,
  p_empresa text,
  p_codigo_cliente bigint,
  p_codigo_vendedor bigint
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing_codigo bigint;
  v_owner uuid;
BEGIN
  IF p_user_id IS NULL OR p_empresa IS NULL OR p_codigo_cliente IS NULL THEN
    RAISE EXCEPTION 'omie_cliente_upsert_mapping: argumentos obrigatorios nulos';
  END IF;

  SELECT omie_codigo_cliente INTO v_existing_codigo
  FROM public.omie_clientes
  WHERE user_id = p_user_id AND empresa_omie = p_empresa;

  IF FOUND THEN
    IF v_existing_codigo = p_codigo_cliente THEN
      RETURN 'noop';
    END IF;
    RETURN 'contested';  -- (user,empresa) já mapeado a código diferente — não overwrite
  END IF;

  -- (codigo,empresa) já pertence a OUTRO user?
  SELECT user_id INTO v_owner
  FROM public.omie_clientes
  WHERE omie_codigo_cliente = p_codigo_cliente AND empresa_omie = p_empresa;
  IF FOUND AND v_owner <> p_user_id THEN
    RETURN 'contested';
  END IF;

  INSERT INTO public.omie_clientes (user_id, empresa_omie, omie_codigo_cliente, omie_codigo_vendedor)
  VALUES (p_user_id, p_empresa, p_codigo_cliente, p_codigo_vendedor);
  RETURN 'inserted';
EXCEPTION
  WHEN unique_violation THEN
    -- corrida com sync concorrente: trata como contested (não sobrescreve às cegas)
    RETURN 'contested';
END;
$$;

REVOKE ALL ON FUNCTION public.omie_cliente_upsert_mapping(uuid, text, bigint, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.omie_cliente_upsert_mapping(uuid, text, bigint, bigint) TO service_role;
```

- [ ] **Step 2: Escrever o teste prove-sql** (invocar a skill `prove-sql-money-path` para montar o harness a partir do template; asserts abaixo)

Cenários (cada um um assert; `pg_temp` no MESMO bloco psql):
1. tabela vazia → `omie_cliente_upsert_mapping(uA,'oben',100,9)` = `'inserted'` e cria 1 linha.
2. repetir idêntico → `'noop'` e continua 1 linha.
3. mesmo `(uA,'oben')` com código 200 → `'contested'` e a linha permanece 100 (SEM overwrite — assert `omie_codigo_cliente=100`).
4. `(uB,'oben',100,...)` (código 100 já é de uA) → `'contested'` e nenhuma linha nova de uB.
5. argumento nulo → captura `SQLSTATE` da EXCEPTION (assert negativo com re-raise do resto).
6. **Falsificar:** trocar o `RETURN 'contested'` do cenário 3 por `DO UPDATE` → o assert de "permanece 100" tem de ficar VERMELHO.

- [ ] **Step 3: Rodar o prove-sql e confirmar verde (e o vermelho da falsificação)**

Run: `bash db/test-omie-identidade-backfill.sh`
Expected: todos os asserts PASS; ao sabotar (Step 2.6), FAIL no assert de não-overwrite.

- [ ] **Step 4: Handoff lovable-db-operator** (gera o bloco pro SQL Editor + query de validação pós-apply + nota de PR + regenera o audit). NÃO aplicar em prod aqui — é o founder que cola no SQL Editor.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026070522XXXX_omie_identidade_por_conta.sql db/test-omie-identidade-backfill.sh
git commit -m "feat(vendas): migration customer_document + RPC backfill guardada (P0-B, prove-sql)"
```

---

### Task 2: Decisão de derivação — função pura testável + espelho no edge

**Files:**
- Create: `src/lib/omie/derive-account-identity.ts`
- Test: `src/lib/omie/derive-account-identity.test.ts`

- [ ] **Step 1: Escrever os testes falhando** (cobrem o threat-model do spec §5)

```ts
import { describe, it, expect } from 'vitest';
import { decideAccountIdentity } from './derive-account-identity';

const A = 'oben';
describe('decideAccountIdentity', () => {
  it('espelho com 1 código na conta → usa (source mirror)', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: 100,
      mirrorRows: [{ omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: A }], omieMatches: null });
    expect(r).toEqual({ ok: true, source: 'mirror', codigo_cliente: 100, codigo_vendedor: 9, backfill: false });
  });
  it('espelho vazio, sem omie ainda → pede Omie', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: null, mirrorRows: [], omieMatches: null });
    expect(r).toEqual({ ok: false, needOmie: true });
  });
  it('espelho vazio, Omie 1 match → usa + backfill', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: null, mirrorRows: [],
      omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }] });
    expect(r).toEqual({ ok: true, source: 'omie', codigo_cliente: 200, codigo_vendedor: 7, backfill: true });
  });
  it('Omie >1 match (duplicata-CNPJ) → fail-closed ambiguous', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: null, mirrorRows: [],
      omieMatches: [{ codigo_cliente: 200, codigo_vendedor: 7 }, { codigo_cliente: 201, codigo_vendedor: 7 }] });
    expect(r).toEqual({ ok: false, reason: 'ambiguous_omie' });
  });
  it('Omie 0 match (ausência confirmada) → fail-closed absent', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: null, mirrorRows: [], omieMatches: [] });
    expect(r).toEqual({ ok: false, reason: 'absent' });
  });
  it('espelho >1 código distinto → fail-closed ambiguous_mirror', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: null, omieMatches: null,
      mirrorRows: [{ omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: A },
                   { omie_codigo_cliente: 101, omie_codigo_vendedor: 9, empresa_omie: A }] });
    expect(r).toEqual({ ok: false, reason: 'ambiguous_mirror' });
  });
  it('divergência supplied != derived → fail-closed', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: 999,
      mirrorRows: [{ omie_codigo_cliente: 100, omie_codigo_vendedor: 9, empresa_omie: A }], omieMatches: null });
    expect(r).toEqual({ ok: false, reason: 'divergence' });
  });
  it('código não SafeInteger → fail-closed', () => {
    const r = decideAccountIdentity({ account: A, suppliedCodigo: null, omieMatches: [{ codigo_cliente: Number.MAX_SAFE_INTEGER + 1, codigo_vendedor: 1 }], mirrorRows: [] });
    expect(r).toEqual({ ok: false, reason: 'unsafe_integer' });
  });
});
```

- [ ] **Step 2: Rodar e ver falhar** — `heavy bun run test src/lib/omie/derive-account-identity.test.ts` → FAIL (módulo não existe).

- [ ] **Step 3: Implementar a função pura**

```ts
// MIRROR-START omie derive-account-identity — espelhado verbatim em supabase/functions/omie-vendas-sync/index.ts
// Decisão de identidade Omie por conta (money-path). PURA: recebe dados já buscados (espelho + Omie),
// decide o código autoritativo OU fail-closed. Precisão>recall: ambiguidade/ausência/divergência = reject.
export interface MirrorRow { omie_codigo_cliente: number; omie_codigo_vendedor: number | null; empresa_omie: string }
export interface OmieMatch { codigo_cliente: number; codigo_vendedor: number | null }
export interface DecideInput {
  account: string;
  suppliedCodigo: number | null;
  mirrorRows: ReadonlyArray<MirrorRow>;   // linhas de omie_clientes dos users do documento
  omieMatches: ReadonlyArray<OmieMatch> | null;  // buscarClienteVendas(regs:2); null = ainda não buscou
}
export type DecideResult =
  | { ok: true; source: 'mirror' | 'omie'; codigo_cliente: number; codigo_vendedor: number | null; backfill: boolean }
  | { ok: false; needOmie: true }
  | { ok: false; reason: 'ambiguous_mirror' | 'ambiguous_omie' | 'absent' | 'divergence' | 'unsafe_integer' };

const sameCode = (a: number, b: number) => String(a) === String(b); // bigint-safe (decimal canônico)

export function decideAccountIdentity(input: DecideInput): DecideResult {
  const { account, suppliedCodigo, mirrorRows, omieMatches } = input;

  // 1. Espelho, filtrado pela conta alvo
  const mirrorCodes = mirrorRows.filter((r) => r.empresa_omie === account);
  const distinct = [...new Map(mirrorCodes.map((r) => [String(r.omie_codigo_cliente), r])).values()];
  let cand: { codigo_cliente: number; codigo_vendedor: number | null; source: 'mirror' | 'omie'; backfill: boolean } | null = null;

  if (distinct.length === 1) {
    cand = { codigo_cliente: distinct[0].omie_codigo_cliente, codigo_vendedor: distinct[0].omie_codigo_vendedor, source: 'mirror', backfill: false };
  } else if (distinct.length > 1) {
    return { ok: false, reason: 'ambiguous_mirror' };
  } else {
    // 0 no espelho → precisa do Omie
    if (omieMatches === null) return { ok: false, needOmie: true };
    if (omieMatches.length > 1) return { ok: false, reason: 'ambiguous_omie' };
    if (omieMatches.length === 0) return { ok: false, reason: 'absent' };
    cand = { codigo_cliente: omieMatches[0].codigo_cliente, codigo_vendedor: omieMatches[0].codigo_vendedor, source: 'omie', backfill: true };
  }

  // 2. Segurança bigint
  if (!Number.isSafeInteger(cand.codigo_cliente) || cand.codigo_cliente <= 0) return { ok: false, reason: 'unsafe_integer' };

  // 3. Divergência (código do cliente é advisory)
  if (suppliedCodigo != null && !sameCode(suppliedCodigo, cand.codigo_cliente)) return { ok: false, reason: 'divergence' };

  return { ok: true, source: cand.source, codigo_cliente: cand.codigo_cliente, codigo_vendedor: cand.codigo_vendedor, backfill: cand.backfill };
}
// MIRROR-END
```

- [ ] **Step 4: Rodar e ver passar** — `heavy bun run test src/lib/omie/derive-account-identity.test.ts` → PASS (8/8).

- [ ] **Step 5: Adicionar a paridade textual no CI** — em `src/__tests__/edge-money-path-invariants.test.ts`, acrescentar o par MIRROR `derive-account-identity` (src × edge), no mesmo molde do bloco `account-coherence`/`mergeCustomerPrices` existente.

- [ ] **Step 6: Commit**

```bash
git add src/lib/omie/derive-account-identity.ts src/lib/omie/derive-account-identity.test.ts src/__tests__/edge-money-path-invariants.test.ts
git commit -m "feat(vendas): decisao pura de identidade Omie por conta + testes threat-model (P0-B)"
```

---

### Task 3: Fronteira — derivação em `criar_pedido` (+ `alterar_pedido` verify) no edge

**Files:**
- Modify: `supabase/functions/omie-vendas-sync/index.ts` (dispatcher `criar_pedido` ~L2201; `alterar_pedido` ~L2262; espelhar o bloco `decideAccountIdentity` MIRROR perto do `codeBelongsToWrongAccount` existente)

- [ ] **Step 1: Espelhar a função pura no edge** — colar o bloco `MIRROR-START/END decideAccountIdentity` (idêntico ao de Task 2 Step 3) junto dos outros mirrors do arquivo (topo, perto de `codeBelongsToWrongAccount`).

- [ ] **Step 2: Adicionar o helper de IO de derivação** (logo antes do dispatcher `serve`), que orquestra espelho→Omie→decisão:

```ts
async function deriveOmieAccountIdentity(
  supabase: SupabaseClient,
  soRow: { customer_user_id: string | null; customer_document: string | null },
  account: Account,
  suppliedCodigo: number | null,
): Promise<{ codigo_cliente: number; codigo_vendedor: number | null }> {
  // Âncora = documento (imune ao fallback customer_user_id || user.id)
  let doc = (soRow.customer_document || '').replace(/\D/g, '');
  if (!doc && soRow.customer_user_id) {
    const { data: prof } = await supabase.from('profiles').select('document').eq('user_id', soRow.customer_user_id).maybeSingle();
    doc = (prof?.document || '').replace(/\D/g, '');
  }
  if (!doc) throw new Error('Pedido rejeitado: sem documento do cliente para derivar a identidade Omie da conta — envio bloqueado.');

  // Users com esse documento → linhas do espelho na conta
  const { data: users } = await supabase.from('profiles').select('user_id').eq('document', doc);
  const userIds = (users ?? []).map((u) => u.user_id);
  const mirrorRows = userIds.length
    ? (await supabase.from('omie_clientes').select('omie_codigo_cliente, omie_codigo_vendedor, empresa_omie').in('user_id', userIds).eq('empresa_omie', account)).data ?? []
    : [];

  let decision = decideAccountIdentity({ account, suppliedCodigo, mirrorRows, omieMatches: null });
  if (!decision.ok && 'needOmie' in decision) {
    // registros_por_pagina:2 → detectar duplicata-CNPJ (fail-closed em >1)
    const omie = await buscarClienteVendasMatches(doc, account); // regs:2 (Task 3 Step 3)
    decision = decideAccountIdentity({ account, suppliedCodigo, mirrorRows, omieMatches: omie });
  }
  if (!decision.ok) {
    const reason = 'reason' in decision ? decision.reason : 'unknown';
    throw new Error(`Pedido rejeitado: identidade Omie do cliente na conta ${account} não pôde ser provada (${reason}) — envio bloqueado.`);
  }

  // Backfill gated: só derivação por Omie (inequívoca) e com user confiável (o dono do documento)
  if (decision.backfill && userIds.length === 1) {
    const { data: status } = await supabase.rpc('omie_cliente_upsert_mapping', {
      p_user_id: userIds[0], p_empresa: account, p_codigo_cliente: decision.codigo_cliente, p_codigo_vendedor: decision.codigo_vendedor,
    });
    if (status === 'contested') {
      throw new Error(`Pedido rejeitado: identidade Omie contestada no espelho (conta ${account}) — envio bloqueado.`);
    }
  }
  return { codigo_cliente: decision.codigo_cliente, codigo_vendedor: decision.codigo_vendedor };
}
```

- [ ] **Step 3: Adicionar `buscarClienteVendasMatches`** (variante de `buscarClienteVendas` com `registros_por_pagina: 2`, `throwOnTransient: true`, retornando o array de matches `{codigo_cliente, codigo_vendedor}` — reusa `callOmieVendasApi`; ver `buscarClienteVendas` L596 como molde).

- [ ] **Step 4: Ligar no `criar_pedido`** — no dispatcher (após o guard P0-A, L2239), (a) estender o select de `soRow` para incluir `customer_document`; (b) inserir a derivação; (c) usar o derivado; (d) tornar `codigo_cliente` opcional:

```ts
// L2203: remover a exigência de codigo_cliente (agora derivado no servidor)
if (!sales_order_id || !items?.length) { throw new Error("Dados insuficientes para criar pedido de venda"); }
// L2211-2215: soRow passa a selecionar também customer_document
.select("account, customer_user_id, customer_document")
// ... após o guard P0-A (L2239): DERIVAÇÃO (prova positiva, fail-closed)
const ident = await deriveOmieAccountIdentity(supabaseAdmin, soRow ?? { customer_user_id: null, customer_document: null }, account, codigo_cliente ?? null);
// usar ident.* daqui pra frente (substitui o codigo_cliente/codigo_vendedor do payload):
const credito = await gateCredito(supabaseAdmin, account, ident.codigo_cliente, sales_order_id, userId, "criacao");
// ...
const pedido = await criarPedidoVenda(supabaseAdmin, sales_order_id, ident.codigo_cliente, ident.codigo_vendedor, items, observacao, codigo_parcela, account, quantidade_volumes, ordem_compra, dados_adicionais_nf, numero_pedido_cliente);
```

- [ ] **Step 5: Guard `alterar_pedido` (verify-before-edit)** — no handler `alterar_pedido` (~L2262), após obter `omieCodigoClienteEdit` do `ConsultarPedido` e ANTES da fase destrutiva, derivar a identidade esperada de `(existingOrder.customer_document/…, editAccount)` e comparar; divergência → throw fail-closed (nada mutado). Reusar `deriveOmieAccountIdentity` passando `suppliedCodigo: omieCodigoClienteEdit` (a divergência já vira reject na função pura).

- [ ] **Step 6: Verificar compilação/tipos** — `heavy bun run typecheck`. Expected: PASS. (Edge Deno não roda no typecheck do app, mas o mirror TS espelhado sim via os testes de paridade.)

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/omie-vendas-sync/index.ts
git commit -m "feat(vendas): deriva identidade Omie na fronteira criar_pedido + verify em alterar_pedido (P0-B)"
```

---

### Task 4: Âncora (`customer_document`) + conversão OBEN destravada

**Files:**
- Modify: `src/services/orderSubmission/submitQuote.ts` (inserts oben ~L57, colacor ~L102)
- Modify: `src/services/orderSubmission/submitOrder.ts` (inserts oben/colacor)
- Modify: `src/pages/SalesQuotes.tsx` (`convertToOrder`)
- Test: `src/pages/__tests__/SalesQuotes.priceGuard.test.tsx` (estender) ou novo teste de convertToOrder

- [ ] **Step 1: Persistir `customer_document` nos inserts** — em `submitQuote.ts` e `submitOrder.ts`, acrescentar ao objeto do `.insert(...)`: `customer_document: (customer.cnpj_cpf || '').replace(/\D/g, '') || null,` (o documento do cliente REAL da seleção, não do vendedor).

- [ ] **Step 2: Simplificar `convertToOrder`** — remover o bloco que lê `omie_clientes` por `user_id` e o fail-closed associado (o edge deriva); no `invoke('omie-vendas-sync')`, remover `codigo_cliente`/`codigo_vendedor` do body. Novo body:

```ts
body: { action: 'criar_pedido', account, sales_order_id: quote.id, items, observacao: quote.notes }
```

Manter o guard de preço inválido (findInvalidPricedOmieItems) e o update de status. A mensagem de erro do edge (identidade não provada) já é acionável.

- [ ] **Step 3: Teste** — teste de que `convertToOrder` NÃO lê mais `omie_clientes` e chama o edge sem `codigo_cliente` (mock do supabase client; asserta o shape do body). E que um quote OBEN (que antes fail-closava) agora chega ao invoke.

- [ ] **Step 4: Rodar testes** — `heavy bun run test src/pages/__tests__/SalesQuotes` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/orderSubmission/submitQuote.ts src/services/orderSubmission/submitOrder.ts src/pages/SalesQuotes.tsx src/pages/__tests__/SalesQuotes.priceGuard.test.tsx
git commit -m "feat(vendas): persiste customer_document + destrava conversao OBEN (edge deriva) (P0-B)"
```

---

### Task 5: Vias-cliente — filtro `empresa_omie` (itens 2/3) + bigint helper (item 4)

**Files:**
- Modify: `src/hooks/unifiedOrder/useCustomerSelection.ts` (:207 busca, :243 resolveLocalUserId)
- Modify: `src/hooks/useUnifiedOrder.ts` (`handleAICustomerSelect` ~L505)
- Modify: `supabase/functions/analyze-unified-order/index.ts` (:262 modo imagem, :301 modo texto)
- Modify: `src/lib/omie/account-coherence.ts` (bigint) + `src/lib/omie/account-coherence.test.ts`

- [ ] **Step 1: `useCustomerSelection` filtro por conta** — nos dois lookups em `omie_clientes`, acrescentar `.eq('empresa_omie', 'oben')` (a busca de clientes usa a conta oben por padrão). *Fail-safe:* hoje 0 linhas oben → não mapeia (cai no match por documento em `resolveLocalUserId`), o que é o comportamento correto (sem colisão cross-conta).

- [ ] **Step 2: `analyze-unified-order` — não emitir código cross-conta** — nos dois pontos (:262/:301), parar de anexar `omie_codigo_cliente` do espelho ao candidato (`codigo_cliente: null`), já que o edge deriva e o código só serve display; evita rotular um código colacor como genérico.

- [ ] **Step 3: `handleAICustomerSelect` — re-resolver por documento** — não confiar em `customer.codigo_cliente` recebido da IA; quando houver `user_id`/documento, deixar a resolução por-conta acontecer no `selectCustomer`/edge. (Como o edge é autoritativo, basta não fixar `codigo_cliente` a partir da IA.)

- [ ] **Step 4: `account-coherence.ts` bigint** — trocar as comparações `Number(r.omie_codigo_cliente) === code` por comparação de string decimal canônica; guardar `!Number.isSafeInteger(code)` no início. Atualizar o bloco espelhado no edge (paridade CI) e os testes com um caso `> MAX_SAFE_INTEGER`.

```ts
export function codeBelongsToWrongAccount(rows, code, account): boolean {
  if (!Number.isSafeInteger(code) || code <= 0) return false;
  const eq = (a: number) => String(a) === String(code);
  if (rows.some((r) => eq(r.omie_codigo_cliente) && r.empresa_omie === account)) return false;
  return rows.some((r) => eq(r.omie_codigo_cliente) && r.empresa_omie !== account);
}
```

- [ ] **Step 5: Rodar testes + typecheck** — `heavy bun run test src/lib/omie && heavy bun run typecheck` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/unifiedOrder/useCustomerSelection.ts src/hooks/useUnifiedOrder.ts supabase/functions/analyze-unified-order/index.ts src/lib/omie/account-coherence.ts src/lib/omie/account-coherence.test.ts
git commit -m "fix(vendas): filtro empresa_omie nas vias-cliente + bigint-safe (itens 2/3/4, P0-B)"
```

---

### Task 6: Verificação money-path (health + Codex + deploy)

- [ ] **Step 1: Health stack** — `heavy bun run test && heavy bun run typecheck && bun lint && bunx knip`. Expected: verde. Corrigir o que aparecer.
- [ ] **Step 2: Paridade dos mirrors** — confirmar que o CI `edge-money-path-invariants` cobre `decideAccountIdentity` e `codeBelongsToWrongAccount` (src × edge idênticos).
- [ ] **Step 3: Codex adversarial no diff** — `/codex challenge --xhigh` (money-path). Endereçar todo [P1]; registrar [P2] no PR.
- [ ] **Step 4: Deploy-verify** — invocar `lovable-deploy-verify`: (a) migration via SQL Editor (Task 1 handoff) + query de validação; (b) edge `omie-vendas-sync` + `analyze-unified-order` via chat do Lovable (ler do repo verbatim); (c) frontend Publish. Verificar bytes do bundle.
- [ ] **Step 5: Prova de comportamento em prod** — após deploy, um quote OBEN de teste converte (antes fail-closava); conferir `net._http_response`/log do edge que a derivação rodou.

---

### Task 7: Follow-up documentado (fora do money-path agora)

- [ ] **Step 1:** Registrar em `docs/historico/bugs-resolvidos.md` a entrega P0-B e abrir issue/nota dos ~13 consumidores de `omie_clientes` sem `empresa_omie` (customer360 hooks, useBuscaClienteOmie, FarmerCalls, SalesPrintDashboard, compare-customer-process, carteira-rebuild, e os INSERTs `Auth.tsx:129`/`AdminApprovals.tsx:109` que não setam `empresa_omie`).
- [ ] **Step 2: Commit** da nota/doc.

---

## Self-review (cobertura do spec)

- §4.1 customer_document → Task 1 (coluna) + Task 4 (persistência). ✅
- §4.2 derivação (espelho→Omie→fail-closed) → Task 2 (pura) + Task 3 (IO/edge). ✅
- §4.3 divergência fail-closed → Task 2 (`divergence`) + Task 3 (advisory). ✅
- §4.4 backfill RPC + gating → Task 1 (RPC/prove) + Task 3 Step 2 (gated). ✅
- §4.5 alterar_pedido verify → Task 3 Step 5. ✅
- §4.6 conversão OBEN → Task 4 Step 2. ✅
- §4.7 vias-cliente + bigint → Task 5. ✅
- §5 threat-model → Task 2 (asserts) + Task 1 (RPC asserts). ✅
- §7 prova → Task 1 (prove-sql) + Task 2 (vitest) + Task 6 (Codex/deploy). ✅
- §8 follow-up → Task 7. ✅
