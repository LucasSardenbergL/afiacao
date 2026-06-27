# Cockpit de preço — Fase 2b: defasagem de repasse POR CLIENTE — design

> Sub-projeto da Onda 1 (co-piloto de venda ao vivo). Continuação da Fase 2a (saúde de markup sobre CMC atual, já em produção). Esta spec é o ciclo próprio da **2b**.
> **Status do Codex:** challenge adversário da metodologia **RODADO em 2026-06-15** (gpt-5.5, xhigh, 131k tok). Veredito: *"não pronto pro build, precisa de fix antes"*. **Todos os achados válidos foldados nesta v2** (changelog §12), aterrados no schema REAL via leitura read-only.

## 1. Objetivo

Na ligação, quando a vendedora monta um pedido pra um cliente que **já comprou aquele item antes**, avisar se **o custo subiu desde a última compra dele e o preço não acompanhou** — e mostrar o **preço de equilíbrio do repasse** (o que preserva o markup antigo). Decisão do founder (regra-mãe): "só alerta se a pessoa não subir pelo menos o % que o CMC subiu".

**Não-objetivo:** defasagem global por produto, meta-margem absoluta (é a 2a), bloquear venda.

**Doutrina (money-path):** **PRECISÃO > recall.** Um alerta ERRADO na frente do cliente (mandar repassar sem motivo) é PIOR que silêncio. "Ausente ≠ zero": nunca fabricar número. Na dúvida → **neutro**.

## 2. Decisões travadas (founder, 2026-06-15)

- **D1 — escopo:** defasagem **POR CLIENTE** (âncora = último pedido **deste cliente** pra **este item**). Casa com a ligação. (Global descartado pro v1.)
- **D2 — sem histórico do cliente:** **neutro/silencioso** (a 2b só fala em recompra; a 2a cobre a saúde absoluta).
- **D3 — UI:** **linha do carrinho** (estende o badge da 2a). `P_req` visível pra vendedora (ação dela); CMC absoluto continua só pro gestor.
- **D4 — knobs/regra/guards delegados a "mim + Codex"** (founder: "decida você e codex"). Defaults conservadores em §5.2, tunáveis na revisão.

## 3. Premissa de dado + pré-requisitos (2 GATES de build)

**O CMC histórico EXISTE no Omie.** `estoque/consulta/ListarPosEstoque` é parametrizado por **`dDataPosicao`** e devolve o `nCMC` **como estava naquela data**. O `omie-analytics-sync` (~L716) só pede "hoje". → dá pra puxar o CMC de qualquer data passada (e backfillar).

✅ **GATE 1 — smoke `dDataPosicao` (prova de 2 datas): PROVADO (2026-06-27).** Edge `cmc-snapshot-smoke` deployada (na `main`, auth por `x-cron-secret`) + invocada (account `colacor_vendas`, 15/01 vs 14/06/2026): **21 de 773 SKUs com CMC distinto** entre as datas (ex. cód 394036177 R$269,12→R$555,96 = +106,6%; cód 399938680 caiu −5,7%). `dDataPosicao` devolve **histórico-real**, não o atual com rótulo de data → backfill exato-por-âncora é viável. Prova de 2 datas (pedido do Codex) atendida.

✅ **GATE 2 — semântica de desconto: RESOLVIDO no dado (15/06).** Forense read-only: `order_items.discount > 0` = **0 de 13.627**; `sales_orders.discount > 0` = **0 de 6.687**. Nenhum pedido carrega desconto → `P_last = unit_price` é o líquido pra **100%** das âncoras atuais, e a RPC lê as **colunas** (não o payload cru). O guard "`discount > 0` → neutro" (§5.1) permanece como **proteção futura de custo zero** (neutraliza 0 linhas hoje). **Sem edge/smoke.**

**GATE 1 confirmado (2026-06-27)** → backfill/RPC liberados. Plano: `docs/superpowers/plans/2026-06-27-cockpit-defasagem-2b.md`.

## 4. Arquitetura

**Restrição-pivô:** uma RPC Postgres **não chama a API do Omie** → o CMC-por-data tem que estar **no banco**. O `cmc_ledger` (2a) só acumula desde 14/06 (sem passado). Logo: **backfill do Omie → tabela de snapshot**, e a RPC lê do banco.

| Unidade | Cria/usa | Responsabilidade |
|---|---|---|
| `cmc_snapshot(account, omie_codigo_produto, data_posicao date, cmc, synced_at)` | Cria | CMC por data. PK/unique `(account, omie_codigo_produto, data_posicao)`. |
| Edge `cmc-snapshot-backfill` | Cria | **(a) modo exato:** pra cada pedido-âncora candidato, CMC as-of a **data REAL do pedido** (`dDataPosicao` na data exata). **(b) grade mensal** de fallback p/ cobertura. Paginação até página vazia + guard; upsert idempotente. Backfill (~12-18 meses) + cron mensal. |
| RPC `get_defasagem_cliente(p_itens jsonb, p_customer_user_id uuid)` | Cria | **Separada** da `get_preco_cockpit` (não toca a RPC de markup recém-estabilizada; single-responsibility). Batch, SECURITY DEFINER, staff-gated, REVOKE anon. |
| Hook + UI | Modifica | `CartItemList` chama a RPC nova (1 batch por carrinho) + badge de defasagem na linha. |

**Por que snapshot exato-por-âncora (não só grade mensal):** a grade mensal é a **fonte do falso-positivo crítico** (Codex #1) — se a âncora é 20/05 mas o snapshot mais próximo ≤ data é 30/04 (custo ainda baixo), a RPC vê alta-fantasma. O `dDataPosicao` aceita **qualquer** data, então backfillamos a data exata de cada âncora. A RPC lê o snapshot da data da âncora (janela **±7 dias**); fora da janela → **neutro** (não arrisca FP).

**Por que RPC separada:** a `get_preco_cockpit` acabou de passar por challenge + fixes; mexer arrisca regressão money-path. Custo: 2 chamadas por carrinho (aceitável; react-query dedupe).

## 5. Metodologia

### 5.1 Âncora (do cliente, do real) — aterrada no schema
`order_items` tem **`customer_user_id` direto** + `quantity`, `unit_price`, `discount`, `omie_codigo_produto`, `sales_order_id`. `sales_orders` tem `status`, `account`, `order_date_kpi (date)`, `omie_pedido_id`, `omie_payload (jsonb)`, `discount`, `deleted_at`.

- **Âncora:** última linha de `order_items` do `(customer_user_id, omie_codigo_produto)` **JOIN `sales_orders`** por `sales_order_id`, **account-aware** (`account` = ponte da empresa, igual à 2a — Oben→['vendas','oben'] etc.). → `P_last` (líquido) + data real.
- **Status allowlist (aterrada):** `status IN ('faturado','importado','separacao','enviado')` — vendas reais. Exclui `cancelado`/`rascunho`/`orcamento`. + `omie_pedido_id IS NOT NULL` + `deleted_at IS NULL`. (Lista **positiva**, não denylist — Codex #6. `importado`=1206 pedidos reais do Omie, mantidos: são a recompra histórica.)
- **Data da âncora (proveniência — Codex #7):** preferir **`dInc` extraído do `omie_payload`** (verdade canônica do Omie) → fallback `order_date_kpi` → se nenhum confiável, **neutro**. (Grounded: **89%** dos `order_date_kpi` == `created_at::date` → proveniência impura; não confiar cega no `order_date_kpi`.)
- **`P_last` líquido (Codex #4):** **empírico (15/06): desconto é sempre 0 no histórico** (0/13.627 linhas, 0/6.687 pedidos) → `P_last = unit_price` hoje. O guard **`discount > 0` (qualquer das 2 camadas: linha `order_items.discount` + pedido `sales_orders.discount`) → neutro** permanece como proteção futura de custo zero (se o Omie passar a mandar desconto, neutraliza até a semântica R$/% ser provada).
- **Multi-pedido no mesmo dia (Codex #8):** `order_date_kpi` é `date` (sem hora) → empate possível. Resolver por **média ponderada pela `quantity`** do preço líquido; se a divergência de preço entre as linhas do dia for alta → **neutro**.
- **Custo:** `C_last` = `cmc_snapshot` da **data exata da âncora** (janela ±7 dias; senão neutro); `C_now` = `inventory_position` atual (freshest por `synced_at`, igual à 2a).

### 5.2 Regra (à prova de catraca) — só quando o custo SUBIU + tolerância EXPLÍCITA
Avalia **só se `C_now > C_last`** E a alta passa de um **piso** (custo subiu **≥ 2%**; abaixo disso é ruído de CMC → neutro).

`defasado` SE `(P_now/P_last − 1) < (C_now/C_last − 1) − tol_pp`, onde:
- **`tol_pp` = 3 pontos percentuais** (default conservador, tunável — Codex #5).
- `P_now` = preço que a vendedora vai praticar (carrinho).

**Piso de ação (anti-arredondamento — Codex #5):** só sinaliza se `P_req − P_now ≥ max(2% de P_now, R$ 1,00)`, comparado em **reais arredondados a centavo** → arredondamento de centavo **nunca** dispara alerta.

Mostra **`P_req = P_last × (C_now/C_last)`** (arredondado) = preço que **preserva o markup antigo**. UI: "custo +Y% desde MM/AA · repassar p/ R$ P_req".

### 5.3 Guards
- **G1 (sólido — Codex confirmou):** `P_last ≤ C_last` (vendeu no/abaixo do custo) → **neutro** (não herda markup de prejuízo).
- **G2:** allowlist de status + filtros (§5.1).
- **G3:** `data âncora` > **18 meses** → caveat "âncora antiga" ou neutro.
- **G4 quarentena:** `C_now/C_last − 1 > +50%` (provável erro de cadastro/unidade) → **"revisar"**, NÃO alerta de repasse. Idem salto de preço absurdo.
- **G5 unidade (HONESTO — limitação real):** `order_items` **NÃO tem coluna de unidade** → não dá pra comparar unidade âncora vs atual. Mitigação: a quarentena (G4) pega troca **grossa** (caixa↔un dá ratio absurdo); pra troca **sutil** (<50%) ou faixa de volume, exigir âncora em **faixa de quantidade comparável** (`quantity` âncora vs carrinho na mesma ordem de grandeza) — divergência grande → neutro. **Risco residual documentado** (§10 #7).
- **G6 frescor do `C_now` (NOVO — Codex #9):** `inventory_position.synced_at` stale → **neutro/`sem_custo_atual_fresco`** (mesma guarda da 2a; sync atrasado não vira falso negativo nem snapshot contaminado vira FP).
- **G7 data confiável (NOVO — Codex #7):** sem `dInc`/proveniência boa da data → **neutro/`sem_data_confiavel`**.

### 5.4 Degradação honesta
**neutro** quando: sem `order_items` real do cliente (`sem_historico`); sem `cmc_snapshot` na janela da data (`sem_custo_historico`); `P_last`/`C_last` ≤ 0 ou NaN; `C_now ≤ C_last` (`sem_alta`); alta < piso 2%; linha com desconto não-provado (`desconto_nao_provado`); data não confiável (`sem_data_confiavel`); `C_now` stale (`sem_custo_atual_fresco`); unidade/qty incerta (`revisar`). **Nunca fabricar alerta.**

### 5.5 CMC histórico = visão ATUAL do Omie (nota)
O `cmc_snapshot` guarda o que o Omie devolve **hoje** pra uma data passada. Se o Omie recalcula o CMC retroativo, é "a melhor visão atual do custo passado" — e comparar `C_last` e `C_now` na **mesma base** (ambos via Omie hoje) é mais consistente que misturar um congelado-na-época com um vivo. Aceito.

## 6. Segurança / vazamento (Codex #3 + #10)
- **Sólido (Codex confirmou):** `P_req` revela a **razão** `C_now/C_last` (% de alta), não os valores absolutos. CMC absoluto (`c_last`/`c_now`) **não** vaza pra vendedora.
- **Escopo de autorização (Codex #10):** campos numéricos absolutos gated por **`pode_ver_carteira_completa`** (gate da 2a); `p_req`/`alta_custo_perc` visíveis pra vendedora pro cliente **em contexto** (ação dela). Consulta out-of-band de cliente arbitrário continua **staff-gated** + REVOKE anon (mesma postura que o founder **aceitou na 2a**). Refinar pra escopo-de-carteira fica como v2 se virar necessidade real.

## 7. Faixas / saída da RPC (por item)
`status_defasagem`: `defasado | em_dia | sem_historico | sem_alta | revisar | sem_custo_atual_fresco | sem_data_confiavel | neutro`. Sempre: `status`, `tem_ancora`, `calculated_at`. **Visível pra vendedora:** `p_req`, `alta_custo_perc`, `data_ancora` (mês/ano), `motivo` honesto. **Role-gated (gestor, `pode_ver_carteira_completa`):** `p_last`, `c_last`, `c_now`, `markup_anterior`.

## 8. Testes
- **Helper puro TDD** (`defasagem.ts`): regra + guards + a **tolerância/piso** (oráculo). Casos: defasado, em-dia, sem-alta (custo caiu→neutro), G1 (P_last≤C_last), G3 (âncora velha), G4 (quarentena +50%), **fronteira da tolerância** (custo +10% / preço +9,96% por centavo → NÃO dispara), **piso de ação** (gap < R$1 → não dispara).
- **PG17** (`db/test-defasagem.sh`): RPC lê `cmc_snapshot`/`order_items`/`sales_orders` (stubs) + **falsificações** (Codex):
  - mesmo `omie_codigo_cliente` em **2 contas** → âncora vem da conta certa (account-aware);
  - snapshot **longe** da data da âncora (>±7d) → **neutro**, não FP (Codex #1);
  - linha com **desconto** → neutro (Codex #4);
  - **cent-rounding** não dispara (Codex #5);
  - `C_now` **stale** → neutro (Codex #9);
  - **multi-pedido no mesmo dia** → média ponderada (Codex #8);
  - status **não-final** (`rascunho`/`cancelado`/`orcamento`) **excluído** da âncora (Codex #6);
  - role-gate (gestor vê `c_*`, vendedora vê só `p_req`/faixa) + falsificação; REVOKE anon.
- **Backfill edge:** smoke dos 2 gates (dDataPosicao 2 datas + desconto) + paginação até página vazia + idempotência do upsert.

## 9. Sequência de build (gated)
1. **GATE 1 — smoke `dDataPosicao`** — ✅ **PROVADO (27/06)**: 21/773 SKUs com CMC distinto (15/01 vs 14/06).
2. **GATE 2 — semântica de desconto** — ✅ **RESOLVIDO no dado** (15/06; desconto sempre 0 → guard de custo zero).
3. **Codex challenge da metodologia** — ✅ **FEITO (15/06)**, achados foldados nesta v2.
4. `cmc_snapshot` + edge backfill (exato-por-âncora + grade mensal) + cron.
5. Helper TDD + RPC `get_defasagem_cliente` + PG17 (+falsificações §8).
6. Hook + badge no `CartItemList`.

## 10. Riscos (atualizado pós-Codex) e mitigação
| # | Risco | Mitigação |
|---|---|---|
| 1 | `dDataPosicao` não devolve histórico de verdade | **GATE 1** (prova de 2 datas) antes do backfill |
| 2 | **CMC mensal → FP** (Codex crít #1) | backfill **exato por âncora** + janela ±7d, senão neutro |
| 3 | **Âncora no cliente errado por conta** (Codex crít #2) | âncora **account-aware** + teste de falsificação (mesmo código, 2 contas). Raiz da identidade = contrato da Fase 0 (herdado) |
| 4 | Âncora de pedido promocional/atípico → P_req inflado | G1 (P_last≤C_last→neutro) + G4 quarentena |
| 5 | **Líquido vs bruto** no `unit_price` (Codex #4) | **GATE 2** + neutralizar linha com desconto até provar; 2 camadas (linha+pedido) |
| 6 | **Tolerância indefinida / cent-rounding** (Codex #5) | tol_pp=3 + piso de ação em reais arredondados |
| 7 | **Troca de unidade** caixa↔un (Codex alta) | G4 (ratio absurdo) + G5 faixa de qty. **Residual: sem coluna `unidade` → troca sutil não detectável** |
| 8 | **Status não-final / devolução** como âncora (Codex #6) | allowlist positiva. **Residual: devolução pós-`faturado` não tem status → não detectável** |
| 9 | **`order_date_kpi` impuro** (89% == created_at; Codex #7) | preferir `dInc` do `omie_payload`; G7 neutro sem data confiável |
| 10 | Multi-pedido mesmo dia inverte âncora (Codex #8) | média ponderada por `quantity` ou neutro |
| 11 | `C_now` stale (Codex #9) | G6 frescor por `synced_at` → neutro |
| 12 | RPC vira oráculo amplo de cliente (Codex #10) | staff-gate + `pode_ver_carteira_completa` nos absolutos (postura 2a aceita) |
| 13 | CMC retroativo recalculado | base consistente (ambos via Omie hoje); aceito (§5.5) |
| 14 | Identidade do cliente mismapeada | `customer_user_id` mapeado (Fase 0); risco herdado |

## 11. Refs
Spec 2a: `docs/superpowers/specs/2026-06-14-cockpit-preco-markup-cmc-design.md`. Ponte de conta: RPC `get_preco_cockpit` + reposição `20260606190000`. `order_date_kpi`/`dInc`: `omie-vendas-sync`. Challenge Codex 2b: `/tmp/codex-2b-challenge.log` (15/06).

## 12. Changelog do challenge Codex (2026-06-15)
Rodado gpt-5.5 xhigh (131k tok). **9 achados** (2 crít · 5 alta · 3 média) + 4 pontos confirmados sólidos. **Todos os válidos foldados.** Aterrados no schema real (status vocab; **sem coluna `unidade`**; **89% `order_date_kpi`==`created_at`**; `discount` em 2 camadas; `customer_user_id` direto em `order_items`; `omie_payload` tem `dInc`). **Residuais honestos (sem dado pra fechar):** troca de unidade sutil (sem coluna de unidade) e devolução pós-faturado (sem status de devolução) — ambos mitigados por quarentena/allowlist mas não 100% elimináveis no v1.
