# Oben PME/PMR — Frente A: régua honesta e sensores (2026-10-31)

- **Spec da leva:** `docs/superpowers/specs/2026-10-31-oben-pme-pmr-plano-design.md` §4 (Frente A).
- **PRs:** item 1 (sensor de ruptura) — este diário é atualizado por item.
- **Provas:** `db/test-reposicao-ruptura-sensor.sh` (marcador `PROVA-REPOSICAO-RUPTURA-SENSOR-OK`, `LC_ALL=C` e `pt_BR.UTF-8`, 20 sabotagens).

## O que o banco disse antes do desenho (psql-ro, 2026-10-31)

Três premissas do briefing não batem com a prod — e cada uma mudou o desenho:

| Premissa do briefing | Medido | Consequência |
|---|---|---|
| Sensor de ruptura na fronteira do ATP (`atp_gate_pedido` / `atp_decisoes`) | 1.186 pedidos Oben em 90 d vieram do Omie (`hash_payload 'omie_%'`), **1** nasceu no app; `atp_decisoes` tem 1 linha desde 2026-08-08 | A fronteira é a **importação** do PV (`criar_pedidos_com_itens`). O sensor vive num trigger de `order_items`. |
| "Item pedido × item atendido" | Não há vínculo PV ↔ NF-e armazenado: `venda_items_history.raw_data` é o `det` da NF-e (só `prod`, sem `xPed`/`nIdPedido`); `omie_payload` é NULL no importado | Não dá para medir "faturado"; o que se prova é **item pedido × estoque no instante da importação** (PV já faturado = `indeterminado`). |
| Série de estoque em `fin_projecao_snapshots.indicadores.estoque_valor` | A tabela não tem `indicadores`: só `dados` (semanas), `ncg`, `liquidez_operacional_liquida`, `saldo_tesouraria`, `dias_cobertura`, `premissas.{curvas}`; e não há histórico diário de saldo por SKU (`cmc_ledger.saldo` só muda com o CMC) | Item 3 vira "persistir a partir de agora" (coluna dedicada, 1 writer); o passado não se fabrica. |

Outras medições que entram no desenho:

- **Orçamento sem estoque antes do pedido:** sem denominador — 1 `orcamento` e 1 `rascunho` do app em 180 d. Registrado, não fabricado.
- **Duas posições de estoque, nenhuma completa** (361 SKUs com venda em 90 d): `inventory_position` 'vendas' (sync 30 min) tem 281 positivos + 2 zeros confirmados e **nenhuma linha para 78** (o Omie só lista saldo ≠ 0 até o zeramento ser confirmado); `sku_estoque_atual` 'OBEN' (`omie-sync-estoque`, 2 h em horário comercial) traz **zero explícito para 20 desses 78** e nada para os outros 58. Sem divergência quando as duas são frescas. ⇒ o sensor lê a UNIÃO (1ª fonte fresca vence; senão a 2ª; senão `sem_leitura`).
- **Linha de base de prateleira (dry-run da função, 2026-10-31):** 361 SKUs com venda em 90 d · R$ 1,16 mi · 2 sem saldo na 1ª fonte (+20 zeros da 2ª) · 58 sem leitura.
- `analytics_outbox` **purga em 7 dias** (`purgar_em`): o ledger não guarda série; um sensor com denominador semanal mora em tabela própria (a durabilidade do ledger é o PostHog, pelo drain).

## Item 1 — sensor de ruptura / fill-rate (migration `20261031200000`)

- (A) `reposicao_ruptura_pedido_itens`: trigger `AFTER INSERT` em `order_items` (`hash_payload 'omie_%'`, PV da Oben), 1ª leitura vence (`UNIQUE (sales_order_id, sku, coalesce(item,0))`), **fail-open** (nunca trava a importação; a perda aparece em `cobertura_pct`). `leitura ∈ {atendivel, ruptura, indeterminado, sem_leitura}`; `estoque_fonte` diz de onde veio o saldo.
- (B) `reposicao_ruptura_prateleira_diaria`: 1 linha/dia por `reposicao_ruptura_prateleira_registrar()` (owner-only, cron SQL-direto `10 10 * * *`), SKUs com NF-e de venda nos 90 d anteriores (devolução x202 fora) × saldo fresco. Sem venda nos 90 d → não grava (ausente ≠ zero).
- "Quando medir": `v_reposicao_ruptura_pedidos_semana` (fill-rate só com ≥ 20 itens decididos; cobertura = registrados / importados) e `v_reposicao_ruptura_prateleira_semana`. Guardrail da Frente C: queda > 1 p.p. entre semanas FECHADAS (`variacaoFillRatePp` em `src/lib/financeiro/ruptura-sensor-helpers.ts`).
- Superfície: card "Oben — sensor de ruptura" na aba Ciclo (`CicloRupturaSensor`, abaixo da dobra, só Oben).
- Lições de falsificação: duas sabotagens ficaram **verdes na 1ª rodada** por defesa em profundidade real — o pedido do app é barrado pelo `WHEN` do trigger **e** pela checagem do hash na função; a quantidade zero é barrada pelo guard do writer **e** pelo `CHECK` da tabela. A prova passou a tirar as duas camadas de cada par (money-path: "sabote uma camada por vez: a que fica VERDE é redundante ou inalcançada").

## Item 5 — corante na demanda (Fase 2): critério NÃO atendido, parado aqui

`db/consultas/reconciliacao-corante-fase2.sql` rodada em prod (psql-ro, 2026-10-31): **`VEREDITO = nao_medido`** — 0 WP elegíveis (recebido 0 L, retirado 0,00 L e dosado 0,000 L em todos os 14 WP desde a linha de base de 27/10). Critério 1 (≥ 90 d de cobertura contínua desde 2026-10-27) só pode fechar a partir de **2027-01-25**; critério 3 (≥ 1 sinal de uso da aba): `analytics_outbox` tem **0** `reposicao.corantes_aberta`. Nada de `v_sku_demanda_efetiva` muda nesta leva. Quando medir de novo: a mesma consulta + `SELECT count(*) FROM analytics_outbox WHERE evento = 'reposicao.corantes_aberta'` (lembrando a purga de 7 d — a contagem durável é no PostHog via HogQL).

### Linha de base da prateleira (aplicada 2026-10-31, `db:aplicar` tentativa #809)

| medida | valor |
|---|---|
| SKUs Oben com NF-e de venda nos 90 d | 361 (R$ 1.163.098) |
| sem saldo nas duas fontes frescas | 22 (R$ 38.307) → 7,3 % dos SKUs lidos · 3,5 % do valor |
| sem leitura (nenhuma fonte fresca ≤ 48 h) | 58 (R$ 74.997) → 16,1 % — **fora do denominador**, não "zero" |

Lição que o teste de carga cobrou: 1 vaga da `filaCiclo` com 2 leituras dentro fura o teto de 2 RPCs em voo
(`CicloTab.carga.test` mede o pico). Cada leitura toma a própria vaga.

### Correção de universo (migration `20261031200100`, CI da PR 1)

Três gates do CI reprovaram a 1ª migration e viraram uma 2ª (a aplicada é imutável):

- **`universo-pedidos`**: toda leitura de `sales_orders` leva o par canônico `<alias>.status NOT IN (cancelado,
  rascunho, pendente, orcamento)` + `<alias>.deleted_at IS NULL` (autoridade em `src/lib/farmer/universo-pedidos.ts`).
  O trigger e o denominador de cobertura da view ganharam o par; PV cancelado/apagado **não registra** mais (antes
  registrava como `indeterminado` e a view o descartava — o filtro `status_pv <> 'cancelado'` virou camada
  inalcançada e saiu, com a sabotagem dele). Prova: 24 sabotagens (C e pt_BR), 5 novas sobre o universo.
- **`AUTHZ_FUNCOES_FECHADAS`**: SECDEF em `ACKNOWLEDGED_SENSITIVE` precisa de entrada no allowlist de EXECUTE
  (`scripts/authz-funcoes-fechadas.ts`), com privilégios medidos na prod (anon/authenticated/service_role = false).
- **`hoje-utc`**: `toISOString().slice(0, 10)` é dia UTC, mesmo sobre uma data já de SP — `semanaDe` passou a usar
  `addDias` de `@/lib/time/sp-day`.
