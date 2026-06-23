# Handoff — Correção da lavagem de proveniência de custo (`cost_source`)

> ## ✅ CONCLUÍDO E VERIFICADO EM PROD — 2026-06-22
> Migration + edge + Publish + recompute aplicados; **reset cobriu ativos+inativos** (1.309 linhas,
> não só os ~54 inativos do plano abaixo — o recompute só visita ~770 produtos do FLUXO, não todos os
> ativos, então o passivo lavado real era 1.277). **Sentinela 3×0** (`PRODUCT_COST=0`,
> `proxy_com_cost_price=0`, `cost_price≠cmc=0`). Crons nunca foram pausados (todos `active`); estado
> final consistente. O SQL de reset **definitivo** (ativos+inativos, preserva CMC legítima) está
> registrado em `docs/historico/bugs-resolvidos.md` e diverge do passo 6 abaixo (que mirava só inativos).
> Detalhe da entrega: `docs/historico/bugs-resolvidos.md`. O passo-a-passo abaixo fica como registro.


> Bug money-path achado via Codex challenge (2026-06-19). O motor de custo promovia um custo
> PROXY (inventado) a `PRODUCT_COST` conf 0.95 após ~2 reprocessamentos. Medição em prod:
> **≥510 SKUs** com custo inventado mascarado de real. Abordagem escolhida: **radical** (Codex)
> — `PRODUCT_COST` removido da escada; CMC é a única fonte real; proxy nunca semeia `cost_price`.

## O que mudou no código (já nesta branch, testado)

- `src/lib/custo/costLadder.ts` — escada de custo pura (CMC > família-real > default; `PRODUCT_COST`
  fora da escada; proxy nunca persiste `cost_price`). Espelhada **verbatim** em
  `supabase/functions/_shared/cost-ladder.ts` (paridade byte-a-byte testada).
- `supabase/functions/omie-analytics-sync/index.ts` (`computeCosts`) — usa o helper; média de
  família calculada **só de CMC real** (antes reinjetava proxy → motor autorreferencial).
- `src/lib/custo/custoCanonico.ts` + 3 hooks (`useBundleEngine`, `useCrossSellEngine`,
  `useFarmerScoring`) — leem `cost_final` (proxy-aware) com `ausente≠zero` (antes `Number(cost_price)`
  virava 0 → margem 100% com `cost_price` nullable).
- Verificação: vitest custo 13/13 (com falsificação) · typecheck 0 · lint 0 · **suíte completa 3897/3897**.

## Ordem de aplicação em PRODUÇÃO (gate humano — money-path)

> **Pausar o cron de analytics/sync durante a janela** (passos 1→6) para não rodar um recompute
> parcial nem o edge meio-deployado.

**1. Migration — cost_price nullable** (ANTES do deploy do edge; senão o edge novo grava NULL sob NOT NULL e o upsert falha)

🟣 Lovable → SQL Editor → cola → Run

```sql
ALTER TABLE public.product_costs ALTER COLUMN cost_price DROP NOT NULL;
ALTER TABLE public.product_costs ALTER COLUMN cost_price DROP DEFAULT;
```

Validação (read-only) — esperado `is_nullable=YES`, `column_default` vazio:

```sql
SELECT is_nullable, column_default FROM information_schema.columns
WHERE table_schema='public' AND table_name='product_costs' AND column_name='cost_price';
```

**2. Backup das linhas a remediar** (auditoria/rollback — antes de qualquer reset)

```sql
CREATE TABLE IF NOT EXISTS public._backup_cost_lavados_20260620 AS
SELECT pc.*, op.ativo AS _op_ativo, now() AS _backup_at
FROM product_costs pc LEFT JOIN omie_products op ON op.id = pc.product_id
WHERE pc.cost_source = 'PRODUCT_COST'
   OR (pc.cost_source IN ('FAMILY_MARGIN_PROXY','DEFAULT_PROXY')
       AND pc.cost_price IS NOT NULL AND pc.cost_price > 0);
```

**3. Deploy do edge** (chat do Lovable, **após o merge**, ler do repo e deployar **verbatim**):
`supabase/functions/omie-analytics-sync/index.ts` + `supabase/functions/_shared/cost-ladder.ts`.

**4. Publish do frontend** (editor do Lovable) — leva os 3 hooks + `custoCanonico`.

**5. Recompute** — chamar `compute_costs` (ou `sync_all`) no `omie-analytics-sync`. Recomputa
**todos os SKUs ativos** (recalcula `cost_source`/`cost_price` a partir do CMC; os 659 PRODUCT_COST
ativos lavados são corrigidos automaticamente).

**6. Reset dos INATIVOS lavados** (o recompute só toca ativos; estes ~54 ficam de fora)

```sql
-- Reset dos inativos lavados, honesto e num passo só:
--   cmc>0  → CMC real (cost_price=cmc, source=CMC, conf 0.7) — promove inclusive proxy com CMC
--            real (senão a sentinela passaria mas mascararia um CMC real como proxy — Codex P2);
--   cmc<=0 → sem custo real: cost_price=NULL; PRODUCT_COST (ficção) vira UNKNOWN; proxy fica proxy.
UPDATE product_costs pc
SET cost_price      = CASE WHEN pc.cmc > 0 THEN pc.cmc ELSE NULL END,
    cost_source     = CASE WHEN pc.cmc > 0 THEN 'CMC'
                           WHEN pc.cost_source = 'PRODUCT_COST' THEN 'UNKNOWN'
                           ELSE pc.cost_source END,
    cost_final      = CASE WHEN pc.cmc > 0 THEN pc.cmc ELSE pc.cost_final END,
    cost_confidence = CASE WHEN pc.cmc > 0 THEN 0.7
                           WHEN pc.cost_source = 'PRODUCT_COST' THEN 0
                           ELSE pc.cost_confidence END,
    updated_at      = now()
FROM omie_products op
WHERE op.id = pc.product_id
  AND op.ativo = false
  AND pc.cost_source <> 'CMC'
  AND (pc.cost_source = 'PRODUCT_COST' OR pc.cost_price IS NOT NULL OR pc.cmc > 0);
```

**7. Sentinela** (eu rodo via psql-ro, ou cola no SQL Editor) — tudo deve dar **0**:

```sql
SELECT
  (SELECT count(*) FROM product_costs WHERE cost_source='PRODUCT_COST') AS product_cost_remanescente,
  (SELECT count(*) FROM product_costs
     WHERE cost_source IN ('FAMILY_MARGIN_PROXY','DEFAULT_PROXY') AND cost_price IS NOT NULL) AS proxy_com_cost_price,
  (SELECT count(*) FROM product_costs
     WHERE cost_price IS NOT NULL AND (cmc IS NULL OR abs(cost_price - cmc) > 0.01)) AS cost_price_nao_cmc;
```

Reativar o cron de analytics/sync após o passo 7.

## Pendências registradas (fora do escopo desta correção)

- **CMC account-blind** (`computeCosts` lê `invMap[product_id]` sem filtrar `account`; `inventory_position`
  tem 2 convenções — database.md §56). Pré-existente; pode pegar o CMC errado quando o mesmo SKU tem
  linha 'vendas' e 'oben'. **Tratar em entrega separada.**
- **CMC fora do sanity** (margem negativa real / venda no prejuízo) é rejeitado e degrada para proxy —
  ESCONDE a margem ruim real. Documentado em `costLadder.ts`; tornar observável numa entrega futura.
- **Scoring usa proxy** nos 3 hooks (herança) — idealmente degradar confiança por `cost_source`; a v2
  do cockpit (`fin-valor-cockpit`) já tem o gancho previsto e agora `cost_source` é honesto.
