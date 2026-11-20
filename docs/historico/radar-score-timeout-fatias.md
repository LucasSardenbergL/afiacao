# Score do Radar parado por timeout (17–19/11/2026) → recálculo em fatias

**Migrations:** `supabase/migrations/20261120140000_radar_score_em_fatias.sql` e
`20261120150000_radar_score_janela_madrugada.sql` · **Prova:** `db/test-radar-score-fatias.sh`
· **Fixture:** `db/fixtures/radar-score-predecessora-prod-20261119.sql` (corpo vivo, md5 `49c21fef…`).

## O incidente

O cron `radar-score-recalcular-diario` (06:30 UTC) falhou em 17, 18 e 19/11, sempre aos 120 s, com
`57014 canceling statement due to statement timeout`. Até 16/11 ele saía em 0–9 s. O score parou no lote
2026-10 (`radar_score_estado.calculado_em = 2026-11-16 06:30`). Esse foi o único job com falha em 7 dias,
de 123 mil execuções.

**De onde vêm os 120 s:** é o default do servidor. `pg_settings.reset_val = 120000` para `statement_timeout`.
Nenhum papel sobrescreve: `postgres` não tem `statement_timeout` em `pg_db_role_setting`, e o banco também não.
O job roda sem `SET` próprio. Os outros jobs pesados do Radar já levavam `SET statement_timeout` no comando
(agregado 15 min, aplicar-situação 30 min). Medido: o pg_cron de prod honra esse `SET` (o agregado levou 2m50s
em 18/11 e saiu `succeeded`).

## As 3 perguntas

### 1. Quem reescreveu as 573 mil linhas em 17/11 06:05?

Foi o `radar-aplicar-situacao-diario` (`radar_aplicar_situacao_pendente` → `radar_aplicar_situacao('2026-11')`).
Ele rodou de 06:05:00 a 06:32:43 (27m43s, dentro dos seus 30 min) e gravou `fotos_atualizadas: 573026`.
Todas as linhas ficaram com o mesmo `updated_at = 06:05:00.498`. O lote 2026-11 tinha terminado em 16/11 21:30.
O UPDATE troca `rfb_situacao_lote` de 2026-10 para 2026-11 em toda linha presente no dump.

**A escrita foi legítima.** O rótulo da foto mudou de verdade, e isso se repete a cada lote mensal. Mas ela não
é o que obriga o score a recalcular tudo. O score não lê `rfb_situacao*`, e o que o obriga é o **lote vigente
novo**: o motivo de idade cita `"(ref. 2026-11)"`, e o bônus de "inédito no lote" muda de dono. Medido em prod,
só com leitura (o cálculo da função com o lote 2026-11 e sem o UPDATE): **514.024 das 584.587 linhas precisam
ser regravadas, e só 53.598 mudam de NOTA.** O resto muda só o texto do motivo.

### 2. Quanto custa o cálculo completo?

- **Cálculo, só leitura** (EXPLAIN ANALYZE em prod): **5,3 s**, 86.737 páginas lidas fora do `shared_buffers` e
  quase todas servidas pelo cache do SO, **sem temp**. Faixa de 1.000 páginas lida a frio: 0,8 s.
- **Escrita:** é ela que domina. O score é coluna indexada (`idx_radar_lista_score`) e o fillfactor é 100, então
  quase todo UPDATE é não-HOT e mexe nos **26 índices** (1,48 GB com o heap de 731 MB). A tabela tem
  `n_tup_hot_upd` de 3,5%.
- Histórico do ledger (`acoes_execucoes`, `radar.score_recalcular`):

| Dia | Porte | Linhas gravadas | Duração |
|---|---|---:|---:|
| 28/10 (lote 2026-10) | Small | 509.644 | 101 s |
| 30/10 (fórmula v3) | Small | 501.243 | 115 s |
| 01/11 | Mini | 38.023 | 67 s |
| 08/11 | Mini | 35.733 | 59 s |
| 09–16/11, sem escrita | Mini | 0 | 9 s |

Por linha regravada: **~0,16 ms no Small** e **~1,2–1,4 ms no Mini** (a escrita espalhada pesa mais que a
sequencial, então a comparação é aproximada). O `aplicar_situacao` de 17/11 dá a ordem de grandeza no Mini:
**573 mil linhas em 27m43s (~2,9 ms/linha)**. Regravar as 514 mil linhas do score num comando só levaria
**12–25 min no Mini**. Não há `statement_timeout` razoável que resolva isso, e um UPDATE desse tamanho seguraria
trava de linha em meio milhão de linhas durante esse tempo todo.

### 3. A culpa é do Mini?

**O Mini disparou a falha, mas não é a causa.** No Small, a mesma regravação mensal levou 101 s e 115 s em
outubro, a 4–16% do teto de 120 s. Com 514 mil linhas a regravar e a tabela 2% maior, o Small ficaria em
~100–120 s: passaria ou não por sorte, e falharia com o crescimento da tabela. O desenho de **um comando só**
já estava no limite antes do Mini. O Mini deixa a escrita em massa ~9× mais lenta por linha, e isso transformou
"no limite" em "impossível".

**Com a correção, o score não depende mais do porte.** Cada chamada fica abaixo de ~45 s com margem, em qualquer
um dos dois. **Este timeout, sozinho, não é motivo para voltar ao Small.**

**Mas o Mini deixa um sinal para a decisão do founder:** o `radar-aplicar-situacao-diario` usou **27m43s dos
seus 30 min** em 17/11 (92%). É o próximo job a estourar por timeout no Mini, mensalmente, no dia seguinte a
cada lote. Ele é um UPDATE de uma transação só sobre as mesmas ~573 mil linhas. Se o founder ficar no Mini, ele
precisa da mesma cirurgia (follow-up, fora desta entrega). Observação lateral: os ticks do `radar-publicar-lote`
de 16/11 duraram exatamente 2:00, porque o `CALL` também é cortado em 120 s mesmo com COMMIT no meio. O passo
trata o `query_canceled`, o tick sai `succeeded` e a publicação terminou, mas o orçamento de 8 min da procedure
é, na prática, de 120 s.

## A correção (20261120140000)

A fórmula, os pesos e a versão `v3` são idênticos. A prova de equivalência (A1/A2) dá a mesma foto
`(score, motivos, versão)` da predecessora, numa chamada só e em fatias. O que muda é como a passada percorre a
tabela:

1. **Passada em faixas físicas de páginas** (TID Range Scan, leitura sequencial). A faixa é adaptativa: começa em
   250 páginas e mira 1–4 s por faixa. O orçamento é de ~45 s por chamada, com margem (não abre faixa nova se o
   tempo gasto mais 2× a última faixa passar dele). O cursor fica em `radar_score_passada` (tabela nova, RLS,
   fechada), e a chamada seguinte continua dali. Lote, fórmula ou filenode diferente faz a passada recomeçar.
2. **A marca só é gravada no fim da passada**, com 0 pulados, e com a impressão digital do **início**. O que muda
   durante a passada deixa `max(updated_at)` acima da marca, e a rodada seguinte recalcula.
3. **Passada ativa dispensa o gate** (Codex ALTO 2). Sem isso, uma impressão que volta a coincidir com a marca
   antiga (já-cliente promovido e depois expurgado, sem bump) descartaria uma passada com notas gravadas pela
   metade.
4. **Leitores só veem conclusões.** A rodada parcial registra em `radar.score_recalcular_parcial`, e o ledger
   `radar.score_recalcular` (lido por `radar_avisar_lote`, `useRadarSugeridos` e `useRadarLista`) só recebe
   conclusões. **Conclusão com pulados não carimba `lote_vigente`** (Codex ALTO 1). A predecessora carimbava, e o
   card mostrava "score calculado" sobre cobertura parcial.
5. **Linha já pontuada nesta passada** (`score_em >= início`) é pulada. A versão nova de um UPDATE não-HOT cai
   numa página adiante e seria contada duas vezes.
6. **Travas:** `lock_timeout 5s` com subtransação por faixa. A faixa que não pega trava encerra a chamada com o
   que já foi feito, em vez de esperar até o 57014. No máximo 60 faixas com escrita por chamada, porque mais de 64
   subtransações com XID transbordam o PGPROC. A trava da rodada virou `pg_try_advisory_xact_lock`.
7. **Ledger diário:** a rodada "nada mudou" registra só se o último registro das últimas 20 h não anunciar este
   lote. Continua 1 registro por dia, a fila da tela não reinicia a cada 5 min, e uma conclusão cujo INSERT falhou
   no fail-open é reparada.
8. **Cron:** o `radar-score-recalcular-diario` roda de 5 em 5 min das 06:30 às 06:55, e o novo
   `radar-score-recalcular-continua` de 5 em 5 min das 07:00 às 08:55, ambos com `SET statement_timeout = '3min'`.
   Sem passada pendente, cada tick é só o gate (~0,5 s, pelos índices). O **`radar-avisar-lote-diario` passa de
   06:45 para 09:05**: o aviso é único por lote, e às 06:45 ainda sairia com "Score: pendente" no dia do lote.
   **A 20261120150000 alarga a janela** (o próximo item explica o porquê): o `continua` passa a rodar de
   01:00 a 05:55 e de 07:00 a 10:55 UTC (22:00–02:55 e 04:00–07:55 BRT, ~114 chamadas por dia), e o aviso vai
   para **11:05 UTC** (08:05 BRT).

### A 1ª chamada real mudou a janela

Logo depois do apply, uma chamada manual (`db/2026-11-20-radar-score-tick-manual.sql`, recibo #1207) mediu o
Mini de verdade: **40,9 s**, 8.630 das 93.511 páginas, **6.287 linhas regravadas, 0 pulados**. As primeiras
páginas estão esparsas, com 6.576 linhas vivas, porque a reescrita de 17/11 deixou o começo do heap quase vazio.
**Ritmo real: ~5–6 ms por linha regravada**, o dobro dos 2,9 ms estimados a partir do `aplicar_situacao`.
Faltavam ~508 mil linhas, ou ~45–50 min de escrita, ~75 chamadas. Com a janela 06:30–08:55 (30 chamadas por
dia), o lote novo levaria ~3 dias "pendente" na tela. A janela da madrugada fecha um lote numa noite.

**Limites conhecidos (aceitos):** as contagens do resumo são somadas por faixa. Com escritor concorrente movendo
linhas entre faixas, podem sair aproximadas (o resumo é observabilidade, e nenhum leitor decide por elas). Linha
alterada por outro escritor depois de a faixa dela passar só é corrigida na passada seguinte, como no desenho
anterior entre um dia e outro. O gate segue heurístico (troca de já-cliente aos pares, sem bump), com a rede de
7 dias.

**Contestação do Codex** (gpt-6.2-astra · high · 129 s · 70.111 tokens), sobre a 1ª versão. Adotado: ALTO 1
(sem carimbo com pulados), ALTO 2 (passada antes do gate), ALTO 3 (faixa adaptativa e margem no lugar de 1.000
páginas fixas), MÉDIO de leitores (parcial em outra `acao`, throttle pelo lote do último registro e aviso depois
da janela) e BAIXO (`passada.duracao_ms`). MÉDIO do cron: medido, o `SET` vale no pg_cron de prod (libpq).
Não adotado: o resumo final num snapshot único, porque relê a tabela inteira (até ~75 s a frio) só para
observabilidade.

## Validação

- Prova PG17 `db/test-radar-score-fatias.sh`: 45 PASS no controle; `--falsificar` com **16/16 sabotagens vermelhas** no assert declarado e controle verde na MESMA invocação, nos locales `C` e `pt_BR.UTF-8` (~10 min cada, em paralelo). No CI entra com `falsificar=16 faixas=3` (`db/nucleo-ci.d/test-radar-score-fatias.txt`). Uma sabotagem nasceu verde (`passada_nao_reinicia` desligava só o lote, e o `lote_iniciado_em` ainda pegava a troca: camada redundante) e passou a desligar o reinício inteiro..
- Aplicação (`bun run db:aplicar`, ensaio 🟢 antes de cada uma): 20261120140000 → recibo **#1206**
  (sha256 `f646f8a4…`), e a 20261120150000 → recibo **#1209** (sha256 `d1af0207…`). 2ª testemunha via psql-ro:
  md5 do corpo `8a0f2beb…`, `lock_timeout=5s`, `radar_score_passada` com RLS e fechada para authenticated, ACL
  preservado (service_role sim, authenticated não), 3 jobs ativos como `postgres` nos horários novos.
- 1ª chamada manual (recibo #1207): parcial por orçamento em 40,9 s, como medido acima.
- Prova em prod: em observação desde 20/11 00:20 UTC — os ticks do cron (01:00–05:55 e 06:30–10:55 UTC) fecham a passada do lote 2026-11; o recibo (marca `radar_score_estado.lote = 2026-11`, ledger e zero `failed`) entra aqui num complemento.
