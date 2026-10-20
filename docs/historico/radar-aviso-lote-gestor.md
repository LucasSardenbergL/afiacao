# Radar — aviso ao gestor por lote mensal fechado (bloco 4): um e-mail com denominador, nunca repetido

> 2026-10-20. Bloco 4 do Radar, depois de #3169 (carga mensal), #3212 (situação cadastral RFB), #3214 (score) e #3216 (inéditos na fila). Migration `20261020143000_radar_avisar_lote.sql` **JÁ aplicada** em prod pelo canal postgres/MCP; prova PG17 `db/test-radar-avisar-lote.sh` (23 asserts, 18 sabotagens).

## O problema

A carga mensal fecha o lote (`radar_ingest_state.status='complete'`) em silêncio. O gestor só descobre que entraram **27.466 inéditos** no lote 2026-08 abrindo a tela — e, com tarefas/WhatsApp congelados até 2027-01-10, o único canal é e-mail (`fornecedor_alerta` → `dispatch-notifications`, o mesmo do #3212). Regra da casa ([fase-sem-sinal.md](fase-sem-sinal.md)): aviso **sempre com denominador**, "quando medir" é query, e o mesmo lote nunca avisa duas vezes.

## O que entrou

1. **`radar_ingest_state.avisado_em timestamptz`** — dedupe em coluna dedicada, 1 escritor (`radar_avisar_lote`). **Bootstrap único** amarrado à criação da coluna (`DO $boot$`): lotes já fechados antes do aviso existir recebem `avisado_em = finalizado_em`, exceto o mais recente — 2026-05 não ganha e-mail retroativo; 2026-08 ganha o 1º real. Re-colar a migration **não** entra no bootstrap (pendência legítima preservada — Codex P1 #1).
2. **`radar_avisar_lote(p_agora timestamptz DEFAULT now()) → jsonb`** — SECURITY DEFINER, REVOKE PUBLIC/anon/authenticated, GRANT service_role. Para cada lote `complete` com `avisado_em IS NULL` e `finalizado_em` há ≥ 15 min (`FOR UPDATE SKIP LOCKED`), monta o corpo em texto simples e insere **1** `fornecedor_alerta` (`oben`/`outro`/`info`, status `pendente_notificacao`, `metadata` com todos os números), grava `avisado_em = p_agora` (guarda: tem de marcar exatamente 1 linha) e, ao fim, 1 linha em `acoes_execucoes` (`radar.avisar_lote`, `automatica`) **só quando avisou ≥ 1 lote** — dia sem lote novo não suja o ledger; `job_run_details` é a fonte do "rodou". Erro propaga; tudo numa transação (alerta + marca + ledger, ou nada).
3. **Cron `radar-avisar-lote-diario`** (jobid **228**), `45 6 * * *` = 03:45 BRT, **job próprio** — mesmo molde dos vizinhos (213 recruzar 06:15 · 225 score 06:30 · este 06:45): 1 job = 1 função = 1 linha em `job_run_details`. Encadear no comando do 213 amarraria o aviso ao sucesso do recruzamento e misturaria os registros. Custo: lote fechado segunda ~09:00 UTC é avisado terça 06:45 (depois do score das 06:30 — por isso a ordem 06:30 → 06:45 importa).

### Cada número do e-mail e seu denominador

| Linha | Numerador | Denominador | Quando o dado não existe |
| --- | --- | --- | --- |
| Inéditos N de T | `novos` **persistido no finalize** (mesma definição da edge: `primeira_vista_em ≥ iniciado_em ∧ ultimo_lote = lote`); sem ele, contagem pela **janela** do lote `[iniciado_em, iniciado_em do lote seguinte)` — não depende de `ultimo_lote`, que a carga seguinte sobrescreve | `total_recebido` | — (N sempre existe num lote complete) |
| … (F na fila hoje) | inéditos da janela com `ja_cliente=false` e status ∉ descartado/virou_cliente | — | — |
| Saíram S de T_ant | `ultimo_lote = lote_anterior` **exato** (não `< lote`, que acumula meses) ∧ não descartado/virou_cliente | `total_recebido` do lote complete anterior | "sem lote anterior para comparar" (S nem é calculado) |
| Baixas K de M | `radar_situacao_cadastral` do lote × clientes (`ja_cliente` ∪ `radar_docs_clientes()`, CTE `MATERIALIZED`) com situação 03/04/08 | clientes verificados no lote | "nenhum cliente com situação cadastral verificada neste lote" — nunca "0 de 0" |
| Score P de N (+ top 10) | inéditos da janela com `score ≥ 70`; top 10 leads por score com razão social, município/UF, score e 2 motivos | inéditos na foto (+ "Q sem score" quando Q > 0) | só quando a **última rodada automática** do score (`acoes_execucoes` `radar.score_recalcular` sucesso) registrou `detalhes.lote_vigente` = este lote. Rodada anterior/ausente → "**score pendente**"; rodada já de lote posterior → "indisponível — o score já reflete o lote X". Nunca "0 de N" fabricado |

## Codex (2ª opinião, gpt-6-astra · max · 668 s · 168.688 tokens) — veredito **reprovar** na v1, tudo incorporado

RÉGUA da v1: R1 dedupe/concorrência **OK** · R2 backfill **ERRO** · R3 score **ERRO** · R4 saíram **ERRO** · R5 custo do `EXISTS` correlacionado **RISCO** · R6 job próprio **RISCO** (cadência) · R7 ledger **OK** · R8 ACL **OK**. Achados e o que mudou:

| # | Achado | Reprodução | Mudança |
| --- | --- | --- | --- |
| P1 | Backfill repetível apaga pendência | re-colar após setembro fechar marcava agosto como avisado **sem alerta** (A5 passava justamente por isso) | bootstrap dentro de `DO $boot$`, só quando a coluna não existe; A5 virou assert do bootstrap. Sabotagem `reapply_apaga_pendencia` → A14c |
| P1 | Inéditos/ranking somem quando outro lote entra | setembro sobrescreve `ultimo_lote` dos inéditos de agosto antes do aviso → "0 inéditos de 501.380" | N = `novos` persistido; universo = janela por `primeira_vista_em`; ranking só com `lote_vigente` do score = este lote |
| P1 | "Saíram" mistura universos | `ultimo_lote < lote` somava quem saiu em maio ao aviso de setembro (a prova A9 cristalizava 13 em vez de 10) | `ultimo_lote = lote_anterior`. Sabotagem `sairam_acumula` → A9 |
| P1 | Confirmação do score aceita rodada errada | rodada que **atravessa** o fechamento (começa com maio vigente, termina depois) passava em `finalizado_em ≥`; dois lotes pendentes; ledger `manual` inserível por staff | `lote_vigente` da última rodada `origem='automatica'`; sem fallback por `score_em`. Seed da prova tem a rodada atravessada; sabotagem `score_rodada_errada` → A4c |
| P2 | Textos afirmam causa não verificada | "nenhuma foto RFB registrada" (há fotos de leads); "sem score: dado insuficiente" (NULL também é já-cliente/fora da foto) | "nenhum cliente com situação cadastral verificada" · "Q sem score" |
| P2 | A6 do cron confere pouco | nome é único **por usuário**; `cron.timezone` mudaria o horário | A6 exige `username='postgres'`, `database=current_database()`, comando exato; A6b exige `cron.timezone` vazio/UTC |
| R5 | `EXISTS` correlacionado chamando função STABLE | não prova N chamadas, mas depende do plano | CTE `MATERIALIZED` do universo pequeno (clientes) × foto do lote |

Sintaxe (precedência, `FOR … FOR UPDATE`, `GET DIAGNOSTICS`, NULL no concat, `to_char` com `G` em locale C): sem reprodução; `G` trocado por `,` + `replace` mesmo assim (independência de locale).

## Medido em prod (1ª execução real, 2026-10-20 15:21 UTC)

Apply pelo envelope (ensaio `ENSAIO_OK` + ROLLBACK antes; postcondição A1–A7 com md5 do corpo `32be942a…`; 2ª testemunha psql-ro: coluna, função SECURITY DEFINER/ACL fechada, cron 228 ativo `postgres`, 2026-05 `avisado_em=finalizado_em`, 2026-08 NULL). Depois, `SELECT public.radar_avisar_lote();` uma vez:

| | |
| --- | --- |
| Alerta | `fornecedor_alerta` **548**, `[Radar] lote 2026-08: 27.466 inéditos de 501.380`, `pendente_notificacao` |
| Inéditos | 27.466 de 501.380 (27.460 na fila hoje) |
| Saíram | 52.262 de 526.176 do lote 2026-05 |
| Baixas | nenhum cliente verificado (a foto RFB só entra com a edge `radar-ingest` v1.2 do #3212, deploy pendente) |
| Score | calculado (`lote_vigente=2026-08`): **275 de 27.466** ≥ 70, 6 sem score; top 10 de 83 a 79 (Metalforma/Claudio, Casa Origem/BH, …) |
| Dedupe | `avisado_em = 15:21:17`; 2ª chamada → `{"avisados":0}` |
| Ledger | `radar.avisar_lote` automatica/sucesso, `detalhes.lotes[0].alerta_id=548` |

E-mail: `dispatch-notifications` roda a cada 30 min (cron 102) — o estado de `email_enviado` do 548 fica no PR.

## Lições

- **O denominador certo depende de QUANDO se mede.** `ultimo_lote` é foto corrente, não histórico: a carga seguinte o sobrescreve. Número de lote fechado vem do que o finalize **persistiu** (`novos`) ou de um eixo que o tempo não reescreve (`primeira_vista_em` na janela do lote). "Score do lote" é o que a rodada **declarou** ter avaliado (`lote_vigente`), não o que terminou depois de uma hora qualquer.
- **Backfill numa migration idempotente é armadilha:** "idempotente" do DDL ≠ inócuo para o dado. Um `UPDATE` de bootstrap que roda a cada re-colada apaga estado legítimo criado entre as coladas — amarre o backfill à **criação** do objeto.
- **Guarda interna da função é camada que a falsificação precisa cegar:** `repete_aviso` ficou vermelho na guarda `avisado_em marcou 0` antes de chegar ao assert A6; só `repete_aviso_sem_guarda` prova que a suíte pega sozinha. A prova ganhou a forma `guarda:<regex>` ao lado de `post:<A>`.

## Follow-ups (não feitos)

- Bloco 5: aprovação em 1 clique a partir do e-mail (fora do escopo aqui).
- Cadência: se "avisar perto do fechamento" virar requisito, trocar o diário por `*/30` com confirmação explícita do score (hoje o aviso espera a rodada das 06:30 para ter ranking).
- Quando a edge v1.2 estiver no ar, o próximo lote traz K de M real na linha de baixas — conferir no 1º e-mail pós-deploy.
