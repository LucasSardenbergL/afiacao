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
| `_data_health_compute` | 2 | afetado — a frescura da sugestão de compra; **fica com a #2698** (sensor de venda empurrada), que recria a função e escrevia ali o UTC explícito sob a premissa "UTC contra UTC". Coordenado com a sessão dela em 2026-10-01 (mensagem com a medição): 2 migrations recriando a mesma função quente fariam a PRÉ de uma derrubar a outra. Ela reconferiu (645 de 646 execuções do motor no dia de SP) e adotou o dia de SP nos 2 sítios |
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
CORPOS das 6 funções com `public` antes de `pg_catalog` (resolvem nomes ao executar — sem isto o now() deles
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
INDEPENDENTE PENDENTE** — o retroativo (`scripts/codex-async.sh -r max`) roda depois de 03/10 19:11 com o
contexto do PR #2705 e estas perguntas:

1. Deadlock/lock: a ordem da trava abre ciclo com algum leitor real? ACCESS EXCLUSIVE em pcs durante a transação inteira é problema (o executor tem lock_timeout 15s)?
2. A troca do corte: (date + time) AT TIME ZONE 'America/Sao_Paulo' faz o que se espera para `time` de cadastro? Algum consumidor de horario_corte_planejado decide algo (disparo, expiração, alerta) que mudaria de comportamento?
3. Janela de deploy: migration primeiro, edge depois. Que estado intermediário (migration nova + edge velha, ou o inverso) pode gerar pedido/expiração errada, e quando?
4. O espelho omie-sync-estoque × atualizar_parametros_numericos_skus × gerar_pedidos_sugeridos_ciclo (em_transito): os três agora concordam? Há outro espelho da janela de 7 dias que ficou em UTC?
5. A prova: algum assert passa por vacuidade? A prova põe search_path public,pg_catalog nos corpos (para o now() controlado) e derruba public.set_config — isso pode esconder um defeito que a prod teria?
6. Algo no front/edge que eu não trouxe e que lê data_ciclo/vigência de campanha com o hoje UTC e que agora divergiria do banco (pior que antes)?
Diga explicitamente o que você NÃO conseguiu verificar.


## Deploy — quem faz cada camada

1. **Migration** — FEITO (eu): `db:aplicar --ensaio` (rodou inteira contra a prod e fez ROLLBACK, marcador
   `FIM_APLICACAO_OK`) e o apply às **00:45 BRT de 01/10** — tentativa #210 virou recibo na mesma transação
   (sha256 `b926c2aea4d6…`). 2ª testemunha (psql-ro, outra conexão): as 2 views com o md5 da POS,
   `security_invoker=on` e ACL idêntico; as 6 funções com o md5 de argumentos e corpo e os atributos; ACL 6/6
   igual ao medido antes; o DEFAULT da coluna em SP; ledger `210 aplicada`. Veio ANTES do edge: com a
   migration e o edge velho, só o botão noturno do Cockpit diverge — o que já acontecia com o "recalcular" da
   tela Pedidos contra as views em UTC.
2. **Edges** `gerar-pedidos-diario` e `omie-sync-estoque` (founder, pelo chat do Lovable; quem decide é
   `bun run pendencias:deploy`).
3. **Publish** do front (founder).

## O que a aplicação antes do merge cobra (e o rito)

- `AUTHZ_REESCRITAS_CONHECIDAS`: a entrada de `reposicao_pos_candidatos` (o patch por âncora de 14/08) foi
  SUPERADA pelo CREATE desta migration — o `authz-gate-check` exige a poda no mesmo PR, e a poda muda o
  contrato do audit `audit`: carimbo regravado (5 audits exit 0; a deriva com 4 `SEM_PAR` — DDL aplicada antes
  do merge, que somem no merge).
- Depois do merge: a entrada PATCH de `reposicao_pos_candidatos` em `db/deriva-corpo-baseline.json` vira
  `BASELINE_OBSOLETA` — sai num PR seguinte com o carimbo limpo (o rito do #2695).
- O guard `embalagem-motor-paridade` exige que `db/embalagem-motor-rpc.sql` seja, do CREATE ao fim, o trecho
  da ÚLTIMA migration que recria o motor — e 3 provas carregam e SABOTAM essa fixture. Por isso o motor vai por
  ÚLTIMO na migration, com uma pós-condição autocontida (md5 e ACL só com a foto da PRÉ); e a
  `db/test-em-transito-erro-terminal.sh` passou a usar o md5 da fixture viva como referência das restaurações.
- `hojeSP`/`addDias` foram para a plataforma (`@/lib/time/sp-day`): importá-los de `@/lib/dashboard/sp-date`
  nas telas de reposição era vazamento de fronteira (`fronteiras.gate`).

## ⚠️ Migration órfã que reverteria parte disto

A worktree `infallible-blackburn-5ce599` (branch `claude/oportunidade-antidup-disparado-simulado`, commit
local de 26/09, nunca enviada, sem PR) tem a `20260926115128_oportunidade_antidup_conta_disparado_simulado.sql`,
que recria `gerar_pedidos_oportunidade_ciclo` SEM pré-condição executável (só o md5 de 26/09 num
comentário), com o `DEFAULT CURRENT_DATE` e o corte `::timestamptz`. Aplicada DEPOIS desta, ela reverteria em
silêncio o dia de SP e o corte dessa função. Antes de aplicá-la: regenerar a partir do corpo vivo (o da
20261001023000) e pôr a PRÉ por md5. (Ela também é um conserto money-path pendente: o anti-compra-dupla da
oportunidade não vê `disparado_simulado`.)

## Fase financeira (a PR depois do gate)

São 45 sítios em 32 entradas da baseline, e todos saem dela nesta PR: 8 de gravidade alta, 32 baixa, 2 latentes e 3 falsos-positivos.

| Onde | O que era | Veredito |
|---|---|---|
| `EventosManager`, `EventosOnboarding`, `ConfigCashflowDialog` | o `inicio`/`data_prevista` do evento de caixa e o `data_ref` do saldo inicial eram **persistidos** com o dia UTC: lançados às 22h, nasciam amanhã | afetado-alto (4) |
| `omie-financeiro` | o saldo pedido ao Omie (`dataBR`, montado com `getDate()` no servidor) e o `saldo_data` gravado iam juntos para D+1 no sync noturno | afetado-alto (4) |
| `omie-financeiro` | as janelas de 6 e 3 meses (`setMonth` no servidor), o `dataFim`, o ano/mês do `calcular_dre_year` (na noite do último dia, o mês que nem começou saía zerado), o `_hojeBR` do debug | afetado-baixo (16) |
| `fin-cashflow-engine` | a semana corrente (do domingo às 21h em diante ela sumia do horizonte: a classe que a 20260927202603 consertou no SQL); as curvas de aging; o NCG; a janela de 12 meses das taxas; o corte do CMV TTM; os rótulos da projeção de 12 meses | afetado-baixo (11) |
| `fin-valor-cockpit` | a janela TTM (fim, início e prefetch) | afetado-baixo (3) |
| `fin-funding` | o `.gt(data_vencimento)` da lista antecipável: das 21h em diante, os títulos que vencem amanhã sumiam | afetado-baixo (1) |
| `CockpitDrillDown` | o corte de 60 dias do aging crítico | afetado-baixo (1) |
| `omie-financeiro` | `nowDre`, o default de ano/mês (o front sempre passa) | latente (2), vai junto |
| `omie-financeiro` | `formatOmieDate`, helper puro que ficou sem caller depois da troca | falso-positivo (3), removido |

**O invariante desta fase:** a qualquer hora do dia D de SP, o valor novo é o que o código velho já dava
durante o DIA (00:00–20:59 BRT) de D. A noite passa a se comportar como o dia, e nenhum comportamento é
novo; o que some é só a divergência noturna. Vale para todos os 45 sítios, porque todos são funções do DIA,
nenhum do instante.

**O helper:** `somarMeses` mora em `supabase/functions/_shared/meses-sp.ts`, que tem teste Deno. Ele fica
SEPARADO do `hoje-sp.ts` de propósito: mexer no `hoje-sp.ts` muda o fingerprint das 2 edges da #2705 e pediria
um redeploy sem mudança de comportamento. A semântica é a do `setUTCMonth` (31/08 − 6 meses = 03/03), igual à
do `setMonth` que ele substitui.

**Fica de fora, de propósito:**
- `fin-funding`, os `dias` até o vencimento (l. ~590), calculados como `round((vencimento 00:00Z − agora) / 1 dia)`.
  - O efeito: das 09:00 às 23:59 BRT o resultado é 1 dia a menos que os dias corridos (um título que vence em 5
    dias corridos sai com 4).
  - O que esses `dias` dirigem: o deságio, o IOF diário e o custo em R$ das fontes.
  - Por que não entra aqui: não é o fuso, é a RÉGUA. Trocar muda o custo da antecipação também de DIA.
  - 🧭 Decisão do founder: o prazo é em dias corridos do dia de SP até o vencimento?
- Os helpers espelhados VERBATIM entre front e edge (`funding-helpers`, os do fluxo de caixa) não têm sítio.

**Deploy:** não há migration. As 4 edges são deployadas pelo founder no chat do Lovable, e quem decide é
`pendencias:deploy`: `fin-cashflow-engine` v1.2, `fin-funding` v1.1, `fin-valor-cockpit` v1.6 e
`omie-financeiro` v1.2. O Publish também é do founder.

**Codex:** a cota segue esgotada até 03/10 19:11, então vale o Caminho B. O retroativo leva 3 perguntas:
1. o invariante "a noite vira o dia" vale nos 45 sítios?
2. há algum consumidor desses valores que dependia do D+1 noturno (algum cron noturno que gravava "amanhã" de
   propósito)?
3. o `dataFim` do Omie no dia de SP pode perder registro?

## Fase visitas: o DEFAULT de `route_visits.visit_date` junto com os leitores

**Por que agora.** A fase 2 (20260930230623) adiou este DEFAULT de propósito. Os leitores eram mistos: o
planner e os KPIs de 30 dias liam o hoje UTC, e o MTD e a positivação liam o de SP. Trocar só o DEFAULT
movia a divergência de lugar. Nesta fase vão o DEFAULT e os leitores TS juntos.

**O que a prod mostrou** (psql-ro, 01/10):
- `route_visits` e `visitas_agendadas` têm **0 linhas**: o domínio ainda não foi usado, e o conserto chega
  antes do primeiro dado.
- Os 3 check-ins do app (2 em `useRoutePlanner` e 1 em `useVisitasAgendadas`) OMITEM `visit_date`, então todo
  check-in usa o DEFAULT. Ele é exercido, não latente.
- O trigger `reconcile_visita_agendada` dá baixa na agendada mais antiga com `scheduled_date <= NEW.visit_date`.
  Com o dia UTC, o check-in das 22h dava baixa na visita agendada para AMANHÃ, que sumia da agenda antes de
  acontecer.
- `_carteira_positivacao_for_owner` e o edge `carteira-positivacao-snapshot` já liam o MÊS de SP: o check-in
  da noite do último dia do mês contava no mês seguinte.

| Onde | O que era | Veredito |
|---|---|---|
| `route_visits.visit_date` DEFAULT | o dia da sessão (UTC) em todo check-in | afetado: migration `20261001043717` |
| `lib/visitas/today.ts` `hojeISO` | o dia UTC para os 6 consumidores (a agenda, o `min` do agendamento, os follow-ups) | afetado-alto |
| `useRoutePlanner` (2) | `.eq('visit_date')` e `.eq('scheduled_date')` com o hoje UTC: das 21h em diante, o planner carregava amanhã | afetado-alto |
| `useCheckinQualitativo` | `data_avaliacao` persistida com o dia UTC | afetado-alto |
| `RotaPropostas`, `usePropostaPreview` | o dia de referência da proposta e da cesta de recompra mandadas por WhatsApp | afetado-alto |
| `useKpisVisita`, `useFollowupsVisita` | a borda de 30 dias em `visit_date` com o dia UTC; eram "UTC-consistentes" com o DEFAULT antigo e mudam com ele | afetado (junto do DEFAULT) |
| `visit-score-recalc-batch` | `cutoff.slice(0, 10)` contra `visit_date` | latente: só roda no cron das 04:00 BRT, quando o dia UTC é o de SP; dono: `[fase datas-omie-e-edges]` |
| `carteira-positivacao-snapshot`, `_carteira_positivacao_for_owner` | já leem o mês de SP | já-correto: ganham com o DEFAULT |

O sítio do `visit-score-recalc-batch` era o ISO guardado numa variável e fatiado depois. A 1ª versão do gate
não via essa forma, e o gate passou a ver (PR do gate).

**A trava** é `ACCESS EXCLUSIVE` já na entrada. Medido no PG17: o `ALTER COLUMN … SET DEFAULT` toma
AccessExclusiveLock. A fase 2 travou as tabelas dos DEFAULTs em `SHARE UPDATE EXCLUSIVE`, e o ALTER subiu o
lock no meio da transação (já aplicada, sem incidente; a lição está registrada na #2705 com a
`pedido_compra_sugerido`).

**A prova** é `db/test-hoje-sp-visitas.sh`, com 15 asserts:
- P01-P02: o DEFAULT e o corpo do trigger são os da prod (md5 `06eb0e83…`);
- K1-K2: a trava e o NÍVEL dela (nem a leitura passa);
- Z0;
- D01 a/b/c/d;
- E1-E3: ponta a ponta com o trigger. Só a agendada de D+1 fica pendente: o check-in das 22:30 BRT não dá
  baixa nela, e o da 00:30 de D+1 dá (é o controle positivo);
- G1-G3.

A prova fica fora do núcleo do CI e roda local: o `provas-sql` cancelou 16 de 25 runs a 20,2 min em 01/10, e o motivo está registrado em `db/nucleo-ci.txt`. O `--falsificar` teve 8 sabotagens, todas vermelhas no assert declarado, nos dois ambientes (`TZ=UTC` + `C`, e
sem TZ + `pt_BR.UTF-8`):
- o gêmeo da sessão;
- o fuso escrito errado (UTC);
- o relógio de parede;
- sem pin;
- sem trava;
- trava fraca;
- PRÉ removida;
- PÓS removida.

A migration desta fase é a **11ª a partir do `CORTE` do relógio-nu** (`20260927195430`) e detonou um teste do gate
no ensaio da PR já rebaseada (1 de 10.057). O `10 migrations não são o repo`, em
`scripts/relogio-nu-da-sessao-gate.test.ts`, montava a amostra com `velhas.slice(0, 10 - novas.length)`, e na 11ª o
fim fica **negativo**. O slice devolvia o repo quase inteiro, a amostra passava no piso e o veredito saía 0, não 2.
Consertei na própria PR: as do corte vão na frente, completadas com velhas e cortadas em 10, e a contagem passou a
ser afirmada. A falsificação teve controle 31/31; o piso 700→5 e a fórmula velha ficaram vermelhos só no alvo.
Lição: uma amostra de tamanho RELATIVO ao universo explode quando o universo cresce. Use `slice(0, n)` sobre a
união, nunca `n - parte.length`.

**Deploy:**
- **Migration:** FEITO (eu). `db:aplicar --ensaio` e depois o apply às **01:49 BRT de 01/10**: a tentativa
  #212 virou recibo (sha256 `f25a4b97…`). 2ª testemunha (psql-ro): o DEFAULT em SP, o trigger com o md5 de
  antes e o ledger `aplicada`.
- **Publish do front:** founder. Até o Publish, o planner velho lê o hoje UTC contra o `visit_date` novo, o
  que é só exibição noturna e com 0 linhas.
- **Edges:** nenhuma.

## Fases reposição e resto (só front)

São 14 sítios em 13 entradas, e a baseline cai de 98 para 85:

| Onde | O que era | Veredito |
|---|---|---|
| `TrocaParceiroDialog` (2), `useCadeiaLogistica` | o default de `dataTroca` e o `valido_ate` da etapa encerrada, **persistidos** com o dia UTC | afetado-alto |
| `useNegociacaoParalela` | o `data_geracao` explícito em UTC sobrescrevia o DEFAULT de SP da coluna (fase 2); o `valido_ate` era `setDate` local + ISO UTC | afetado-alto (2) |
| `DesovaMissaoDialog` | o `due_date` da tarefa de desova, persistido | afetado-alto |
| `useFarmerPerformance` | `period_start`/`period_end` gravados em `farmer_performance_scores` | afetado-alto (2) |
| `SkuDetailSheet` | os buckets do gráfico de 90 dias (à noite: sem o dia mais antigo, com um "amanhã" vazio) | afetado-baixo |
| `useBaixoGiro`, `useExcessoEstoque` | dias sem vender com +1 das 21h às 24h BRT | afetado-baixo (2) |
| `useSlaFornecedor`, `AdminReposicaoBaixoGiro`, `useExportNaoVinculados` | o nome do CSV baixado | afetado-baixo (3) |

No `useFarmerPerformance`, o `period_start` é o dia de SP do início da janela. O instante da janela (`startStr`)
segue o mesmo, então o rótulo e a consulta passam a falar do mesmo dia.

O gate ajusta 2 âncoras que dependiam de sítios que as fases consertam:
- o teste de "contagem" passa a ancorar num FALSO-POSITIVO estável (`route-schedule.ts`), e não no
  `useExportNaoVinculados`, que esta fase conserta;
- o piso de "detector cego" passa a ancorar no que NÃO se conserta (falsos-positivos, latentes sem dono e
  UTC-consistentes: 42 sítios): 100 → 35.

Mutcheck de novo: 18/18.

Depois desta fase, os afetados que sobram na baseline são só os `[fase datas-omie-e-edges]`: 16 edges e 54
sítios. Deploy desta fase: só o Publish (founder).

## Fase datas-omie-e-edges — as 5 de maior dano (as datas que vão ao Omie)

São 22 sítios em 18 entradas: os 21 `[fase datas-omie-e-edges]` das 5 edges e o `dataCiclo` padrão da
`disparar-pedidos-aprovados` (`latente`, sem dono; vai junto porque a edge já é redeployada). A baseline cai
de 85 para 67 entradas. Na fase sobram 29 entradas, 33 sítios e 11 edges, todos `afetado-baixo` (32) e 1
`latente`: nenhum `afetado-alto`.

| Edge | O que ia ao Omie | Conserto |
|---|---|---|
| `sync-reprocess` | a janela do `ListarPedidos` e o `dDataPosicao` do `ListarPosEstoque`, montados com `getDate()`: AMANHÃ nos crons das 21:15 e 23:15 (operational) e das 23:30 (strategic) | `janela-omie.ts` (`janelaPedidosOmie`, dentro do `try`: `windowDays` malformado vai ao log da run); a posição é `paraDataOmie(hojeSP())`, uma vez por run |
| `disparar-pedidos-aprovados` | o `dDtPrevisao` do `IncluirPedCompra` sem data do portal (hoje + lead time em dias úteis); o yymmdd do número do pedido; o `dataCiclo` padrão | `previsao.ts` (`somarDiasUteis`, `dataPrevisaoOmie`); o ramo do portal (entrega + 2 dias úteis) já era calendário puro e não muda |
| `omie-sync` | o `dDtVenc` das parcelas da OS: a criada às 21h+ vencia tudo um dia adiante (a à vista, amanhã) | `parcelas-os.ts` (`montarParcelasOS`); prazos e percentuais iguais |
| `omie-vendas-sync` | o `data_previsao` do `IncluirPedido` e do `AlterarPedidoVenda`, o `dDtPrevisao` do `IncluirOrdemProducao` e o `dDataPosicao` do `syncEstoque`. Sem `dInc`, o `data_previsao` vira o `order_date_kpi` (l.1371–1378): a venda das 21h+ caía no dia seguinte | `paraDataOmie(hojeSP())` |
| `omie-analytics-sync` | o `dDataPosicao` dos dois `ListarPosEstoque` (`toLocaleDateString` sem fuso) | `paraDataOmie(hojeSP())` |

### A medição antes de mudar (`sync-reprocess`, psql-ro, 2026-10-01)

O briefing pedia medir o que o Omie devolve para data futura antes de mexer. Sem credencial do Omie no Mac,
o experimento é o que a prod já roda: as rodadas noturnas mandam D+1 três vezes por noite. 30 dias de
`sync_reprocess_log` (`entity_type = 'inventory'`), por faixa de hora de SP:

| Rodada | Rodadas | Completas | Com divergência | Posições |
|---|---|---|---|---|
| operational, noite (manda D+1) | 38 | 38 | 0 | 760–779 |
| operational, madrugada (D) | 80 | 80 | 0 | 760–779 |
| operational, dia (D) | 118 | 118 | 22 (movimento real) | 756–779 |
| strategic, noite (D+1) | 19 | 19 | 19 (~682 cada) | 760–779 |

- O Omie ACEITA `dDataPosicao` futura: nenhuma das 57 rodadas noturnas deu `faultstring`.
- O saldo de D+1 é o de D: a rodada das 21:15 compara contra o que a das 19:15 gravou com D, e deu 0 em 38
  de 38.
- A data não é gravada: `inventory_position` leva saldo, CMC e o instante `synced_at`.
- Logo, no estoque o conserto é por CONSTRUÇÃO, não por número. Na janela de pedidos há efeito, embora
  pequeno: à noite ela deixa de consultar o dia futuro e volta a cobrir D−w. No strategic (que só roda às
  23:30), a janela era sempre `[D−29, D+1]` e passa a `[D−30, D]`.
- **Anotado, fora da classe:** as ~682 divergências do strategic não são da data. A `operational` das 23:15
  manda o mesmo D+1 e dá 0. Quem as produz é o passo de produtos, que roda antes do estoque no strategic e
  grava `estoque: prod.quantidade_estoque || 0` (`sync-reprocess/products-lote.ts:190`); o passo de estoque
  desfaz em seguida, a cada noite. A janela errada dura o passo de produtos (63–116 s em 28–30/09), e se o
  estoque falhar ela vai até a operational das 01:15. A linha de cima tem a mesma forma, sem passo que a
  desfaça: `valor_unitario: prod.valor_unitario || 0` (ausente ≠ zero).

### A prova

- **Relógio injetado** nos 3 módulos puros. As bordas vêm em pares de 1 s (20:59:59 → 21:00:00 e
  23:59:59 → 00:00:00 BRT), com controle POSITIVO na meia-noite de SP; mais o réveillon, o domingo à noite
  dos dias úteis e o ramo do portal sem relógio.
- **O INVARIANTE como teste**, nos 3 módulos: hora a hora de 2026 a 2027 (17.520 horas), novo(t) = o código
  velho como rodava no servidor (`getUTC*`) às t−3h. O oráculo não usa nada de `hoje-sp.ts`, e UTC−3 fixo
  vale porque SP não tem horário de verão desde 2019. O denominador é conferido (a varredura não encolhe), e
  o controle exige que só a noite mude, e que mude: exatamente 730 × 3 vezes onde o valor é "hoje".
- **O RED, medido nos dois fusos**, com a lógica velha extraída verbatim para os módulos:
  - em `TZ=UTC` (o servidor): vermelho só nos casos de noite e na varredura, com o valor D+1 na mensagem
    (`veio 24/09/2026 → 01/10/2026`; `veio "06/10/2026"`); os casos de dia, o controle e o portal ficaram
    verdes na MESMA execução;
  - em `TZ=America/Sao_Paulo` (o Mac): a lógica velha PASSA todos os asserts de hora, porque lá `getDate()` já
    é SP. Só o CI (UTC) veria a regressão; quem pega a FORMA em qualquer fuso é o gate `hoje-utc` (AST).
- O RED dos sítios triviais (`paraDataOmie(hojeSP())`) veio do gate: as 18 entradas saíram da baseline
  ANTES do código, e o `hoje-utc-gate` nomeou exatamente os 22 sítios como novos.
- `test:edges` 1279/1279 em `TZ=UTC` e no fuso do Mac. No `edges:typecheck`, o `deno check` das 5 edges no
  HEAD e na base dá o mesmo conjunto de erros, mensagem a mensagem (as 7 conhecidas da
  `omie-analytics-sync`; as outras 4 com 0).

### Armadilha de passagem: o `versao.ts` no piso de prosa

O sentinela `limpeza-fonte.test.ts` reprova arquivo com ≥60 linhas não vazias que preserva menos de 10% depois
de tirar os comentários. Ele existe para pegar stripper que engole código. O `sync-reprocess/versao.ts` já
estava EXATAMENTE no piso (9 de 90), e as 5 linhas de histórico da v1.13 o derrubaram (9/95): o vitest
inteiro ficou vermelho só por isso. O histórico da v1.13 mora aqui, e o arquivo leva só um ponteiro na
própria linha do `VERSAO`, que não muda a fração. O próximo bump ali tem o mesmo limite: linha nova de
comentário é vermelho.

### Deploy

São 5 edges, sem pré-condição de banco e sem ordem entre elas. `hoje-sp.ts` ficou intocado, então as 6 edges
já deployadas não mudam de fingerprint (o `sonda:fingerprint` acusou só as 5). Não há front, logo não há
Publish desta fase.

### Codex

Cota esgotada até 03/10 19:11, então **REVISÃO INDEPENDENTE PENDENTE** (Caminho B). Perguntas para o
retroativo (`scripts/codex-async.sh -r max`):

1. `sync-reprocess`: algum consumidor contava com a janela de pedidos incluindo "amanhã", ou com o
   strategic NÃO cobrindo D−30?
2. `dDataPosicao` uma vez por run (antes, por página): algum caminho em que a run cruza a meia-noite de SP e
   a data por página importava?
3. `disparar-pedidos-aprovados`: o modo lote (sem `pedido_id`) roda em algum caminho das 21:00 às 23:59 BRT
   que dependia do dia UTC no `.eq`/`.lt`/`.lte` de `data_ciclo`?
4. `omie-vendas-sync`: algum leitor compara o `data_previsao` do Omie com um dia UTC (reconciliação,
   `created_at`)?
5. `somarDiasUteis`: a paridade com o laço velho para `n ≤ 0`, `NaN` e não inteiro, e o ramo do portal byte
   a byte.

## Fora, com dono

- **O gate de TS** — FEITO no PR seguinte: `src/__tests__/hoje-utc-gate.test.ts` + `src/lib/gates/hoje-utc.ts`
  (AST, com 3 formas: o ISO fatiado no front e nas edges, também quando guardado numa variável e fatiado
  depois; o calendário local e o locale sem fuso, só nas edges).
  - Baseline `src/lib/gates/hoje-utc-baseline.ts`, com veredito e DONO por sítio: 137 entradas, 163 sítios.
  - `scripts/mutcheck.d/hoje-utc.mut`: 18/18 pegas.
  - É ele que dirige as fases seguintes: `[fase …]` no motivo.
  - A forma "ISO numa variável" entrou depois de a fase visitas achar um leitor de `visit_date` que a 1ª
    versão não via: `const cutoff = ….toISOString()` e depois `cutoff.slice(0, 10)`, no
    `visit-score-recalc-batch`. É latente: só roda no cron das 04:00 BRT, quando o dia UTC é o de SP.
  - Varredura dessa forma: 1 caso no repo inteiro.
- **As fases de TS por domínio**: financeiro, visitas, reposição e resto — FEITAS (as seções acima). Da
  `[fase datas-omie-e-edges]`, as 5 de maior dano também (seção acima). Sobram 11 edges e 33 sítios, todos
  `afetado-baixo` (rótulos, botões noturnos, relatórios) e 1 `latente`: `ai-ops-agent`, `algorithm-a-audit`,
  `monthly-report`, `omie-desconto-backfill`, `omie-nfe-recebimento-sync`, `omie-sync-ctes-recebidos`,
  `omie-sync-nfes-recebidas`, `omie-sync-pedidos-compra`, `omie-sync-vendas-items`,
  `promocao-extrair-via-vision` e `visit-score-recalc-batch`. Cada uma pede um deploy, então vão em fatias.
- **Anotado, fora da classe:** `_data_health_compute` converte `saldo_data` (date) em instante no fuso da
  sessão (a idade do saldo sai 3h maior; limiar de 36h); as 4 RPCs de ciclo têm EXECUTE para PUBLIC/anon
  (SECURITY INVOKER: a RLS das tabelas é quem barra).
