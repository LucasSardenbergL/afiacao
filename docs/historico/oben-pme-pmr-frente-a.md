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

## Itens 2 e 3 — régua honesta do card e série de estoque (PR 2, migration `20261031210000`)

**O que o card da empresa passa a dizer** (`CicloEmpresaCards.tsx`, regra pura em `regua-ciclo-helpers.ts`):

- **DSO ao lado do PMR**, com a convenção no tooltip das duas células: *PMR = só títulos PAGOS (ponderado pelo valor
  baixado; vencido não entra) · DSO = carteira ABERTA toda ÷ receita de competência TTM × 365*. Oben em 31/10:
  R$ 645.925 abertos ÷ R$ 11.287/dia ≈ **57 d** contra PMR ≈ 31 d — a diferença é a carteira vencida, que o PMR
  por desenho não vê. Teto de plausibilidade 730 d (acima vira null + motivo, como no `dso-dpo-helpers`).
- **1 dia de PME = CMV TTM ÷ 365** (e não receita — o PME é sobre custo). CMV espelha `estoque-pme.ts` da edge:
  12 meses fechados, 1 linha por mês, Σ > 0; faltando um mês → null com "cobre N/12 (último: AAAA-MM)".
- **Estoque de giro** ganha hora do último sync (`inventory_position` da conta da empresa) e **cobertura de custo**
  (`fin_estoque_giro_valor.cobertura_pct`). Sem sync ou sem cobertura lida é dito, não omitido.
- **Ciclo** rotulado "soma de bases distintas" (foto de estoque + prazo dos pagos − CP total).
- **PME pelo estoque MÉDIO dos 90 d**: média dos pontos diários (1 por dia de SP, o último vence) ÷ CMV TTM × 365.
  Só com ≥ 60 dias cobertos e todos com cobertura de custo ok; senão null com "cobre N/90 dias (desde …)".

**De onde vem a série** (item 3): o snapshot diário do `fin-cashflow-engine` (cron, `save_snapshot: true`) passa a
gravar `estoque_valor`, `estoque_fonte`, `estoque_cobertura_ok` e `cmv_ttm` em **colunas dedicadas** de
`fin_projecao_snapshots` (engine v2.2) — não em `premissas` (jsonb multi-chave; sinal money-path pede coluna + 1
writer). CHECKs fecham faixa (NaN, ≥ 0, teto) e o par (valor sem fonte é fabricação); índice parcial
`(company, cenario, snapshot_at DESC) WHERE estoque_fonte IS NOT NULL` serve a leitura dos 90 d.
**A série nasce no 1º snapshot após o deploy da edge** — até lá o card diz "série de estoque ainda sem ponto";
o PME médio só aparece a partir de ~60 dias depois (meados de jan/2027). Ordem de deploy: migration → edge.

**Lições:**

- `premissas` já carregava `estoque_fonte` como marca (37 snapshots em 30 d) e NUNCA `estoque_valor` — o jsonb
  era "tem fonte", não "qual valor". A série precisava de coluna.
- O `CicloTab.carga.test` vigia o pico de leituras em voo: hook com 4 leituras por empresa toma UMA vaga da
  `filaCiclo` e lê em SÉRIE dentro dela (nunca `Promise.all` dentro da vaga).

## Item 5 — corante na demanda (Fase 2): critério NÃO atendido, parado aqui

`db/consultas/reconciliacao-corante-fase2.sql` rodada em prod (psql-ro, 2026-10-31): **`VEREDITO = nao_medido`** — 0 WP elegíveis (recebido 0 L, retirado 0,00 L e dosado 0,000 L em todos os 14 WP desde a linha de base de 27/10). Critério 1 (≥ 90 d de cobertura contínua desde 2026-10-27) só pode fechar a partir de **2027-01-25**; critério 3 (≥ 1 sinal de uso da aba): `analytics_outbox` tem **0** `reposicao.corantes_aberta`. Nada de `v_sku_demanda_efetiva` muda nesta leva. Quando medir de novo: a mesma consulta + `SELECT count(*) FROM analytics_outbox WHERE evento = 'reposicao.corantes_aberta'` (lembrando a purga de 7 d — a contagem durável é no PostHog via HogQL).

### Remedição 2026-11-01 — o bloqueio real é a FONTE, não o relógio (corrige a data acima)

A mesma consulta, de novo em prod (psql-ro, 2026-11-01 ~15Z): **`nao_medido`**, os 14 WP com recebido, retirado e
dosado em zero. Mas a data de 2027-01-25 acima está **errada**: ela conta 90 d a partir da linha de base, e o
critério 1 é cobertura contínua de DOSAGEM — que ainda não começou, porque nenhuma dosagem chegou ao banco:

| tabela (prod) | linhas, desde sempre |
|---|---|
| `tint_consumo_corante` · `tint_consumo_preparacao` | 0 · 0 |
| `tint_consumo_planos` · `tint_consumo_extracoes` · `tint_consumo_extracao_lotes` | 0 · 0 · 0 |
| `tint_vendas` · `tint_vendas_itens` | 0 · 0 |
| `tint_sync_runs` com `sync_type` de preparação | 0 (o conector 0.2.6 envia só `catalogs`, `formulas`, `keys_snapshot`) |

Causa, lida no código da `origin/main`: o cliente do plano (`PlanoPreparacoes`, Task 9 do plano
`docs/superpowers/plans/2026-10-27-giro-corante-fase1.md`) existe no `sayersync`, mas **só os testes o chamam** —
o ciclo não pede `/preparations/plano` nem envia lote. Ligá-lo são as **Tasks 11–12** do mesmo plano, que estão
**🚧 à espera do passo 0 do founder** (spec `2026-10-27-giro-corante-reposicao-design.md` §"Passo 0 — Prova da
fonte"): as consultas no SayerSystem, sem a coluna `cliente`, que dizem chave, formato do corante, unidade,
profundidade e se a linha nasce na dosagem executada.

Portanto o item 5 não "fecha sozinho em 2027-01": a sequência é **passo 0 (founder) → Tasks 11–12 (conector,
nova versão publicada na loja) → 90 d de dosagem contínua → esta consulta** → só então `v_sku_demanda_efetiva`.
O sinal de que o relógio começou é `SELECT count(*), min(data_dosagem) FROM tint_consumo_corante` sair de zero.

Observação lateral, não incidente: o conector da loja não envia nada desde 2026-10-31 05:17 BRT (sábado). O fim
de semana de 17–18/10 também teve zero runs e o de 24–25/10 rodou contínuo, então é compatível com o PC da loja
desligado. Confirma-se na segunda: `SELECT max(started_at) FROM tint_sync_runs`.

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

## Item 4 — coortes com maturação fixa D+15/30/60 (PR 3, migration `20261101120000`)

**Por quê:** a `v_ciclo_empresa_coorte` publica "% pago" com o que foi liquidado ATÉ HOJE — a coorte de setembro parece pior que a de março só porque teve menos tempo. A régua honesta lê cada coorte (mês de **vencimento**) em janelas fixas após o vencimento.

**O que o banco disse antes (psql-ro, 2026-11-01):** `fin_contas_receber.data_recebimento` é NULL em 100 % dos títulos dos 12 meses, nas 3 empresas — a data de pagamento só existe em `v_titulo_baixas.data_baixa_final` (última baixa do título). Por isso a maturação parte de `v_ciclo_cr_titulos` (universo já saneado) e o título conta pelo valor do documento inteiro na data da ÚLTIMA baixa — mesma convenção da situação `paga`. `paga_sem_baixa` = 0 em todos os meses medidos, mas a massa "pago sem data" existe no desenho (ausente ≠ zero: quando > 0 os D+N viram **piso**, com † na tabela).

**View `v_ciclo_empresa_coorte_maturacao`** (`security_invoker=on`, anon fora) + **RPC `fin_ciclo_empresa_coorte_maturacao()`** (SECDEF, `search_path=''`, `_fin_ciclo_gate_master` + `fin_user_can_access`, anon/PUBLIC revogados nominalmente). Não substitui a view/RPC antigas.
- `pct_pago_d15/d30/d60` = Σ valor dos títulos pagos até vencimento + N / Σ valor vencido no mês — **só quando `maduro_dN`** (último dia do mês + N < hoje SP); imatura = NULL + flag, nunca número parcial.
- Massas **separadas**: `valor_antecipado` (baixa < vencimento), `valor_pago_no_dia`, `valor_pago_com_atraso`, `valor_pago_sem_data`, `valor_em_aberto` (saldo); `dias_antecipacao_pond` e `dias_atraso_pond` ponderados por valor, cada um só na sua massa — antecipação nunca compensa atraso.
- Janela de 365 d no vencimento (como a coorte antiga); vencida aberta antiga some.
- Prova `db/test-fin-ciclo-coorte-maturacao.sh` (`nucleo-ci.txt`): controle verde + **16 sabotagens** em C e pt_BR — antecipação somada ao atraso, imatura publicando número, D+30 pela emissão, janela aberta, sem-data contado, aberto pelo documento, dias sem ponderar, flag D+60 pela de D+15, invoker/gate/ACL em 2 camadas (postcondição aborta; neutralizada, a asserção fica vermelha). O que a prova NÃO cobre: o off-by-one do `<` na maturidade (exigiria um mês cujo fim + N caia exatamente em hoje — não é construível com `now()`; o caso é lido pela postura "fim + N **<** hoje", conservadora).

**Superfície:** tabela de maturação em `CicloTendencia.tsx` (`ciclo-maturacao-<empresa>`), do mês mais recente ao mais antigo: Vencimento · nº títulos · D+15 · D+30 · D+60 (imatura = "—", célula esmaecida com o motivo no title) · Antecip. % · Atraso (dias ponderados) · Em aberto %. O tooltip do gráfico trocou o "% pago cru" pela maturação do mês. Hook `useCicloCoorteMaturacao` (1 vaga da `filaCiclo`, paginado), regra pura em `coorte-maturacao-helpers.ts` (imatura → null mesmo que o banco mande número; flag ilegível = imatura). Sem alerta universal "<90 %" (cortado pelo founder).

**Parecer Codex (reasoning max, 2026-11-01) — o que entrou:** (1) `mes_parcial` na view (mês corrente e o mais antigo quando a janela de 365 d não começa no dia 1) com `*` na tabela — a coorte é um recorte, não o mês; (2) a convenção "título pelo valor **integral** na data da **última** baixa; não é recebimento parcial acumulado" no cabeçalho, no title do D+N e no COMMENT da view (baixa parcial de R$ 900 em D+10 + R$ 100 em D+40 publica 0 % em D+15/30 — viés para baixo, declarado); (3) % exibido por **piso** (`pisoPct`: 0,99996 → 99,9 %, só 1 vira 100,0 %) e o † de "pago sem data" decidido pelo valor **bruto**, não pelo % arredondado; (4) tooltip do gráfico traz "piso" quando há sem-data e **não publica cache** após erro de leitura; (5) massas não formam partição (em aberto é saldo; baixa parcial fica fora de todas) — declarado, a UI não soma; (6) dias ponderados negativos / massa negativa = dado ilegível → null / linha descartada. **Prova reescrita com relógio controlado** (`public.now()` lendo `test.agora`, padrão de `test-hoje-sp-views-defaults.sh`): fixture em datas absolutas, hoje = 16/11/2026, e as bordas provadas nos dois lados — out/2026 (fim 31/10 + 15 = 15/11) publica D+15 em 16/11 e **não** em 15/11 nem às 23:59:59 de SP; pago em D+15 exato conta (`<=`), em D+16 não — com as sabotagens `<`→`<=` (maturidade) e `<=`→`<` (pagamento) vermelhas. Fora: o `fin_user_can_access` real de prod devolve true para qualquer master/employee (a prova mostra que a RPC **aplica** o predicado; a restrição por empresa é do stub).
