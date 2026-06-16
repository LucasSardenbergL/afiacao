# Cobertura de CMC no catálogo — sync de inventário com `cExibeTodos` — Plano

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Popular `inventory_position` (e o `cmc`) para o catálogo OBEN inteiro — inclusive itens com saldo 0 — via uma rotina diária dedicada, sem tornar pesado o sync de saldo de 30 min.

**Architecture:** Nova rotina `syncInventoryFull` no edge `omie-analytics-sync`: `ListarPosEstoque` com `cExibeTodos:"S"` + leituras em massa (bulk, mata o N+1 atual de ~5 queries/produto) + upsert em lote, rodando em **background** (`EdgeRuntime.waitUntil`, padrão do `sync_customers`). Nova action `sync_inventory_full` + cron diário. O `callOmie` já tem retry/backoff. O sync de 30 min (`sync_inventory`) fica intacto.

**Tech Stack:** Supabase Edge Function (Deno/TS), Omie API (`ListarPosEstoque`), pg_cron + pg_net (migration via Lovable SQL Editor). Spec: `docs/superpowers/specs/2026-06-06-sync-cmc-cobertura-catalogo-design.md`.

> **Nota sobre testes:** este fix é I/O puro (Omie → tabela, cópia 1:1 do `nCMC`, sem lógica de decisão/cálculo). Não há helper puro que valha TDD vitest. A verificação é: **lint** (o CI linta `supabase/functions/`), **`deno check` best-effort**, e o **probe em produção** (Task 5) — os 8 SKUs de alto giro passam a ter `cmc > 0` e a contagem salta de ~738 → ~catálogo. Isso é o gate de comportamento real.

---

## Estrutura de arquivos

- **Modify** `supabase/functions/omie-analytics-sync/index.ts` — adiciona `syncInventoryFull()` (perto do `syncInventory` existente, ~linha 788) + `case "sync_inventory_full"` no handler de actions (~linha 1081). Não toca o `syncInventory` de 30 min.
- **Create** `supabase/migrations/20260606240000_cron_sync_inventory_full.sql` — cron diário.
- **Deploy** do edge via chat do Lovable (após merge) + apply da migration via SQL Editor.

---

## Task 1: Gate de validação do `nCMC`-com-saldo-0

Pré-condição do fix: confirmar que o Omie retorna o `nCMC` para item com saldo 0 (senão `cExibeTodos:"S"` traria itens sem custo).

- [ ] **Step 1: Validação no Omie (founder)**

Abrir no Omie o produto VERNIZ FO20.6717 (`8689783623`), que tem saldo 0, e confirmar se o campo **Custo Médio** aparece preenchido. Indício já coletado: a única linha de `inventory_position` com saldo 0 tem `cmc > 0` (n=1).

- [ ] **Step 2: Decisão**

Se o Custo Médio aparece → caminho A validado, seguir. Se NÃO aparece → **parar** e reabrir o spec (fonte alternativa de custo). Em qualquer caso, a Task 5 (probe pós-deploy) é a confirmação definitiva em massa.

> Esta task não tem código — é o gate. Pode ser feita em paralelo às Tasks 2-4 (que preparam o código), mas o **deploy/cron (Task 5) só após o gate passar** (ou aceitar o risco do probe).

---

## Task 2: Implementar `syncInventoryFull` + action

**Files:**
- Modify: `supabase/functions/omie-analytics-sync/index.ts`

- [ ] **Step 1: Adicionar a função `syncInventoryFull` logo após o `syncInventory` (após a linha 788, antes de `// ======== COMPUTE COSTS`)**

```typescript
// ======== SYNC INVENTORY FULL (catálogo inteiro, p/ cobertura de CMC) ========
// Diferente do syncInventory (30 min, só itens COM saldo): usa cExibeTodos:"S" pra trazer
// o catálogo inteiro (inclusive saldo 0) e popular o cmc. Bulk (sem o N+1 do syncInventory)
// + roda em background (waitUntil) por causa do volume (~5x). Foco: inventory_position.cmc
// (fonte de custo do EOQ da Reposição). NÃO toca product_costs/omie_products (não-objetivo v1).
async function syncInventoryFull(db: SupabaseClient, account: OmieAccount) {
  await updateSyncState(db, "inventory_full", account, { status: "running", error_message: null });
  try {
    // 1) Map omie_products: omie_codigo_produto -> id (bulk paginado, fura o cap de 1000 do PostgREST)
    const idMap = new Map<number, string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from("omie_products")
        .select("id, omie_codigo_produto")
        .range(from, from + 999);
      if (error) throw error;
      const rows = data ?? [];
      for (const r of rows) idMap.set(Number(r.omie_codigo_produto), r.id as string);
      if (rows.length < 1000) break;
    }

    // 2) Paginar ListarPosEstoque com cExibeTodos:"S" (callOmie já tem retry/backoff p/ falha transitória)
    let pagina = 1;
    let totalPaginas = 1;
    let totalSynced = 0;
    const invRows: Array<{
      omie_codigo_produto: number;
      product_id: string | null;
      saldo: number;
      cmc: number;
      preco_medio: number;
      account: string;
      synced_at: string;
    }> = [];
    while (pagina <= totalPaginas) {
      const result = (await callOmie(account, "estoque/consulta/", "ListarPosEstoque", {
        nPagina: pagina,
        nRegPorPagina: 100,
        dDataPosicao: new Date().toLocaleDateString("pt-BR"),
        cExibeTodos: "S",
      })) as unknown as OmieListarPosEstoqueResponse;

      totalPaginas = result.nTotPaginas || 1;
      const now = new Date().toISOString();
      for (const prod of result.produtos || []) {
        const codProd = prod.nCodProd;
        if (!codProd) continue;
        invRows.push({
          omie_codigo_produto: codProd,
          product_id: idMap.get(codProd) ?? null,
          saldo: prod.nSaldo ?? 0,
          cmc: prod.nCMC ?? 0,
          preco_medio: prod.nPrecoMedio ?? 0,
          account,
          synced_at: now,
        });
        totalSynced++;
      }
      console.log(`[Sync ${account}] inventory_full página ${pagina}/${totalPaginas} — ${totalSynced} itens acumulados`);
      pagina++;
    }

    // 3) Upsert em lote (chunks de 500) — onConflict igual ao syncInventory
    const CHUNK = 500;
    for (let i = 0; i < invRows.length; i += CHUNK) {
      const slice = invRows.slice(i, i + CHUNK);
      const { error } = await db
        .from("inventory_position")
        .upsert(slice, { onConflict: "omie_codigo_produto,account" });
      if (error) throw error;
    }

    await updateSyncState(db, "inventory_full", account, {
      status: "complete",
      total_synced: totalSynced,
      last_sync_at: new Date().toISOString(),
      last_page: totalPaginas,
    });
    return { totalSynced };
  } catch (error) {
    await updateSyncState(db, "inventory_full", account, { status: "error", error_message: String(error) });
    throw error;
  }
}
```

- [ ] **Step 2: Adicionar a action no handler `switch` (logo após o `case "sync_inventory":` que termina na linha ~1081)**

Espelha o padrão de background do `case "sync_customers"` (resposta 202 + `waitUntil`):

```typescript
      case "sync_inventory_full": {
        // Guard de UX "já em andamento" (não duplica o trabalho de catálogo se um run ainda roda).
        const { data: stFull } = await supabaseAdmin
          .from("sync_state")
          .select("status, last_sync_at, updated_at")
          .eq("entity_type", "inventory_full")
          .eq("account", account)
          .maybeSingle();
        const startedAt = stFull?.updated_at ? new Date(stFull.updated_at).getTime() : 0;
        const running = stFull?.status === "running" && (Date.now() - startedAt) < 30 * 60 * 1000;
        if (running) {
          return new Response(JSON.stringify({ accepted: false, reason: "already_running" }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const bgTask = syncInventoryFull(supabaseAdmin, account as OmieAccount).catch((e) => {
          console.error("[sync_inventory_full][bg]", e instanceof Error ? e.message : e);
        });
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore - EdgeRuntime existe no runtime do Supabase Edge
        if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          EdgeRuntime.waitUntil(bgTask);
        }
        return new Response(JSON.stringify({ accepted: true, background: true }), {
          status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
```

- [ ] **Step 3: Verificar lint + deno check (best-effort)**

Run: `heavy bun lint > /tmp/lint.log 2>&1; echo "lint=$?"; tail -5 /tmp/lint.log`
Expected: `lint=0` (sem novos erros). O CI linta `supabase/functions/` — erros de lint bloqueiam o PR.

Run (best-effort, pode ter erros de typing pré-existentes do supabase-js — comparar com o set da main, não consertar pré-existentes): `cd supabase/functions && deno check omie-analytics-sync/index.ts 2>&1 | tail -10 || true`

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/omie-analytics-sync/index.ts
git commit -m "feat(reposição): syncInventoryFull — cobre o catálogo com cExibeTodos:S (bulk + background) p/ popular CMC"
```

---

## Task 3: Migration do cron diário

**Files:**
- Create: `supabase/migrations/20260606240000_cron_sync_inventory_full.sql`

Usa a skill `lovable-db-operator` (apply manual via SQL Editor).

- [ ] **Step 1: Criar o arquivo de migration**

```sql
-- Cron diário: cobre o catálogo OBEN (conta vendas) com cExibeTodos:S pra popular o CMC em
-- inventory_position. Roda 04:00 (madrugada, fora do pico). O edge responde 202 e processa em
-- background (waitUntil) — timeout curto do net.http_post só cobre o ACK, não o processamento.
-- Idempotente (upsert por nome). Mantém o sync de saldo de 30 min (sync-inventory-vendas-30m) intacto.
SELECT cron.schedule(
  'sync-inventory-full-vendas-daily',
  '0 4 * * *',
  $$SELECT net.http_post(
    url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-analytics-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET' LIMIT 1)),
    body:='{"action": "sync_inventory_full", "account": "vendas"}'::jsonb,
    timeout_milliseconds := 60000
  );$$
);

-- Validação:
SELECT 'CRON_INV_FULL' AS bloco,
  (SELECT count(*) FROM cron.job WHERE jobname = 'sync-inventory-full-vendas-daily') AS cron_criado; -- esperado 1
```

- [ ] **Step 2: Entregar o bloco SQL na conversa (Lovable → SQL Editor)** e aguardar o founder confirmar `cron_criado=1`.

- [ ] **Step 3: Regenerar o audit e commitar**

```bash
bun run audit:migrations
git add supabase/migrations/20260606240000_cron_sync_inventory_full.sql docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "chore(reposição): cron diário sync-inventory-full (cobertura de CMC do catálogo)"
```

---

## Task 4: Verificação final (deploy + probe + medição)

> Pós-merge. Depende do deploy do edge (chat do Lovable) + apply do cron (Task 3).

- [ ] **Step 1: Deploy do edge** — instruir o founder a pedir ao chat do Lovable para ler `supabase/functions/omie-analytics-sync/index.ts` da main e deployar verbatim (action nova `sync_inventory_full`).

- [ ] **Step 2: Disparar 1 run manual** (chat do Lovable ou aguardar o cron das 04h): `{"action":"sync_inventory_full","account":"vendas"}` → deve responder 202.

- [ ] **Step 3: Probe — os 8 SKUs de alto giro agora têm CMC** (SQL Editor):

```sql
SELECT omie_codigo_produto, saldo, cmc, synced_at::date AS sync
FROM inventory_position
WHERE account = 'vendas'
  AND omie_codigo_produto IN (8689783623,8689731064,8689736464,8689717817,
                              11978471025,8689783074,8689775138,8689774806)
ORDER BY omie_codigo_produto;
```

Esperado: os 8 agora com **linha** e `cmc > 0` (se `cmc = 0`, o nCMC-com-saldo-0 falhou → reabrir o spec).

- [ ] **Step 4: Medir a cobertura (antes ~738 → depois ~catálogo)** e o tempo do run (logs do edge):

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE cmc > 0) AS com_cmc,
       count(*) FILTER (WHERE saldo <= 0) AS saldo_zerado
FROM inventory_position WHERE account = 'vendas';
```

Esperado: `total` salta de ~738 para o tamanho do catálogo OBEN (~milhares), com `saldo_zerado` agora alto (os zerados entraram). Registrar o tempo do background nos logs do edge (medir o impacto real do volume, conforme o risco do spec §7).

---

## Self-Review

**Cobertura do spec:**
- §4.1 `cExibeTodos:"S"` → Task 2 Step 1 (no payload do `ListarPosEstoque`). ✓
- §4.2 bulk (mata N+1) → Task 2 Step 1 (idMap + upsert em lote, sem query por produto). ✓
- §4.3 background (`waitUntil`) → Task 2 Step 2 (espelha `sync_customers`). ✓
- §4.4 retry → já no `callOmie` (nota no header do plano). ✓
- §4.5 paginação (`nTotPaginas`, start em 1) → Task 2 Step 1. ✓
- §4.6 guard de concorrência → Task 2 Step 2 (guard `already_running` por `sync_state`). ✓
- §4 "sync de 30 min intacto" → não tocado (`syncInventory` permanece; entity `inventory_full` separada). ✓
- §5 escopo `vendas`/OBEN primeiro → Task 3 (cron só `vendas`). ✓
- §6 gate nCMC → Task 1 + Task 4 Step 3 (probe). ✓
- §7 medir volume → Task 4 Step 4. ✓
- §8 não-objetivos (product_costs/omie_products fora) → Task 2 Step 1 (comentário explícito). ✓

**Placeholder scan:** sem TODO/TBD; todo código presente.

**Consistência de tipos:** `syncInventoryFull(db, account)` assinatura igual ao `syncInventory`; reusa `OmieListarPosEstoqueResponse`, `callOmie`, `updateSyncState`, `OmieAccount`, `corsHeaders` (todos já no arquivo). Entity `"inventory_full"` no `sync_state` (separada de `"inventory"`). Action `"sync_inventory_full"` consistente entre handler (Task 2), cron (Task 3) e run manual (Task 4).

**Riscos para o executor:**
- Confirmar que `OmieListarPosEstoqueResponse` tem `nTotPaginas`, `produtos[]`, e o item tem `nCodProd/nSaldo/nCMC/nPrecoMedio` (já usados pelo `syncInventory` existente — Task 2 reusa).
- O `deno check` pode acusar erros de typing pré-existentes do supabase-js — comparar com o set da main, não consertar pré-existentes (lição do projeto).
- Se a contagem não saltar após o run, checar nos logs se a paginação cobriu todas as páginas (`nTotPaginas`) e se o run não estourou o budget do background (medir tempo).
