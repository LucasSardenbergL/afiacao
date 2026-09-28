# O relógio da sessão truncado ao calendário: 2 RPCs e 2 views DES

**2026-09-27.** Migration `20260927202603_fuso_sp_relogio_da_sessao_rpcs_views_des.sql`, prova
`db/test-fuso-sp-relogio-sessao.sh` (núcleo de CI, Eixo 7) e a fixture
`db/fixtures/des-views-predecessoras-prod-20260927.sql`. Segue a classe de
[positivacao-mes-sp-sob-sessao-utc.md](positivacao-mes-sp-sob-sessao-utc.md) e
[provas-janela-de-relogio-fora-do-nucleo.md](provas-janela-de-relogio-fora-do-nucleo.md), agora
fora das provas e fora dos corpos que mencionam São Paulo.

## Passo 0 — instância única ou classe?

Classe. A assinatura — `date_trunc` de unidade de calendário cujo 2º argumento parte do relógio da
SESSÃO sem fuso escrito (`CURRENT_DATE`, `localtimestamp`, `now()::date` com ou sem fuso depois;
`now()`/`current_timestamp`/`clock_timestamp()` sem `AT TIME ZONE` nem 3º argumento) — já tinha
gate nas provas de `db/` (`scripts/fuso-da-sessao-em-provas-gate.ts`) e nos corpos que mencionam
`America/Sao_Paulo` (`scripts/fuso-da-sessao-gate.ts`). Os sítios desta entrega estavam nos
universos que nenhum dos dois lê.

## A varredura — todos os universos, inclusive os limpos

A prod roda sessões em `TimeZone=UTC` (arquivo de configuração; 0 linhas de `TimeZone` em
`pg_db_role_setting`; PostgREST herda) — remedido via psql-ro nesta sessão. A assinatura foi lida
como o Postgres a lê (o parser do gate de provas: argumentos com parênteses balanceados), e a
varredura da PROD foi por regex sobre `prosrc`/`pg_get_viewdef` com o trecho de cada casamento
julgado à mão.

| Universo | Casamentos | Veredito |
|---|---|---|
| Prod: funções (`pg_proc`) | 5 | 2 **afetados** (`radar_kpis`, `fin_projecao_13_semanas`); 3 já em SP (`_carteira_positivacao_for_owner` ×2, `prime_uso_vigencia`) |
| Prod: views e matviews | 6 | 5 **afetados** em 2 views (`v_des_pedidos_em_transito` ×2, `v_des_posicao_trimestre_ao_vivo` ×3); 1 já em SP (`v_prime_extrato_mensal`) |
| Prod: defaults, constraints, policies | 0 | — |
| Prod: 99 crons (`cron.job.command`) | 1 | falso-positivo: o 148 `cmc-snapshot-backfill-mensal` dispara `0 4 2 * *` (01:00 BRT do dia 2) — mesmo mês nos 2 fusos. Correto por coincidência de AGENDAMENTO: mudar o horário para perto da virada o reabre |
| Repo: 739 migrations, texto inteiro | 4 | as 3 definições históricas da projeção e a do radar — todas superadas por 20260927202603 |
| Repo: 312 corpos vivos (295 sem SP) | 2 | os 2 afetados acima |
| Repo: 46 arquivos de skill | 10 | 2 skills (`bi-colacor` ×4, `cfo-colacor` ×6) — PR seguinte |
| Repo: 2.605 arquivos de `scripts/`, `supabase/functions/`, `src/` | 2 | o comentário que documenta o cron 148 |

As 2 views DES **não tinham CREATE no repo** (estão entre as views criadas direto na prod): nenhum
gate que lê migrations as enxergaria, e o briefing original, que partiu do `git grep`, também não as
listava. Foi a varredura da PROD que as achou.

## O defeito, objeto a objeto

Das 21:00 às 23:59 BRT o relógio da sessão já está no dia seguinte:

- **`radar_kpis()`** — `virou_cliente_mes` zerava 3 h antes da virada do mês em SP e, o mês inteiro,
  contava as conversões das 21:00–23:59 BRT do último dia do mês anterior.
- **`fin_projecao_13_semanas()`** (money-path) — domingo, na janela, a semana 0 era a SEGUINTE: a
  semana corrente, com os títulos em aberto dela (o ATRASADO de quarta, o VENCE HOJE de domingo),
  sumia da projeção de caixa.
- **`v_des_pedidos_em_transito` / `v_des_posicao_trimestre_ao_vivo`** (money-path: faixa de desconto
  Sayerlack) — no último dia do trimestre, o trimestre "atual" já era o seguinte: o pedido em trânsito
  migrava para o trimestre novo, a linha do trimestre corrente ficava só com o faturado do snapshot, e
  a faixa conservadora — e o desconto projetado do check-in em `v_des_desconto_por_checkin` — caía. E
  todo dia, na janela, `dias_restantes` saía 1 a menos e `calculado_em` era amanhã.

**Flagrado ao vivo na prod** em 2026-09-28 00:23Z (domingo 21:23 BRT), antes do apply:
`current_date` = 2026-09-28, `(now() AT TIME ZONE 'America/Sao_Paulo')::date` = 2026-09-27, e a view
de posição DES com `calculado_em = 2026-09-28` e `dias_restantes = 2` — faltavam 3.

## O conserto

Partir de `now()` com o fuso ESCRITO. `CURRENT_DATE AT TIME ZONE …` não conserta (é a data da
sessão convertida), nem o 3º argumento aplicado a ela. O radar compara `timestamptz` com
`timestamptz` e usa `date_trunc('month', now(), 'America/Sao_Paulo')` (o início do mês de SP como
instante); a projeção e as views truncam o relógio de parede de SP (`now() AT TIME ZONE …`, um
`timestamp`). Única mudança em cada objeto: o relógio — o resto é o texto vivo da prod, gerado por
troca exata com contagem conferida (diff prod × novo só nas linhas do relógio).

A migration traz: **trava** (um `ALTER` sem efeito prende a linha do catálogo de cada função e cada
view até o fim da transação), **pré-condição** (md5 EXATO do predecessor medido na prod, ou deste
texto — re-aplicar é seguro) e **pós-condição** (md5 deste texto, volatilidade, `SECURITY DEFINER`,
`search_path`, dono, ACL fechada para PUBLIC/anon e aberta para `authenticated`, `security_invoker`).

## A prova — 53 asserts, 16 sabotagens

- O relógio é o controlado (`test.agora`, tripwire Z9T01). **`CURRENT_DATE` não é função**: nenhum
  sombreamento de `now()` o alcança. O corpo antigo da projeção e das views, portanto, não entra na
  falsificação como tal — entra o GÊMEO controlável (`now()` truncado na sessão). O do radar entra
  como é (`corpo_pre_fix`).
- Cada bloco cruza a borda em pares de 1 s (20:59:59 · 21:00:00 · 23:59:59 BRT · 00:00:00 do dia
  seguinte) sob `TimeZone=UTC` E `America/Sao_Paulo`; sob SP o defeito não aparece.
- P1–P5: o predecessor de cada objeto (as RPCs extraídas das migrations do repo; as views da
  fixture) bate o md5 EXATO da prod sob o `search_path` do executor — o ensaio do predicado da PRÉ.
- K1/K2: a sessão A roda a migration até o fim da pré-condição e PARA com a transação aberta; B,
  com `lock_timeout`, é barrada (55P03) na função e na view. Sem a trava, B passa.
- V1/D10: o desconto projetado do check-in pela view dependente REAL (fixture da prod).
- As views sabotam UMA camada por vez: a que agrupa o pedido no trimestre (`transito_na_sessao`) e a
  que o exibe (`posicao_na_sessao`) derrubam asserts diferentes.
- Matriz: servidor SP/UTC × `lc_messages` C/pt_BR — 53/53 nas 4.

## Codex

Rodada única de desenho (seção `RÉGUA:`) + adversarial no diff — rollout `01a0e54c`, reasoning max,
3 pp. **APROVADO COM RESSALVAS**, sem P0/P1, com concessão explícita às 4 trocas, à decisão de manter
`horario_disparo_real::date` e ao REVOKE/GRANT sem efeito na prod. As 3 ressalvas entraram:
md5 normalizado igualava literais com espaço duplo (P2) → md5 exato; corrida entre a PRÉ e o
`CREATE OR REPLACE` (P2) → trava + K1/K2; a exceção `ID!MARCA` do laço liberava erro em qualquer
assert (P3) → vale só no assert declarado. A observação sobre o V1 raso virou a dependente real.

## Fora, com dono

- **`horario_disparo_real::date`** em `v_des_pedidos_em_transito` (instante → data no fuso da
  sessão): 38 dos 152 disparos Sayerlack caíram das 21:00 às 23:59 BRT. A data certa depende do
  corte do snapshot GoodData (o pedido das 22h do dia D entra no snapshot de D?) — pergunta ao
  founder, não palpite.
- **Classe irmã (ii)** — `current_date`/`now()::date` nus em funções que não mencionam SP. Medido
  (varredura read-only de 16 funções, 34 sítios): 15 UTC-consistentes (falso-positivo de um gate
  amplo, 44%), 13 SP-semânticos (6 só borda de janela de N dias), 6 indeterminados. Os materiais:
  `converter_sugestao_em_campanha_flat`, `radar_atribuir_tarefa`, `vendas_sync_semear_janela` e a
  trava contábil `fin_period_lock_trigger` (falha aberta na última hora de um mês fechado) — chip.
- **Skills e gate** — os 10 sítios das skills `bi-colacor`/`cfo-colacor` e o gate que torna a
  reintrodução vermelha em migration e skill: PR seguinte.
