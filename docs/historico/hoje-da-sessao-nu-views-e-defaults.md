# O dia da sessão lido nu, fase 2: 18 views, 6 DEFAULTs e o que a prod ensinou

**2026-09-30.** Branch `fix/hoje-sp-views-defaults-classe-ii`: a migration
`20260930230623_hoje_sp_views_defaults_classe_ii.sql`, a fixture
`db/fixtures/hoje-sp-views-defaults-predecessoras-prod-20260930.sql`, a prova
`db/test-hoje-sp-views-defaults.sh` (núcleo de CI, `129 falsificar=33`) e uma forma nova no gate
`scripts/relogio-nu-da-sessao-gate.ts`. Segue a fase 1 de
[hoje-da-sessao-nu-funcoes-e-skills.md](hoje-da-sessao-nu-funcoes-e-skills.md) (7 funções, skills, o gate).

## Passo 0 — instância única ou classe?

Classe, a mesma da fase 1: a prod roda sessão `TimeZone=UTC` (0 overrides em `pg_db_role_setting`,
remedido via psql-ro em 30/09), e `CURRENT_DATE`, `now()::date` e `col_timestamptz::date` usam o fuso da
SESSÃO — das 21:00 às 23:59 BRT, o dia seguinte ao de São Paulo. Esta fase é a das views, matviews e
DEFAULTs, que nenhum gate textual vê quando vivem só na prod (9 das 20 views não têm CREATE no repo).

## A varredura — com a assinatura do PRÓPRIO gate

A prod primeiro. As definições (`pg_get_viewdef(oid, true)`, `pg_get_expr`, `pg_get_constraintdef`, as
policies e os comandos de cron) foram exportadas e passadas pelo `detectarNoSql` do gate — a assinatura
calibrada, não um regex novo.

| Universo (prod) | Denominador | Casam | Veredito |
|---|---|---|---|
| views | 84 (83 em `public` + 1 em `private`) | 20 | 18 consertadas · 2 da família `data_ciclo` (fora, abaixo) |
| matviews | 5 | 2 | latentes (abaixo) |
| DEFAULTs de coluna | 1.570 (1.439 em `public`) | 10 | 6 consertados · 4 fora com veredito |
| CHECKs / policies / crons | 424 / 749 / 99 | 0 | — |
| **DEFAULT de parâmetro de função** (universo novo) | 91 funções com default | 7 com relógio | 4 `p_data_ciclo date DEFAULT CURRENT_DATE` (família `data_ciclo`) · 3 `timestamptz DEFAULT now()` (instante: fora da classe) |

A varredura por `prosrc` da fase 1 não lia `proargdefaults` — o default de parâmetro é um universo à
parte, e os 4 que casam são exatamente a família que ficou de fora aqui.

### As 20 views, sítio a sítio (76 sítios nas 18 consertadas)

| View | Sítios | Consumidor | Veredito |
|---|---|---|---|
| `fin_aging_pagar` / `fin_aging_receber` | 16 / 16 | financeiro, cockpit, dashboard, alerta de 90+ | **afetado** — o título que vence hoje vira "vencido 1-30" às 21h (em 30/09: 17 a receber, R$ 8.511,52; 6 a pagar, R$ 34.372,97) |
| `v_grupo_contas_receber` / `_por_doc` | 8 / 1 | GrupoCliente360 | **afetado** (latente por dado: 0 grupos cadastrados) |
| `v_grupo_comercial` | 5 + `so.created_at::date` | GrupoCliente360 | **afetado** — os DOIS lados mudam juntos (trocar só o hoje daria recência −1) |
| `v_caca_candidatos` / `v_caca_compradores` | 3 / 2 | Caça, dashboard do hunter | **afetado** — recência +1 à noite (a fronteira "dormente"); e o `(now() - '6 mons')::date` do `ativo_6m`, que a assinatura não via |
| `v_sku_parametros_sugeridos` | 2 | revisão de parâmetros, embalagem, baixo giro, negociação; 6 funções | **afetado** — janela de 180 dias e `calculado_em` |
| `v_sku_sigma_demanda` / `_demanda_rajada` / `_demanda_estatisticas` | 3 / 4 / 1 | alimentam parâmetros e ABC/XYZ | **afetado** — o "ontem" da série de sigma virava o hoje de SP; as janelas andavam um dia |
| `v_sku_leadtime_estatisticas` | 2 | alimenta parâmetros | **afetado** — e a borda contra TIMESTAMPTZ (abaixo) |
| `v_fornecedor_lt_logistica_total` | 1 | via `v_sku_lt_teorico` | **afetado** (latente por dado: 0 etapas com `valido_ate`) |
| `v_sku_candidatos_primeira_compra` | 2 | revisão de parâmetros | **afetado** — "últ. há N dias" +1 |
| `v_sku_aumento_vigente` | 1 | detalhe do aumento; `v_oportunidade_economica_hoje` | **afetado** — retrovisor de 7 dias de exibição (não decide pedido) |
| `v_sugestao_negociacao_ativa` | 2 | badges, "Expira em N dias" | **afetado** (latente por dado: 325 sugestões, todas `ignorada`) |
| `v_desconto_flat_condicional_ativo` | 4 | nenhum | **latente** (sem consumidor) — consertada pelo mesmo custo |
| `fin_fluxo_caixa_diario` | 2 | nenhum (as skills a marcam QUEBRADA) | **latente** — consertada pelo mesmo custo |
| `v_oportunidade_economica_hoje` | 5 | Mercado, Oportunidades, badge; `gerar_pedidos_oportunidade_ciclo` | **fora — família `data_ciclo`** |
| `v_promocao_avaliacao_hoje` | 2 | `aplicar_promocoes_no_ciclo` | **fora — família `data_ciclo`** |

**Matviews.** `private.mv_oportunidade_badge`: o `calculado_em` não tem leitor (a view-gate lê só a
contagem) e a contagem vem de `v_oportunidade_economica_hoje` — latente. `private.mv_sku_ranking_negociacao_paralela`:
dormente (sem chamador desde 06/2026), refresh segunda 07:00 BRT — latente. Consertá-las exigiria
`DROP` + `CREATE`.

**DEFAULTs.** Consertados (o leitor, quando existe, é de SP): `priority_score_log.score_date` (sem leitor;
**46.328 de 1,39 mi linhas** vieram de 8 execuções manuais noturnas com o dia de amanhã),
`sugestao_negociacao_paralela.data_geracao` (5/325 divergentes) e `.valido_ate` (lido pela view
consertada), `fornecedor_cadeia_logistica.valido_desde` (2/10; só exibido),
`sku_embalagem_equivalencia.vigente_desde` (sem leitor) e `farmer_agenda.agenda_date` (tabela órfã).
Fora: `pedido_compra_sugerido.data_ciclo` (nunca exercido — todo escritor passa a data; família
`data_ciclo`), `route_visits.visit_date` (leitores MISTOS: o planner e os KPIs de 30 dias leem o hoje UTC,
o MTD e a positivação o mês de SP — trocar só o DEFAULT move a divergência; 0 linhas hoje) e os 2
`medido_em` dos sensores de parâmetros (UTC contra UTC: gravam e releem `CURRENT_DATE` explícito, crons
08:30/08:45 BRT).

## O que a prod ensinou (e o que mudou por causa disso)

- **A família `data_ciclo` não é "UTC por construção" — é SP na prática, com UMA porta UTC.** Das 19
  execuções noturnas do motor, 18 gravaram o dia de SP: o botão "recalcular" da tela Pedidos chama a RPC
  com `format(new Date())` (o navegador). Só o botão do Cockpit passa pela edge `gerar-pedidos-diario`
  (`toISOString`, UTC) — e aí a RPC expira os pendentes com `data_ciclo < p_data_ciclo`: o ciclo de HOJE.
  `v_oportunidade_economica_hoje` decide quais promoções entram num pedido cujo `data_ciclo` vem desse
  mesmo mundo (e do `DEFAULT CURRENT_DATE` de `ciclo_oportunidade_do_dia`): trocar só a view abriria
  pedido de oportunidade com ciclo D+1 para promoção que termina em D. Medido: 0 ciclos de oportunidade na
  janela, 0 campanhas ativas. Ficou fora, com a pergunta de negócio aberta — o que é "hoje" de um ciclo
  disparado depois do corte das 18h?
- **A borda contra TIMESTAMPTZ.** `sku_leadtime_history.t2_data_faturamento` é timestamptz, e
  `dia - '180 days'` é timestamp sem fuso: compará-los converte no fuso da SESSÃO. A troca ingênua (só o
  dia) deixaria a borda às 21:00 BRT de D-181 sob sessão UTC — o dia inteiro. Lá o conserto é o instante:
  `(dia_sp - '180 days') AT TIME ZONE 'America/Sao_Paulo'`. A prova tem uma amostra na faixa de 3h e a
  sabotagem `leadtime_borda_ingenua` (só o b cai). Nenhum gate textual vê isto: o tipo não está no texto
  — limite declarado no gate.
- **A forma que a assinatura não casava.** `(now() - '6 mons'::interval)::date` (o `ativo_6m` da Caça):
  o relógio com aritmética antes do cast. 1 sítio no universo inteiro (prod e repo); virou FORMA do gate,
  calibrada nos arquivos reais (a fixture casa, a migration não) e com mutação no `.mut`.
- **`order_date_kpi` noturno é UTC para o pedido nativo do app** (42 de 44 criados após 21h BRT) — o sync
  da Omie já usa o dia de SP; o dado torto vem da `data_previsao` que o app manda em UTC (classe irmã no
  TypeScript). Efeito aqui: quem comprou pelo app NA MESMA NOITE vê recência −1 na Caça até a meia-noite;
  todos os outros deixam de ver +1. Aceito e registrado.
- **A trava tem ORDEM.** Leitores travam de fora para dentro (a view lida, as filhas, as netas) — medido
  no PG17 com o schema da prod: um leitor de `v_oportunidade_economica_hoje` prende `v_sku_aumento_vigente`
  antes de `v_sku_parametros_sugeridos`; um de parâmetros prende rajada, lead time, sigma e só então as
  netas. A trava em ordem alfabética abria deadlock com a tela ou o cron lendo a cadeia; o K3 fixa a ordem.
- **O snapshot perdeu as barras invertidas** dos literais de regex (`'\D'` virou `'D'` em 5 views) — as
  predecessoras vêm da fixture, com md5 conferido (P01-P18).
- **Fora da classe, anotado:** `fin_fluxo_caixa_diario` filtra o vocabulário de status morto
  (`ABERTO/PARCIAL/VENCIDO` — os previstos saem zerados; é essa a view "quebrada" das skills, não o aging,
  que volta com dado); a histerese de `atualizar_classificacao_skus` se chama "meses" mas conta INVOCAÇÕES
  (o cron a chama a cada 2h — de 5 a 18 SKUs mudam de classe por dia).

## A prova — 129 asserts, 33 sabotagens

PG17 com o schema-snapshot da prod, as predecessoras da fixture e o ACL de prod nas 18 views (o snapshot
vem sem privilégios — sem ele a POS6 comparava NULL com NULL). Relógio controlado (`test.agora`, tripwire
Z9T01); a guarda de sombra pergunta ao catálogo de quais funções de `public` que sombreiam `pg_catalog` as
views e os DEFAULTs DEPENDEM (o snapshot tem `public.set_config`). Por objeto, 4 asserts nos instantes
20:59:59 · 21:00:00 · 23:59:59 BRT de D e 00:00:00 de D+1 (a: 21:00 = 20:59:59 sob UTC; b: UTC = SP às
23:59:59; c: controle POSITIVO, muda à 00:00 de SP; d: a sob SP). Sementes com data LITERAL, cada linha
posicionada para entrar em D e sair em D+1 — inclusive um SKU candidato à 1ª compra de verdade. P01-P24,
K1-K3, Z0, G1-G5 (a PRÉ e a PÓS postas à prova com o SQL rodando dentro de função, como no `aplicar_sql`).

A falsificação pegou dois defeitos da própria prova antes do verde: os G re-executavam a migration depois
da sabotagem (a PRÉ acusava, com razão, predecessora divergente — os G passaram para antes); e o c de
candidatos e parâmetros não cai com o relógio próprio sabotado, porque as filhas consertadas mudam à
meia-noite de SP (lá o dente é a/b, declarado). Matriz: servidor SP/UTC × `lc_messages` C/pt_BR — 129/129
nas 4.

## Codex

`scripts/codex-async.sh -r max`: **exit 79** — cota em 86% (teto 85%), janela reabre 03/10 19:11; o
wrapper não gastou a chamada. Caminho B: a prova falsificável acima + desafio adversário próprio (as 6
perguntas do prompt, respondidas no PR). **REVISÃO INDEPENDENTE PENDENTE** — rodar o Codex retroativo
quando a janela reabrir (o prompt está no PR).

## Fora, com dono

- **Classe irmã no TypeScript + a família `data_ciclo`** (chip): 94 sítios de produção de
  `toISOString().slice(0, 10)` como "hoje" (58 no front, 36 em edges), 49 afetados — o botão do Cockpit que
  expira o ciclo de hoje, `fin-cashflow-engine`, a `data_previsao` enviada ao Omie, os hooks de visita — e,
  juntos, `v_oportunidade_economica_hoje`, `v_promocao_avaliacao_hoje`, os 4 DEFAULTs de parâmetro e o
  DEFAULT de `data_ciclo`, e `route_visits.visit_date` com os leitores UTC. Não existe gate para TS.
