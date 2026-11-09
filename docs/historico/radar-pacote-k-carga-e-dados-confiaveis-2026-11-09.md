# Radar — pacote K: carga e dados confiáveis (2026-11-08/09)

Achados da 3ª revisão do Radar (Codex + Fable), confirmados no código e na PROD (psql-ro). Quatro itens, três entregas.

## K1 — erro transitório num chunk não derruba a carga (#3757, edge `v1.8-chunk-recuperavel`)

Narrativa e prova em [radar-carga-publicacao-atomica.md](radar-carga-publicacao-atomica.md#pacote-k1--erro-transitório-num-chunk-não-derruba-mais-a-carga-edge-v18-chunk-recuperavel-2026-11-08).
Mergeado 2026-11-09 02:26Z. **Deploy pela sessão** (MCP, colagem do gerador, 9/9 sha256, 1,3 crédito) às 09:05Z; sonda
`db/sonda-radar-ingest-2026-11-09.sql` (recibo #1037) → `DEPLOY CONFIRMADO v1.8-chunk-recuperavel`; `pendencias:deploy`
exit 0. A carga agendada de segunda (cron `0 6 * * 1`) ainda não tinha disparado: o cron do GitHub atrasa horas (as duas
últimas agendadas saíram 12:18Z e 14:50Z). Nenhuma das falhas recentes da Action foi este bug (02/11: timeout da sonda
da RFB), então o achado é de revisão, não de incidente.

## K2 — card/e-mail cruzando a publicação, e contato não avaliado (migration 20261111132000)

**Card e e-mail ignoravam a publicação em passos.** `private.radar_leads_do_vendedor` recortava `ultimo_lote = vigente`
nos 3 ramos (território, atribuído pelo gestor, acompanhamento órfão). A publicação curta (20261111120000) reetiqueta
`ultimo_lote` para o lote P e guarda `lote_anterior`; durante a publicação de um mês novo, todo lead já reetiquetado
sumia do card (`radar_prospectar_hoje`) e do e-mail semanal (`radar_avisar_vendedores`). Agora é o predicado da
`radar_lista`: `ultimo_lote = ANY(ARRAY[V, P]) AND (ultimo_lote = V OR lote_anterior = V)`; sem lote completo, a empresa
só de P fica de fora.

**"Não é contabilidade" para contato nunca avaliado.** `private.radar_contato_contabil_avaliar` devolvia `false` para
todo contato sem marca desde que o estado global existisse. Depois de uma carga que troca telefone/e-mail, o número novo
saía como "não é" até o recálculo seguinte. Ausente ≠ zero: o `false` só vale se a linha da empresa não foi escrita
depois do cálculo (`radar_empresas.updated_at <= estado.calculado_em`); senão `NULL` ("não sei"). A premissa foi
**medida** antes de virar regra: sem trigger de touch, score/recruzamento/posses não gravam `updated_at`, o último
escritor diário é o das 06:05 e o recálculo roda 06:50 — às 09:10 de 2026-11-09, 0 de 573.021 linhas posteriores ao
cálculo. Efeito esperado: no dia de uma publicação de mês novo, o selo "não é" some até 06:50 do dia seguinte (a
marca positiva e a correção manual seguem valendo).

**Prova:** `db/test-radar-k2-foto-e-contato.sh` sobre os corpos de PROD (`db/fixtures/radar-k2-predecessora-prod-20261109.sql`):
F0/C0 mostram o predecessor errando; F1–F7 e C1–C7 o corpo novo; G1–G4 PRE/PÓS/ACL/re-aplicação e a cópia sem envelope
de `db/`. 21 asserts nos 2 locales; `--falsificar` 18 vermelhas / 0 falhas (9 sabotagens × 2 locales), no núcleo do CI.

**De passagem (não é do K):** `public.radar_coorte_sortear(integer)` tem o mesmo `ultimo_lote = v_lote` sem
`lote_anterior` — avisado à sessão M (medição), dona da coorte.

## K3 — alarme da carga verde com publicação parada (migration 20261111140000)

O sensor `radar_lote_idade` olhava só a idade do último lote COMPLETO (teto 75 dias). Erro depois do início da
publicação em passos fica em `carga_erro`/`carga_tentativas` com a fase `validada`; carga cujo loader morreu fica
`recebendo` — o check seguia verde com a foto sem atualizar. **Sem máquina nova:** a MESMA linha do
`_data_health_compute` ganha a carga em voo mais nova que a foto (watchdog, heartbeat e `v_sources` intactos):

| Estado da carga em voo | Status | Message (sem relógio — fingerprint do watchdog) |
|---|---|---|
| `falhou` num lote mais novo que o vigente | broken | `carga do lote M falhou e nao foi publicada` |
| `validada` com `carga_tentativas >= 3` | broken | `publicacao do lote M falhando em tentativas seguidas` |
| `validada` há > 6 h | stale | `lote M validado e sem publicar em 6 h` |
| `recebendo` há > 12 h | stale | `carga do lote M parada recebendo (sem finalize em 12 h)` |

Prazos **medidos**: o 2026-10 levou 5 h do begin ao validado (16:48 → 21:49 de 2026-11-08); timeout da Action 350 min.
Re-run do mês vigente que falha não alarma (a foto segue intacta); `falhou` superado por lote completo mais novo
também não. `last_error` = `carga_erro` da carga em voo.

**Colunas na cadeia viva das provas:** as `carga_*` são de 20261110130000/20261111120000, que não redefinem o trio e
por isso não entram na cadeia — foram para `db/fixtures/data-health-prod-depois-do-snapshot.sql` (o recorte de prod
posterior ao snapshot, #3731). Sem isso, as 10 provas que montam a cadeia aplicariam esta migration sobre um
`radar_ingest_state` sem as colunas e quebrariam no CREATE (função SQL valida colunas na criação).

**Prova:** `db/test-data-health-radar-carga-em-voo.sh` — A1 (a cadeia chega ao md5 de PROD `3fe9b3ab…`), R0 (o
predecessor ficava verde com a carga parada há 13 h), R1–R12, G1–G4. 19 asserts; `--falsificar` 11 sabotagens de corpo
(md5 'este' recalculado: só o comportamento pega). No núcleo do CI.
