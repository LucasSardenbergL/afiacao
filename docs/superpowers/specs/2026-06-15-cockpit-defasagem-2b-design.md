# Cockpit de preço — Fase 2b: defasagem de repasse POR CLIENTE — design

> Sub-projeto da Onda 1 (co-piloto de venda ao vivo). Continuação da Fase 2a (saúde de markup sobre CMC atual, já em produção). Esta spec é o ciclo próprio da **2b**.
> **Status do Codex:** o challenge adversário da metodologia está **PENDENTE** (cota do Codex estourou em 2026-06-15, volta 18/06). Foldei aqui o **meu** passe adversário (Q1-Q5); o passe do Codex **gateia o BUILD**, não a spec.

## 1. Objetivo

Na ligação, quando a vendedora monta um pedido pra um cliente que **já comprou aquele item antes**, avisar se **o custo subiu desde a última compra dele e o preço não acompanhou** — e mostrar o **preço de equilíbrio do repasse** (o que preserva o markup antigo). Decisão do founder (regra-mãe): "só alerta se a pessoa não subir pelo menos o % que o CMC subiu".

**Não-objetivo:** defasagem global por produto, meta-margem absoluta (é a 2a), bloquear venda.

## 2. Decisões travadas (founder, 2026-06-15)

- **D1 — escopo:** defasagem **POR CLIENTE** (âncora = último pedido **deste cliente** pra **este item**). Casa com a ligação. (Global descartado pro v1.)
- **D2 — sem histórico do cliente:** **neutro/silencioso** (a 2b só fala em recompra; a 2a cobre a saúde absoluta). Precisão > recall.
- **D3 — UI:** **linha do carrinho** (estende o badge da 2a). `P_req` visível pra vendedora (ação dela); CMC absoluto continua só pro gestor.
- **D4 — decisão delegada a "mim + Codex":** knobs/regra/guards (founder: "decida você e codex").

## 3. Premissa de dado (CORRIGIDA) + pré-requisito

**O CMC histórico EXISTE no Omie.** `estoque/consulta/ListarPosEstoque` é parametrizado por **`dDataPosicao`** e devolve o `nCMC` **como estava naquela data**. O `omie-analytics-sync` (~L716) só pede "hoje". → dá pra puxar o CMC de qualquer data passada (e backfillar).

⚠️ **PRÉ-REQUISITO DO BUILD (smoke):** confirmar com 1 chamada real que `dDataPosicao` passada devolve `nCMC` **histórico** (não o atual com rótulo de data). Sem isso confirmado, NÃO construir o backfill. (Não temos acesso ao Omie pela RPC/terminal — roda numa edge pontual ou o founder testa.)

## 4. Arquitetura

**Restrição-pivô:** uma RPC Postgres **não chama a API do Omie** → o CMC-por-data tem que estar **no banco**. O `cmc_ledger` (2a) só acumula desde 14/06 (sem passado). Logo: **backfill do Omie → tabela de snapshot**, e a RPC lê do banco.

| Unidade | Cria/usa | Responsabilidade |
|---|---|---|
| `cmc_snapshot(account, omie_codigo_produto, data_posicao date, cmc, synced_at)` | Cria | CMC por data (mensal). PK/unique `(account, omie_codigo_produto, data_posicao)`. |
| Edge `cmc-snapshot-backfill` | Cria | Chama `ListarPosEstoque` com `dDataPosicao` = fim de cada mês (1 chamada/mês/conta = catálogo inteiro, paginado); upsert idempotente. Backfill (~12-18 meses) + cron mensal. |
| RPC `get_defasagem_cliente(p_itens jsonb, p_customer_user_id uuid)` | Cria | **Separada** da `get_preco_cockpit** (não toca a RPC de markup recém-estabilizada; single-responsibility). Batch, SECURITY DEFINER, staff-gated. |
| Hook + UI | Modifica | `CartItemList` chama a RPC nova (1 batch por carrinho) + badge de defasagem na linha. |

**Por que RPC separada (não estender a 2a):** a `get_preco_cockpit` acabou de passar por challenge + fixes; mexer nela arrisca regressão money-path. A defasagem é outra responsabilidade (por-cliente, histórico). Custo: 2 chamadas por carrinho (aceitável; react-query dedupe).

## 5. Metodologia

### 5.1 Âncora (do cliente, do real)
- **Price side:** última linha de `order_items` do `(customer_user_id, omie_codigo_produto)` **JOIN `sales_orders`** por `sales_order_id`, filtrando **pedido real** (`omie_pedido_id IS NOT NULL`, `status NOT IN ('cancelado','rascunho')`, `deleted_at IS NULL`), conta certa. → `P_last` (líquido) + **data real do pedido = `sales_orders.order_date_kpi`** (NÃO `order_items.created_at`, que é hora de sync). Mais recente por `order_date_kpi`, tiebreak determinístico.
  - ⚠️ Build: confirmar o **líquido** — `order_items.unit_price = prod.valor_unitario` + `discount` separado; definir `P_last` líquido (subtrair desconto se for R$; cuidar se for %).
- **Cost side:** `C_last` = `cmc_snapshot` mais próximo **≤ `order_date_kpi`** (mesma ponte de conta da 2a); `C_now` = `inventory_position` atual (freshest por `synced_at`, igual à 2a).

### 5.2 Regra (à prova de catraca) — só quando o custo SUBIU
Avalia **só se `C_now > C_last`** (custo realmente subiu — a dor do founder; custo flat/caiu → neutro, sem alerta de margem invertida).

`defasado` SE `(P_now/P_last − 1) < (C_now/C_last − 1) − tolerância`, onde `P_now` = preço que a vendedora vai praticar (carrinho).

Mostra **`P_req = P_last × (C_now/C_last)`** = o preço que **preserva o markup antigo** (repasse pleno). UI: "custo +Y% desde MM/AA · repassar p/ R$ P_req".

### 5.3 Guards (meu passe adversário — Q1/Q3/Q5)
- **G1 âncora ruim por desconto/promo:** se `P_last ≤ C_last` (vendeu no/abaixo do custo) → a catraca herdaria markup ruim → **neutro/baixa-confiança** (não ancora num prejuízo).
- **G2 só pedido real:** filtro de status/omie_pedido_id/deleted_at (acima) — cancelado/rascunho/devolvido não vira âncora.
- **G3 âncora velha:** `order_date_kpi` > **18 meses** → caveat "âncora antiga" (ou neutro) — repasse acumulado de anos não é crível como 1 número.
- **G4 quarentena de salto:** `C_now/C_last − 1 > +50%` (provável erro de cadastro/unidade) → **"revisar"**, NÃO alerta de repasse. Idem salto de preço absurdo.
- **G5 unidade:** assume mesmo SKU/unidade entre âncora e agora (mesmo `omie_codigo_produto`). Mudança de unidade (caixa↔un) é risco conhecido → quarentena pega o ratio absurdo. (v2: validar `unidade`.)
- **G6 múltiplos no mesmo dia / qty diferente:** pega o mais recente por `order_date_kpi` + tiebreak; ignora diferença de quantidade no v1 (compara preço unitário) — risco de faixa de volume documentado.

### 5.4 Degradação honesta
Sem `order_items` real do cliente → **neutro/sem_historico**; sem `cmc_snapshot` cobrindo a data → **neutro/sem_custo_historico**; `P_last`/`C_last` ≤ 0 ou NaN → neutro; `C_now ≤ C_last` → **neutro/sem_alta** (não é defasagem). Nunca fabricar alerta.

### 5.5 CMC histórico = visão ATUAL do Omie (nota)
O `cmc_snapshot` guarda o que o Omie devolve **hoje** pra uma data passada. Se o Omie recalcula o CMC retroativo, é "a melhor visão atual do custo passado" — e comparar `C_last` e `C_now` na **mesma base** (ambos via Omie hoje) é mais consistente que misturar um congelado-na-época com um vivo. Aceito.

## 6. Segurança / vazamento (Q4)
`P_req` revela `C_now/C_last` (a **razão** de alta do custo), não os valores absolutos. A vendedora deduz "o custo subiu Y%", não o CMC. O founder **aceitou o risco do oráculo** na 2a; aqui não é pior (não dá pra deduzir o CMC absoluto de `P_req` + `P_last`). CMC absoluto continua **gestor-only**; a RPC é staff-gated + REVOKE anon (igual à 2a).

## 7. Faixas / saída da RPC (por item)
`status_defasagem`: `defasado | em_dia | sem_historico | sem_alta | revisar | neutro`. Sempre: `status`, `tem_ancora`, `calculated_at`. Role-gated (gestor): `p_last`, `c_last`, `c_now`, `markup_anterior`, `alta_custo_perc`, `data_ancora`. **`p_req` e `alta_custo_perc` visíveis pra vendedora** (ação dela). `motivo` honesto.

## 8. Testes
- **Helper puro TDD** (`defasagem.ts`): a regra + guards (oráculo). Casos: defasado, em-dia, sem-alta (custo caiu→neutro), G1 (P_last≤C_last), G3 (âncora velha), G4 (quarentena +50%), tolerância na fronteira.
- **PG17** (`db/test-defasagem.sh`): RPC lê `cmc_snapshot`/`order_items`/`sales_orders` (stubs); âncora pega o pedido real mais recente (ignora cancelado/rascunho); ponte de conta; degradação; quarentena; role-gate (gestor vê números, vendedora vê só `p_req`/faixa) + falsificação; REVOKE anon.
- **Backfill edge:** testado contra o Omie no smoke (paginação até página vazia + guard; idempotência do upsert).

## 9. Sequência de build (gated)
1. **Smoke `dDataPosicao`** (pré-req — confirma o dado). 🚧 gate.
2. **Codex challenge da metodologia** (cota volta 18/06 ou créditos). 🚧 gate money-path.
3. `cmc_snapshot` + edge backfill + cron.
4. Helper TDD + RPC `get_defasagem_cliente` + PG17.
5. Hook + badge no `CartItemList`.

## 10. Riscos (P1) e mitigação
| # | Risco | Mitigação |
|---|---|---|
| 1 | `dDataPosicao` não devolve histórico de verdade | **smoke obrigatório** antes do backfill (gate) |
| 2 | Âncora de pedido promocional/atípico → P_req inflado | G1 (P_last≤C_last→neutro) + G4 quarentena |
| 3 | Data errada (`order_items.created_at`=sync) | usar `sales_orders.order_date_kpi` (canônico) |
| 4 | Cancelado/rascunho/devolvido como âncora | filtro de status/omie_pedido_id/deleted_at |
| 5 | CMC retroativo recalculado | base consistente (ambos via Omie hoje); aceito (§5.5) |
| 6 | Granularidade mensal perde repasse | suficiente p/ âncora de meses atrás; v2 refina |
| 7 | Mudança de unidade (caixa↔un) | G5 + quarentena do ratio absurdo |
| 8 | Líquido vs bruto no `unit_price` | confirmar `desconto` no build (§5.1) |
| 9 | Identidade do cliente mismapeada | `customer_user_id` mapeado (Fase 0); risco herdado |

## 11. Refs
Spec 2a: `docs/superpowers/specs/2026-06-14-cockpit-preco-markup-cmc-design.md` (§4.4/§9 esboço — esta spec o supera). Ponte de conta: RPC `get_preco_cockpit` + reposição `20260606190000`. `order_date_kpi`: roadmap §3 (data canônica TZ-safe). Sync de `order_items`/`order_date_kpi`: `omie-vendas-sync`.
