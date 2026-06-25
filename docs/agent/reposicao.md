# Reposição / Compras — referência operacional (money-path)

> Motor de pedidos sugeridos + portal Sayerlack. Princípios em `docs/agent/money-path.md`. Specs: `docs/superpowers/specs/2026-0*-reposicao-*` e `*sayerlack*`. Diário em `docs/historico/bugs-resolvidos.md`.

## Motor de pedidos de compra

- RPC **`gerar_pedidos_sugeridos_ciclo`** gera as sugestões do ciclo. **JOIN `omie_products` account-aware** — `omie_products.account` é convenção EMPRESA (`oben`/`colacor`/`colacor_sc`); JOIN account-blind **duplica silenciosamente** (sem UNIQUE no item) — ver `docs/agent/database.md`.
- **Ciclo INTRA-DAY**: o motor roda a cada **2h** (não só 1×/dia) + alerta R$3k Sayerlack + gate de mínimo de compra.
- **`aplicar_promocoes_no_ciclo`** é função QUENTE/money-path — já quebrou em prod (parse error, falha silenciosa atrás de chamador) e sofreu **colisão multi-sessão** (PR duplicado). Pré-flight `pg_get_functiondef` da prod + cuidado com ordem de migrations (a última a recriar vence — ver `docs/agent/database.md`).
- Tela de pedidos do ciclo: **idempotente** + tela única (Reposição/Oben), botões à prova de erro.

## cmc-first (base de custo)

- **`cmc` (Custo Médio Contábil do Omie)** é a base de custo **de ponta a ponta**, inclusive na primeira compra. cmc ausente → `null`, **nunca** R$0 (money-path: ausente ≠ zero).
- ⚠️ Após corrigir a FONTE do cmc, **os snapshots derivados NÃO se regeneram sozinhos** — re-invocar o recompute.
- **Escada de proveniência (`cost_source`, [#977]):** CMC é a **única** fonte de custo REAL. `PRODUCT_COST` foi **REMOVIDO** da escada operacional (era ficção — nenhum writer importa custo real ≠ CMC). Proxy (família/default) **NUNCA** semeia `cost_price` (grava `null`) — senão a run seguinte relê o proxy como `PRODUCT_COST` conf 0.95 e o custo inventado vira "real" (**lavagem de proveniência**). Escada no helper puro `src/lib/custo/costLadder.ts`, **espelhado verbatim** no edge `supabase/functions/_shared/cost-ladder.ts` (paridade byte-a-byte testada); consumidores leem `cost_final` via `custoCanonico` (`ausente≠zero`). **`CMC_MARGEM_ATIPICA`** (busy-diffie, fecha pendência (b) do #977): CMC **real** fora da banda de margem comercial (prejuízo `cmc≥price` / margem baixa / alta) **não** é mais mascarado por proxy — vira fonte **real dedicada** (conf 0.60, `cost_price=cmc`, propaga p/ scoring/cockpit), a banda só **classifica** e a única rejeição é o anti-lixo absoluto `cmc/price∈[kMin,kMax]` (`0.01`/`5`, config `margem_cmc_ratio_min/max`). `cost_price` é nullable; invariante: **só sources reais CMC-derivados (`CMC`/`CMC_MARGEM_ATIPICA`) carregam `cost_price`, e sempre `= cmc`**.
- ⚠️ **`computeCosts` (recompute) cobre todo o catálogo ATIVO _com preço_** (`.eq(ativo,true)` + `fetchAll` paginado fura o cap de 1.000; pula `valor_unitario<=0`), mas **não** inativos nem ativos sem preço. Passivo (inativo/sem-preço/seed não-reconciliado) limpa-se por **SQL**, não pelo recompute ([#977]).
- ⚠️ **Seed de `product_costs` não passa pela escada** (dívida de governança ADIADA, não-urgente): os 2 writers de produto NOVO (`omie-analytics-sync:847` bulk via `syncInventory`, `sync-reprocess:587` N+1) inserem `CMC`/0.7/`cost_price=cmc` **cru** — sem o anti-lixo `[0.01,5]` nem a flag `CMC_MARGEM_ATIPICA`; só o `computeCosts` reconcilia. O número é **real** (não mascarado); só `cmc`-lixo raro vaza na **janela** seed→recompute, encurtada p/ ≤2h pelo cron `compute-costs` a cada 2h (migration `20260622163000`, decisão Claude+Codex jun/2026; medido: `fora_antilixo=0`, sem passivo). Se um dia aplicar o ladder no seed: **sem-preço (`valor_unitario<=0`) MANTÉM `CMC`+`cost_price=cmc`** (o recompute pula `price<=0` → `UNKNOWN` viraria permanente; regrediria 622 ativos sem preço, 21 com venda). Spec: `docs/superpowers/specs/2026-06-22-cost-source-seed-writers-debt-spec.md`.

## Mínimo forçado + auto-aprovação

- **Mínimo de compra forçado por SKU** (a "R") — override por SKU que força a quantidade mínima do pedido (ponto de extensão `minimo_forcado_manual` no otimizador de compras).
- **N3 — auto-aprovação Sayerlack** (piloto): a ÚNICA exceção ao gate humano de escrita money-path, **medida por taxa de veto** (ver `docs/agent/money-path.md`). "Aprovar = disparar na hora".

## Portal Sayerlack (scraping / pedido)

- **Claim atômico em SQL-puro** — o PostgREST quebra `.or()` em UPDATE (`42703`, mesmo a coluna existindo) → claim via **RPC com predicado POSITIVO**, não a tradução do `.or()` (ver `docs/agent/database.md`). Ciclo de retry do portal fechado.
- **De-para Sayerlack:** parser `sayerlack-sku` v2 lê o código com **separador-ESPAÇO**; **`tipo_produto` virou COLUNA dedicada** de `omie_products`, alimentada por **`tipoItem` no lote** do Omie (NÃO de outra rota); tingidores desenvolvidos internamente ficam fora do motor (backfill).
- **`em_transito` conta portal-confirmado**; on-order tem **fonte única** (não somar duplicado).

## Outras frentes

- **Reativar SKU descontinuado** (filtro na Revisão) · **Painel de baixo giro** · **Cold-start** (primeira compra sem histórico).
- **Embalagem econômica** (QT vs GL — painel de recomendação, 100% frontend `embalagem-helpers.ts`; NÃO altera o pedido automático): ao comparar pacotes de tamanhos diferentes, a **sobra do maior NÃO é custo morto** — credita como antecipação da próxima compra: `custo_total = custo_direto + carrego − sobra × melhor_custo_por_base`. Gates honestos: sem demanda/cmc → crédito 0 (= frame estrito); guard marginal R$5; conservadora = **menor excedente** (não `excedente===0`, que furava em qtd fracionária); `min()` do grupo viola **IIA** com 3+ embalagens. Invariante `custo_total ≥ nec×custo_base`. Detalhe: spec `2026-06-04-embalagem-economica-design.md §14`.
- Os **god-components da Reposição** foram quebrados (<1000 LoC) — ao mexer, usar `vercel-composition-patterns` + `vercel-react-best-practices`.
