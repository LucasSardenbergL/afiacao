# `tipo_produto` coluna dedicada — Plano de Implementação

> **Para executores:** Plano money-path. Cada migration é **aplicação MANUAL no SQL Editor do Lovable** (não auto-aplica); cada edge é **deploy MANUAL via chat do Lovable**. NÃO se commita por step — o projeto agrupa num PR squash no fim. Os **CHECKPOINTS LOVABLE** marcam onde a bola passa pro founder e volta. Spec: `docs/superpowers/specs/2026-06-04-tipo-produto-coluna-dedicada-design.md`.

**Goal:** Restaurar e blindar o sinal `tipo_produto` (Produto Acabado `04` = fabricado, nunca comprar) como coluna dedicada, imune à sobrescrita por syncs concorrentes, com guarda fail-closed e vigia de cobertura.

**Architecture:** `tipo_produto` sai do `metadata` jsonb compartilhado e vira coluna própria de `omie_products`. Um único writer autoritativo (`omie-sync-metadados`, que já pagina o catálogo inteiro) a popula; os demais syncs não a incluem no payload → não a tocam. Trigger anti-null-clobber + vigia de cobertura + RPC fail-closed fecham os modos de falha.

**Tech Stack:** Supabase Postgres (migrations manuais), Deno edge functions, React/TS + supabase-js, vitest, `_data_health_compute` (Sentinela).

**Decisões (founder + codex):** Q1 → só o `omie-sync-metadados` é dono do sinal. Q2 → OBEN **e** Colacor (o writer roda por conta). Q3 → confirmar cadência do cron do metadados (homework Lovable, no Checkpoint A).

---

## File Structure

**Criar:**
- `src/lib/reposicao/tipo-produto.ts` — helper puro `normalizeTipoProduto()` (TDD; espelhado no edge).
- `src/lib/reposicao/__tests__/tipo-produto.test.ts` — testes do helper.
- `supabase/migrations/20260604130000_omie_products_tipo_produto_coluna.sql` — Migration 1 (coluna + trigger). *(timestamp realocado 120000→130000: colidia com `20260604120000_picking_bridge.sql` de sessão paralela)*
- `supabase/migrations/20260604140000_tipo_produto_consumidores_e_vigia.sql` — Migration 2 (consumidores + fail-closed + account-fix + vigia de cobertura).

**Modificar:**
- `supabase/functions/omie-sync-metadados/index.ts` — vira writer autoritativo (lê `tipoItem`, grava a coluna, métricas).
- `supabase/functions/omie-vendas-sync/index.ts:357` — deixa de gravar `metadata.tipo_produto` (coluna é a fonte).
- `src/services/orderSubmission/submitOrder.ts:215` — lê a coluna com fallback ao metadata.
- `src/integrations/supabase/types.ts` — coluna `tipo_produto` em `omie_products` (regen ou edição pontual).
- (já feito) `src/components/reposicao/revisao/useRevisaoParametros.ts` — fix de UI da fila.

---

## Task 0 — Fix de UI (JÁ FEITO, entra no PR)

`useRevisaoParametros.ts` já esconde `produto_acabado` da fila de Revisão (`.or("tipo_reposicao.is.null,tipo_reposicao.neq.produto_acabado")`). Typecheck+lint OK. Nada a fazer; só não esquecer no PR final.

---

## Task 1 — Helper puro `normalizeTipoProduto` (TDD)

**Files:**
- Create: `src/lib/reposicao/tipo-produto.ts`
- Test: `src/lib/reposicao/__tests__/tipo-produto.test.ts`

**Contrato:** normaliza o `tipoItem` cru do Omie para o código fiscal canônico de 2 dígitos (`'04'`, `'00'`, …) ou `null`. Rejeita não-numérico (ex.: `'K'` de Kit) e vazio → `null` (= "não escrever a coluna"). É o ponto que impede confundir tipo fiscal com discriminador de Kit.

- [ ] **Step 1 — Teste (falha):**

```ts
import { describe, it, expect } from "vitest";
import { normalizeTipoProduto } from "@/lib/reposicao/tipo-produto";

describe("normalizeTipoProduto", () => {
  it("normaliza dígito único pra 2 dígitos", () => {
    expect(normalizeTipoProduto("4")).toBe("04");
    expect(normalizeTipoProduto("0")).toBe("00");
    expect(normalizeTipoProduto(4)).toBe("04");
  });
  it("preserva 2 dígitos válidos", () => {
    expect(normalizeTipoProduto("04")).toBe("04");
    expect(normalizeTipoProduto("00")).toBe("00");
    expect(normalizeTipoProduto("13")).toBe("13");
  });
  it("rejeita Kit e não-numérico → null (não confundir com tipo fiscal)", () => {
    expect(normalizeTipoProduto("K")).toBeNull();
    expect(normalizeTipoProduto("abc")).toBeNull();
    expect(normalizeTipoProduto("4A")).toBeNull();
  });
  it("ausência/ruído → null (= não escrever a coluna)", () => {
    expect(normalizeTipoProduto(null)).toBeNull();
    expect(normalizeTipoProduto(undefined)).toBeNull();
    expect(normalizeTipoProduto("")).toBeNull();
    expect(normalizeTipoProduto("   ")).toBeNull();
    expect(normalizeTipoProduto("100")).toBeNull(); // >2 dígitos: fora do padrão Omie
  });
});
```

- [ ] **Step 2 — Implementação mínima:**

```ts
// src/lib/reposicao/tipo-produto.ts
/**
 * Normaliza o tipo fiscal do item do Omie (tipoItem/SPED) ao código canônico de
 * 2 dígitos ('04'=Produto Acabado/fabricado, '00'=Revenda, etc.) ou null.
 *
 * Aceita só 1-2 dígitos numéricos → padStart(2,'0'). Rejeita não-numérico
 * (ex.: 'K' de Kit, usado noutro campo) e >2 dígitos → null. null = "sinal
 * ausente" → o writer NÃO escreve a coluna (não grava NULL). money-path:
 * espelhado verbatim no edge omie-sync-metadados (Deno não importa de src/).
 */
export function normalizeTipoProduto(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  return s.padStart(2, "0");
}
```

- [ ] **Step 3 — Validar:**

Run: `heavy bun run test src/lib/reposicao/__tests__/tipo-produto.test.ts`
Expected: PASS (todos). Depois `bun lint src/lib/reposicao/tipo-produto.ts` (0 errors).

---

## Task 2 — Migration 1: coluna `tipo_produto` + trigger anti-null-clobber

**Files:**
- Create: `supabase/migrations/20260604130000_omie_products_tipo_produto_coluna.sql`

**Conteúdo completo (= bloco pra colar no SQL Editor):**

```sql
-- Migration 1 — tipo_produto como COLUNA dedicada de omie_products
-- ============================================================================
-- Tira o sinal money-path do metadata jsonb COMPARTILHADO (que 4 syncs descritivos
-- sobrescreviam inteiro, zerando o tipo_produto — confirmado: 0/3651 chaves no OBEN).
-- Coluna dedicada: writer que não a inclui no payload NÃO a toca. Só o writer
-- autoritativo (omie-sync-metadados) escreve. Spec 2026-06-04. Idempotente.
-- ============================================================================

ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;

COMMENT ON COLUMN public.omie_products.tipo_produto IS
  'Tipo fiscal do item no Omie (tipoItem/SPED): 04=Produto Acabado (FABRICADO, nunca comprar), 00=Revenda (comprável), NULL=desconhecido/comprável. Coluna dedicada — só omie-sync-metadados escreve. NÃO usar metadata->>tipo_produto (legado, sujeito a sobrescrita). Spec 2026-06-04.';

-- Índice das queries da guarda (tipo_produto='04' por account)
CREATE INDEX IF NOT EXISTS idx_omie_products_account_tipo_produto
  ON public.omie_products (account, tipo_produto) WHERE tipo_produto IS NOT NULL;

-- Trigger anti-null-clobber (defesa em profundidade): se um writer mandar a coluna
-- como NULL mas já existia valor, preserva o valor. Reescrita legítima (04->00) passa.
CREATE OR REPLACE FUNCTION public.preserve_tipo_produto()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tipo_produto IS NULL AND OLD.tipo_produto IS NOT NULL THEN
    NEW.tipo_produto := OLD.tipo_produto;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_preserve_tipo_produto ON public.omie_products;
CREATE TRIGGER trg_preserve_tipo_produto
  BEFORE UPDATE ON public.omie_products
  FOR EACH ROW
  EXECUTE FUNCTION public.preserve_tipo_produto();

-- Validação
SELECT 'MIGRATION 1 OK' AS status,
  (SELECT count(*) FROM information_schema.columns
     WHERE table_name='omie_products' AND column_name='tipo_produto') AS coluna,
  (SELECT count(*) FROM pg_trigger WHERE tgname='trg_preserve_tipo_produto') AS trigger;
```

- [ ] **Step 1:** criar o arquivo acima.
- [ ] **Step 2:** rodar `bun run audit:migrations` (regenera o audit).
- [ ] (apply é no Checkpoint A.)

---

## Task 3 — Edge `omie-sync-metadados` vira writer autoritativo

**Files:**
- Modify: `supabase/functions/omie-sync-metadados/index.ts`

Hoje ele monta `metadata` sem `tipo_produto` e faz upsert (linhas ~71-104). Mudanças:

- [ ] **Step 1 — espelhar o helper (Deno):** adicionar no topo do arquivo (após os imports), verbatim do `src/lib/reposicao/tipo-produto.ts`:

```ts
// Espelho VERBATIM de src/lib/reposicao/tipo-produto.ts (Deno não importa de src/).
function normalizeTipoProduto(raw: string | number | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!/^\d{1,2}$/.test(s)) return null;
  return s.padStart(2, "0");
}
```

- [ ] **Step 2 — gravar a COLUNA no row do upsert.** No `.map(...)` que monta `rows` (linha ~74-98), adicionar a chave de nível superior (NÃO dentro de `metadata`):

```ts
        // ... campos existentes (codigo, descricao, ..., metadata, updated_at) ...
        tipo_produto: normalizeTipoProduto(
          (p as Record<string, unknown>).tipoItem as string | number | undefined
          ?? (p as Record<string, unknown>).tipo_item as string | number | undefined
        ),
```

⚠️ Importante: `tipo_produto` fica **fora** do objeto `metadata` (é coluna). E NÃO incluir `prod.tipo` (é discriminador de Kit). Quando `normalizeTipoProduto` devolve `null`, o upsert grava `tipo_produto = null` — mas como o trigger preserva o valor anterior, um produto que já tinha `'04'` não é apagado. (No INSERT inicial fica null, populado quando o Omie devolver o tipo.)

- [ ] **Step 3 — métricas no log/sync_state.** Após o loop de páginas, contar e logar: total, `tipo04 = rows com tipo_produto='04'`, `typed = rows com tipo_produto não-null`, `paginas`, `complete`. Adicionar ao `console.log` final e ao `sync_state` (campo `metadata`/`last_*`). (Detalhe de implementação: acumular `let tipo04=0, typed=0;` no loop.)

- [ ] **Step 4 — validar local:** `cd supabase/functions/omie-sync-metadados && deno check index.ts` (set de erros inalterado vs. main) + `bun lint supabase/functions/omie-sync-metadados/index.ts`.

(Deploy é no Checkpoint A.)

---

## Task 4 — Edge `omie-vendas-sync` deixa de gravar o sinal no metadata

**Files:**
- Modify: `supabase/functions/omie-vendas-sync/index.ts:347-358`

- [ ] **Step 1:** remover a chave `tipo_produto` do objeto `metadata` (linhas 354-357), já que a coluna é a fonte única (Q1). O `metadata` do vendas-sync fica `{ marca, modelo, peso_bruto, peso_liq, descricao_familia, cfop }`. NÃO adicionar a coluna `tipo_produto` no row do vendas-sync (ele não é o dono; e como omite a coluna, o upsert dele não a toca — coerente com a coluna dedicada).
- [ ] **Step 2 — validar:** `deno check` (set inalterado) + lint.

> Racional: se o vendas-sync continuasse gravando só no metadata, viraria dado vestigial divergente da coluna. Tirar evita confusão. (Alternativa Q1-redundante: gravar a coluna também — descartada por decisão do founder: dono único.)

---

## ⛳ CHECKPOINT LOVABLE A (founder)

Ordem (o founder executa; cada passo confirma antes do próximo):
1. **SQL Editor:** colar e rodar o bloco da **Migration 1** → confirmar `MIGRATION 1 OK / coluna=1 / trigger=1`.
2. **Chat do Lovable:** deploy do `omie-sync-metadados` (ler do repo, verbatim) e do `omie-vendas-sync` (idem). Confirmar **Active**.
3. **Rodar full sync** do `omie-sync-metadados` para **oben** e **colacor** (via chat do Lovable ou cron manual).
4. **SQL Editor — medir baseline e confirmar Q3:**

```sql
SELECT account,
  count(*) AS total,
  count(*) FILTER (WHERE tipo_produto IS NOT NULL) AS typed,
  count(*) FILTER (WHERE tipo_produto = '04') AS tipo04,
  max(updated_at) AS ultimo
FROM public.omie_products
WHERE lower(account) IN ('oben','colacor')
GROUP BY account;
```

Esperado OBEN: `typed` ≈ total, `tipo04` > 0 (perto dos ~1204 históricos). **Anotar o `tipo04` do OBEN** (entra como referência do vigia). Cole o resultado de volta.

> Só seguir pra Task 5 com OBEN `tipo04 > 0`. Se vier 0, o `tipoItem` não está no payload do metadados → debugar o payload cru (`debug_raw`) antes de prosseguir.

---

## Task 5 — Migration 2: consumidores leem a coluna + RPC fail-closed + fix account-blind

**Files:**
- Create: `supabase/migrations/20260604140000_tipo_produto_consumidores_e_vigia.sql`

⚠️ **Anti-cascata (CLAUDE.md §5):** a RPC `gerar_pedidos_sugeridos_ciclo` e a view `v_sku_candidatos_primeira_compra` são funções/views QUENTES. **Partir da migration de MAIOR timestamp VIVA** (provável `20260531160000` pra a RPC/view). Confirmar o corpo vivo em prod ANTES de recriar:

- [ ] **Step 0 — confirmar corpos vivos (SQL Editor, read-only):**

```sql
SELECT pg_get_functiondef('public.gerar_pedidos_sugeridos_ciclo(text,date)'::regprocedure);
SELECT pg_get_viewdef('public.v_sku_candidatos_primeira_compra', true);
```

Casar com `20260531160000` antes de aplicar o `CREATE OR REPLACE` (se divergir, partir do corpo vivo).

- [ ] **Step 1 — RPC:** no corpo vivo de `gerar_pedidos_sugeridos_ciclo`, fazer 3 mudanças cirúrgicas:

  **(a) guarda → coluna com ponte:** trocar a subquery da guarda `04`:
  ```sql
  -- ANTES:
  AND COALESCE((SELECT op04.metadata->>'tipo_produto' FROM omie_products op04
    WHERE op04.omie_codigo_produto::text = sp.sku_codigo_omie::text
      AND op04.account = lower(p_empresa) LIMIT 1), '') <> '04'
  -- DEPOIS (ponte: coluna primeiro, metadata como fallback de transição):
  AND COALESCE((SELECT COALESCE(op04.tipo_produto, op04.metadata->>'tipo_produto')
    FROM omie_products op04
    WHERE op04.omie_codigo_produto::text = sp.sku_codigo_omie::text
      AND op04.account = lower(p_empresa) LIMIT 1), '') <> '04'
  ```

  **(b) fail-closed:** logo no início do bloco `BEGIN` (antes do `DELETE`), abortar se o sinal está morto pra a empresa:
  ```sql
  IF (SELECT count(*) FILTER (WHERE tipo_produto IS NOT NULL)
        FROM public.omie_products WHERE account = lower(p_empresa)) = 0 THEN
    RAISE EXCEPTION 'tipo_produto_unhealthy: sinal de classificação ausente em omie_products(account=%); recusando gerar compras p/ não tratar fabricado como comprável', lower(p_empresa);
  END IF;
  ```

  **(c) fix account-blind:** no `LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text`, adicionar `AND op.account = lower(p_empresa)`.
  ⚠️ **Validar cardinalidade antes/depois** (Step 4): se o resultado mudar além do esperado, isolar este (c) num PR próprio.

- [ ] **Step 2 — view cold-start:** no corpo vivo de `v_sku_candidatos_primeira_compra`, trocar `COALESCE(op.metadata->>'tipo_produto','') <> '04'` por `COALESCE(op.tipo_produto, op.metadata->>'tipo_produto','') <> '04'` (3-arg COALESCE; mantém o resto VERBATIM, **inclusive a ordem de colunas do SELECT final** — anti-drift CLAUDE.md).

- [ ] **Step 3 — vigia que lê o sinal:** no `EXISTS` do check `reposicao_sayerlack_fabricado` (dentro de `_data_health_compute`), trocar `o.metadata->>'tipo_produto' IN ('04','4')` por `COALESCE(o.tipo_produto, o.metadata->>'tipo_produto') IN ('04','4')`. (Ver Task 6 — recriação do `_data_health_compute` junto.)

- [ ] **Step 4 — validar a RPC (SQL Editor, antes de "valer"):** rodar `SELECT * FROM gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);` e comparar `skus_incluidos`/`valor_total_ciclo` com a véspera; o fix account-blind (c) não deve inflar/duplicar. Documentar no PR.

---

## Task 6 — Vigia de cobertura do sinal (no `_data_health_compute`)

**Files:** mesma Migration 2 (Task 5).

⚠️ **Partir da base VIVA do `_data_health_compute`** (confirmar em prod qual é — provável `20260531130000`, NÃO a `20260531170000` do mapeamento_gap, que o CLAUDE.md marca como apply-travado):

- [ ] **Step 0:** `SELECT pg_get_functiondef('public._data_health_compute()'::regprocedure);` no SQL Editor. Partir DESSE corpo.
- [ ] **Step 1 — adicionar 1 check** (`UNION ALL`) antes do `alert_channel`:

```sql
    -- Saúde do PRÓPRIO sinal tipo_produto (o reposicao_sayerlack_fabricado é cego se o sinal some).
    -- broken se OBEN tem produtos mas 0 com tipo_produto (sinal morto = o incidente de 2026-06-04),
    -- ou 0 com '04' (fabricados sumiram). freshness por max(updated_at). Baseline fino = v2.
    SELECT 'omie_tipo_produto_oben'::text, 'estoque'::text,
      CASE WHEN tp.total = 0 THEN 'unknown'
           WHEN tp.typed = 0 OR tp.tipo04 = 0 THEN 'broken'
           WHEN now() - tp.ultimo > interval '48 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - tp.ultimo)::bigint, (48*3600)::bigint, 'omie_products.tipo_produto (OBEN)'::text,
      CASE WHEN tp.typed = 0 THEN 'Sinal tipo_produto MORTO no OBEN (0 de '||tp.total||' classificados) — guarda de "não comprar fabricado" cega'
           WHEN tp.tipo04 = 0 THEN 'Nenhum Produto Acabado (04) classificado no OBEN — sinal de fabricado sumiu'
           ELSE 'Sinal tipo_produto: '||tp.typed||'/'||tp.total||' classificados, '||tp.tipo04||' fabricados (04)' END,
      NULL,
      CASE WHEN tp.typed = 0 OR tp.tipo04 = 0 THEN 'omie-sync-metadados parou de gravar tipo_produto, ou foi sobrescrito. Rode o full sync do omie-sync-metadados (OBEN) e cheque o payload tipoItem' ELSE NULL END,
      'Rode o omie-sync-metadados (full, OBEN) no Lovable e confira a coluna omie_products.tipo_produto'::text,
      'critical'::text
    FROM (
      SELECT count(*) AS total,
        count(*) FILTER (WHERE tipo_produto IS NOT NULL) AS typed,
        count(*) FILTER (WHERE tipo_produto = '04') AS tipo04,
        max(updated_at) AS ultimo
      FROM public.omie_products WHERE account = 'oben'
    ) tp
    UNION ALL
```

- [ ] **Step 2 — promover ao push:** adicionar `'omie_tipo_produto_oben'` ao `IN (...)` do `data_health_watchdog` E ao `_resumo` do `fin_sync_heartbeat` (recriar as 3 funções JUNTAS, verbatim da base viva + os 2 deltas das Tasks 5/6 — anti-dessincronização CLAUDE.md).
- [ ] **Step 3 — REVOKE** no fim (`REVOKE ALL ON FUNCTION public._data_health_compute() FROM PUBLIC, anon, authenticated;`) — preservar da base viva.
- [ ] **Step 4 — validação** no fim da migration:

```sql
SELECT 'MIGRATION 2 OK' AS status,
  (SELECT count(*) FROM public._data_health_compute() WHERE source='omie_tipo_produto_oben') AS check_novo;
```

---

## Task 7 — Frontend: `submitOrder` lê a coluna + types

**Files:**
- Modify: `src/services/orderSubmission/submitOrder.ts:215`
- Modify: `src/integrations/supabase/types.ts` (coluna `tipo_produto` em `omie_products` Row/Insert/Update)

- [ ] **Step 1 — submitOrder:** trocar a leitura por coluna-com-fallback:

```ts
// ANTES: const tp = c.product.metadata?.tipo_produto;
const tp = c.product.tipo_produto ?? c.product.metadata?.tipo_produto;
```
(garantir que o tipo de `c.product` exponha `tipo_produto`; se vier de uma query a `omie_products`, incluir a coluna no `.select(...)`.)

- [ ] **Step 2 — types:** adicionar `tipo_produto: string | null` em `omie_products` Row (e `?: string | null` em Insert/Update) no `types.ts`. (Ou regenerar via Lovable; edição pontual é aceitável — ver CLAUDE.md sobre não duplicar tabelas.)
- [ ] **Step 3 — manter o teste existente** `submitOrder.test.ts:66` (usa `metadata: { tipo_produto: '04' }`) verde; adicionar um caso com `product.tipo_produto: '04'` (coluna) pra cobrir o novo caminho.
- [ ] **Step 4 — validar:** `heavy bun run typecheck` + `heavy bun run test src/services/orderSubmission` + `bun lint`.

---

## ⛳ CHECKPOINT LOVABLE B (founder)

1. **SQL Editor:** Migration 2 → confirmar `MIGRATION 2 OK / check_novo=1`.
2. **Chat do Lovable:** redeploy das edges que mudaram (se a RPC for chamada por edge — aqui não; a RPC é SQL). Confirmar nada pendente.
3. **Regenerar ciclo OBEN:** `SELECT * FROM gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);` (agora a guarda viva volta a barrar fabricado).
4. **Validar verde-verdade:** `SELECT * FROM public._data_health_compute() WHERE source IN ('omie_tipo_produto_oben','reposicao_sayerlack_fabricado');` → `omie_tipo_produto_oben` = ok; `reposicao_sayerlack_fabricado` reflete a verdade.

---

## Task 8 — Auditoria/contenção de pedidos vazados

- [ ] **Step 1 — rodar (SQL Editor):**

```sql
SELECT pcs.data_ciclo, pcs.status, pcs.status_envio_portal,
       pci.sku_codigo_omie, pci.sku_descricao, pci.qtde_final, pci.valor_linha,
       op.tipo_produto
FROM pedido_compra_item pci
JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
LEFT JOIN public.omie_products op
  ON op.omie_codigo_produto::text = pci.sku_codigo_omie::text AND op.account='oben'
WHERE pcs.empresa = 'OBEN'
  AND op.tipo_produto = '04'
  AND pcs.status NOT IN ('cancelado','expirado_sem_aprovacao')
ORDER BY pcs.data_ciclo DESC;
```

- [ ] **Step 2:** se vier algo, **quarentenar** (cancelar via UI/`cancelar_pedido_sugerido` os pendentes; conferir os já em portal/Omie com o founder). Esperado: vazio (o flag `produto_acabado` segurou).

---

## PR final (agrupado)

Tudo num PR: helper TDD + 2 migrations (arquivos) + 2 edges + frontend + fix de UI (Task 0). Body do PR com **"⚠️ migrations manuais necessárias"** + os 2 blocos SQL + o prompt de deploy das edges + a sequência dos Checkpoints A/B. CI `validate` verde antes do merge.

---

## Self-review (cobertura do spec)

- §5.1 coluna dedicada → Task 2. ✅
- §5.2 writer autoritativo (metadados) → Task 3. ✅
- §5.3 trigger anti-null-clobber → Task 2. ✅
- §5.4 `tipoItem` confiável (não `prod.tipo`) → Task 1 (helper) + Task 3 (uso). ✅
- §5.5 consumidores leem coluna (COALESCE ponte) → Tasks 5/7. ✅
- §5.6 RPC fail-closed → Task 5 (b). ✅
- §5.7 vigia de cobertura → Task 6. ✅
- §5.8 fix join account-blind → Task 5 (c). ✅
- §6 auditoria de vazados → Task 8. ✅
- §7 fix UI → Task 0. ✅

Gaps: Q3 (cadência do cron) resolvido no Checkpoint A (item 4). Baseline fino do vigia (queda % vs histórico) deixado como v2 — o v1 usa piso "zero = morto", que pega o incidente real sem baseline frágil.
