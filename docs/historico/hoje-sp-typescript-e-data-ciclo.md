# O dia da sessão lido nu, fase 3: a família data_ciclo e o "hoje" UTC no TypeScript

**2026-09-30/10-01.** Branch `fix/hoje-sp-typescript-e-data-ciclo`. Segue
[hoje-da-sessao-nu-views-e-defaults.md](hoje-da-sessao-nu-views-e-defaults.md) (fase 2: 18 views, 6 DEFAULTs)
e [hoje-da-sessao-nu-funcoes-e-skills.md](hoje-da-sessao-nu-funcoes-e-skills.md) (fase 1: 7 funções, skills,
o gate). Esta fase tem duas metades que andam juntas: a **família data_ciclo** no banco (o que as fases 1 e 2
deixaram de fora de propósito) e a **classe irmã no TypeScript** — `new Date().toISOString().slice(0, 10)`
como "hoje", no navegador e nas edges.

## Passo 0 — instância única ou classe?

Classe, a mesma das fases 1 e 2, agora no TypeScript: `toISOString()` é UTC — no navegador e no servidor do
Deno —, e das 21:00 às 23:59 BRT o dia UTC já é o seguinte ao de São Paulo. No Deno, `getDate()`/`getMonth()`/
`toLocaleDateString()` sem `timeZone` também são UTC (o servidor roda em UTC). No navegador, `format(new
Date(), 'yyyy-MM-dd')` (date-fns) e os `get*()` usam o fuso local — SP — e estão certos.

## As decisões do founder (antes do desenho)

1. **O "hoje" de um ciclo disparado depois do corte das 18h é o dia de SP**, com o corte já passado — não o
   próximo dia útil. É o que o botão "recalcular" da tela Pedidos sempre fez (`format(new Date())`).
2. **Os horários de corte são hora de SP** (o 18:00 do ciclo de oportunidade e `horario_corte_pedido` do
   fornecedor), e o conserto vai junto.

## O que a prod mostrou (psql-ro, 2026-09-30/10-01)

- **data_ciclo já era o dia de SP na prática.** Das 20 execuções do motor depois das 21h BRT, 19 gravaram o
  dia de SP (o "recalcular" da tela Pedidos). A única que gravou o dia seguinte veio do botão do Cockpit:
  `gerar-pedidos-diario` sem `data_ciclo` → `toISOString` → ciclo D+1, e a RPC expirou os pendentes com
  `data_ciclo < p_data_ciclo` — os de HOJE. O "UTC contra UTC" com que as fases 1 e 2 classificaram
  `_data_health_compute`, `atualizar_parametros_numericos_skus` e `reposicao_pos_candidatos` era falso.
- **O corte gravado 3h antes.** `(data + hora)::timestamptz` converte no fuso da SESSÃO: os 613 pedidos
  normais têm `horario_corte_planejado` às 10:00 UTC = 07:00 BRT para um corte cadastrado como 10:00 — e o
  disparo roda às 10:00 BRT (cron 13:00 UTC). A coluna só é exibida (modal; o e-mail a seleciona e não a
  usa; `sera_disparado_em` de `aprovar_pedido_sugerido` não tem leitor).
- **Ciclo de oportunidade:** 72 execuções, todas do cron 08:05 BRT, todas `sem_eventos_hoje`; 0 pedidos
  de oportunidade; 0 campanhas ativas. No flagrante de 30/09 às 22:38 BRT (sessão UTC já em 01/10), as 2
  views da família estavam vazias nos dois fusos — latentes por dado.
- **O espelho em TS.** `omie-sync-estoque` repete em TypeScript a janela de 7 dias do em trânsito de
  `atualizar_parametros_numericos_skus` (`new Date()` + `getDate()` no Deno = UTC). Trocar só o SQL criaria a
  divergência que o sync existe para evitar (contar 2× suprime compra; 0× compra dupla).

## A varredura (assinatura re-feita, com a forma que o briefing não pegava)

A regex do briefing casava `split('T')` só com aspas simples: o `split("T")` (8 sítios, entre eles os 3 do
`omie-vendas-sync`) ficava de fora. Com as duas aspas, a forma multi-linha e `slice(0, 16)`/`slice(2, 10)`,
o universo é este (classificação sítio a sítio por dois subagentes read-only, os de gravidade alta
conferidos à mão):

| Universo | Sítios | afetado-alto | afetado-baixo | UTC-consistente | latente | falso-positivo / já-correto |
|---|---|---|---|---|---|---|
| `src/` (`toISOString` fatiado) | 62 (6 em testes) | 21 | 14 | 7 | 4 | 16 |
| edges, forma A (`toISOString` fatiado) | 30 | 5 | 15 | 1 | 2 | 7 |
| edges, forma B (`getDate`/`getDay`/`toLocale*` sem fuso) | 43 | 8 | 18 | 1 | 2 | 6 + 8 já com `timeZone` |

O que a forma B acrescenta é o dia mandado ao Omie montado com `getDate()` no servidor: `dDataPosicao`
(`omie-sync-estoque`, `sync-reprocess` toda noite, `omie-analytics-sync`, `omie-vendas-sync`), a previsão de
entrega do pedido de compra (`disparar-pedidos-aprovados`), o vencimento das parcelas da OS (`omie-sync`) e o
extrato da tesouraria (`omie-financeiro`).

## Esta PR (money-path): a família data_ciclo inteira

Migration `20261001023000_hoje_sp_familia_data_ciclo.sql` — o texto VIVO da prod com a troca e nada mais
(gerada por troca exata com contagem conferida; cada view é ponto fixo do deparse):

| Objeto | Sítios | Veredito |
|---|---|---|
| `v_promocao_avaliacao_hoje` | 2 | afetado — `aplicar_promocoes_no_ciclo` a cruza com `pcs.data_ciclo`: com o edge em SP e a view em UTC, a promoção que termina hoje sairia do ciclo de hoje às 21h |
| `v_oportunidade_economica_hoje` | 5 | afetado — janela da campanha (2), `dias_ate_limite` (1), quantidade dos cenários de aumento (2) |
| DEFAULT de `p_data_ciclo` nas 4 RPCs de ciclo | 4 | afetado — o de `ciclo_oportunidade_do_dia` é exercido (cron e botão sem data); os outros 3, não |
| corte de `gerar_pedidos_oportunidade_ciclo` / `gerar_pedidos_sugeridos_ciclo` | 2 | afetado (exibição) — `(data + hora) AT TIME ZONE 'America/Sao_Paulo'` |
| `atualizar_parametros_numericos_skus` / `reposicao_pos_candidatos` | 1 / 1 | afetado — a janela do em trânsito, a idade do PO |
| `_data_health_compute` | 2 | afetado — a frescura da sugestão de compra; **fica com a #2698** (sensor de venda empurrada), que recria a função e escrevia ali o UTC explícito sob a premissa "UTC contra UTC". Coordenado com a sessão dela em 2026-10-01 (mensagem com a medição): 2 migrations recriando a mesma função quente fariam a PRÉ de uma derrubar a outra |
| DEFAULT de `pedido_compra_sugerido.data_ciclo` | 1 | latente (nunca exercido) — vai junto para não sobrar o dia da sessão na família |

O TypeScript da família, no mesmo PR: `gerar-pedidos-diario` (`dataCiclo = hojeSP()`), `omie-sync-estoque`
(o espelho do em trânsito, `dDataPosicao`, a janela do `PesquisarPedCompra` e `data_evento`), e as telas
Oportunidades (a faixa "ciclo hoje" casa com o DEFAULT de `ciclo_oportunidade_do_dia`), Mercado,
PromocaoDetail (encerrar grava `data_fim` = hoje de SP; e o `datetime-local` do evento, que punha a hora UTC
no campo e gravava o instante 3h à frente — sempre, não só à noite), Cadastros e o badge do AppShell. O
helper das edges é `supabase/functions/_shared/hoje-sp.ts` (`hojeSP`, `diaSP`, `somarDias`, `paraDataOmie`;
`formatToParts` com o fuso NOMEADO — o formato de `en-CA` é dado do ICU e já mudou; teste Deno com controle
positivo, virada de ano e o horário de verão de 2018, falsificado em 4 camadas).

Os outros leitores de `data_ciclo` no front já usavam `format(new Date())` (Pedidos, `useReposicaoSessao`,
`ConfirmacaoPanel`) — com esta PR a família inteira fala o mesmo dia.

## A trava — a ordem dos leitores, medida

Nenhuma das 2 views expande para `pedido_compra_sugerido` (pg_depend); nenhum gatilho de `pcs`/`pci` as lê;
só 2 funções as leem. `aplicar_promocoes_no_ciclo` prende `v_promocao_avaliacao_hoje` ANTES da tabela;
`gerar_pedidos_oportunidade_ciclo` apaga na tabela ANTES de ler `v_oportunidade_economica_hoje`. Daí a ordem
`v_promocao → pcs → v_oportunidade`, e a tabela em ACCESS EXCLUSIVE já na trava (o modo do `SET DEFAULT`):
pegar um modo fraco e subir depois é o próprio deadlock com `gerar_pedidos_oportunidade_ciclo`. As funções
travam por `ALTER FUNCTION` sem efeito — executar uma função não pega lock nela.

## A prova — `db/test-hoje-sp-data-ciclo.sh`

PG17 com o schema-snapshot e a fixture `db/fixtures/hoje-sp-data-ciclo-prod-20261001.sql`. O snapshot é de
05/09: a fixture traz a **deriva de colunas** (14 colunas de `pcs`/`pci` criadas depois — sem elas o motor só
falha EXECUTANDO, `fator_embalagem_portal does not exist`), as 18 views do fecho de dependências no texto
vivo (6 delas são as da fase 2) e as predecessoras. Relógio controlado (`test.agora`, tripwire Z9T01); os
CORPOS das 7 funções com `public` antes de `pg_catalog` (resolvem nomes ao executar — sem isto o now() deles
seria o de parede) e duas guardas de sombra: o que views e DEFAULTs amarraram (pg_depend) e o catálogo
inteiro (só o now() de `public` tem a assinatura de um embutido; o `public.set_config` do snapshot sai).

57 asserts: P01-P10 (cada predecessora e as 18 dependências com o md5 EXATO da prod), K1-K4 (a trava e a
ordem), Z0, G1-G7 (a PRÉ recusa view e função divergentes; a PÓS recusa texto adulterado, ACL mexido,
`security_invoker` perdido e DEFAULT trocado; re-aplicar passa) e, por objeto, os 4 instantes 20:59:59 ·
21:00:00 · 23:59:59 BRT de D e 00:00:00 de D+1 sob sessão UTC e SP. As RPCs são EXECUTADAS: o ciclo de
oportunidade sem data (`promo_e_aumento` em D, `sem_eventos_hoje` em D+1), o motor sem data (`2025-03-12|0`:
o ciclo de hoje, nenhum pendente de hoje expirado — e `2025-03-13|2` à meia-noite de SP), a promoção que
termina hoje aplicada no ciclo de hoje (1 → 0), a idade do PO
(`7|true` → `8|false`), a posição com o a caminho (compra 14 → 18), o DEFAULT da coluna — e o corte: a
oportunidade às 18:00 de SP e o normal às 10:00 de SP sob sessão UTC.

A falsificação pegou um erro meu antes do verde: o DEFAULT da coluna sabotado pelo gêmeo da sessão fica
vermelho também no (c) — o gêmeo vira à meia-noite UTC, não à de SP —, e eu tinha copiado da fase 2 a
declaração "c verde" (lá o c era valor absoluto). E o primeiro verde do F7 comparava texto de `NOTICE` (o
`DROP TABLE IF EXISTS` da RPC): a leitura passou a rodar com `client_min_messages=warning` e o F7 mede o
número (14 → 18).

## Codex

`scripts/codex-async.sh -r max`: **exit 79** (cota em 86%, teto 85%). Com a reserva de money-path
(`CODEX_ASYNC_TETO_SALDO=97`): **exit 75**, o servidor recusou — cota esgotada, reabre em 03/10 19:11; o
plano declarado no token é `prolite`, o de sempre. **Caminho B** (`sem-codex:` no PR), com as 6 perguntas do
prompt respondidas por verificação (trava, corte, janela de deploy, espelhos, a prova, leitores). **REVISÃO
INDEPENDENTE PENDENTE** — o prompt está em `docs/historico/` (este arquivo, abaixo) para o retroativo.

## Deploy — quem faz cada camada

1. **Migration** (eu, `bun run db:aplicar`, fora das 21h–24h e fora dos crons de reposição): ela vem ANTES
   do edge. Com a migration e o edge velho, só o botão noturno do Cockpit diverge — o que já acontecia com o
   "recalcular" da tela Pedidos contra as views em UTC.
2. **Edges** `gerar-pedidos-diario` e `omie-sync-estoque` (founder, pelo chat do Lovable; quem decide é
   `bun run pendencias:deploy`).
3. **Publish** do front (founder).

## Fora, com dono

- **O gate de TS** (a forma `toISOString` fatiada no front e nas edges, e a forma B nas edges, com baseline
  por veredito e mutação) — PR seguinte desta sessão.
- **As fases de TS por domínio**: financeiro (`fin-cashflow-engine` — o domingo à noite pula a semana, a
  mesma classe que a 20260927202603 consertou no SQL —, `fin-funding`, `fin-valor-cockpit`, os eventos de
  caixa persistidos com a data UTC); visitas (`hojeISO()` e os 6 consumidores, o planner, e
  `route_visits.visit_date` com os leitores UTC); as datas mandadas ao Omie (forma B); o resto.
- **Anotado, fora da classe:** `_data_health_compute` converte `saldo_data` (date) em instante no fuso da
  sessão (a idade do saldo sai 3h maior; limiar de 36h); as 4 RPCs de ciclo têm EXECUTE para PUBLIC/anon
  (SECURITY INVOKER: a RLS das tabelas é quem barra).
