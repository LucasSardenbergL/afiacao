# Radar: score determinístico de lead (bloco 3 do brainstorm, 2026-10-19)

**Problema:** a fila de prospecção (/radar) ordenava por UM eixo escolhido à mão (data de abertura ou capital). O vendedor abria a lista e ligava "de cima para baixo" sem nenhum critério que juntasse CNAE, porte, capital, idade, proximidade e contato — e um lead que saiu do dump (52.262 com `ultimo_lote=2026-05`) ou já é cliente ficava misturado com os bons. O bloco 5 (aprovação em 1 clique) precisa de um insumo: **quem vale a pena** — nunca cadastrar 500k no ERP.

## O que entrou

1. **Colunas dedicadas em `radar_empresas`** (migration `20261019180000_radar_score_lead.sql`, aplicada em prod pelo canal `postgres`/MCP, validada por `psql-ro`): `score smallint` (NULL = não calculado/insuficiente, **nunca 0 fabricado**), `score_motivos text[]` (fatores que pontuaram, legíveis; ou o motivo do NULL), `score_em timestamptz` (instante da última **mudança**, não da última avaliação — a frescura da rodada é o ledger). Índice parcial `idx_radar_lista_score (score DESC NULLS LAST, cnpj)` com o mesmo predicado dos índices da fila.
2. **`radar_score_recalcular()`** — SECURITY DEFINER, ACL só `postgres`/`service_role` (REVOKE nomeando PUBLIC/anon/authenticated), **único escritor** das 3 colunas. Pesos num CTE `VALUES` versionado pela migration (md5 do `prosrc` na postcondição: mudar peso = nova migration no molde TRAVA→PRE→CREATE→PÓS). Soma máxima 100:

   | Fator | Pontos | Regra |
   | --- | --- | --- |
   | CNAE (tier da curadoria) | 25 / 15 / 8 | tier 1 = móveis (3101200, 3102100, 3103900), marmoraria, artefatos de madeira, restauração de mobiliário; tier 2 = carpintaria/esquadrias/casas de madeira, tanoaria, serrarias, vidraçaria, estruturas metálicas; tier 3 = serralheria, esquadrias de metal, usinagem, polimento, vidro, laminados. Tiers informados pela **penetração medida** (ja_cliente/total por CNAE: tier 1 ≥ 0,4 %, tier 3 < 0,1 %) |
   | Porte (RFB) | 10 / 8 / 3 | `05` demais · `03` EPP · `01` ME (`00`/NULL = 0, sem motivo) |
   | Capital social | 15 / 12 / 10 / 6 / 3 | ≥ 1 mi · 500 mil–1 mi · 100–500 mil · 50–100 mil · 10–50 mil (NULL/<10 mil = 0, sem motivo) |
   | Idade | 10 / 8 / 6 / 4 | 3–10 anos · 10+ · 1–3 · <1 — referência = **1º dia do mês do lote vigente** (determinístico; o gate `relogio-nu-da-sessao` proíbe `current_date` e a prova A10 mostra que o relógio da sessão mudaria o score sozinho) |
   | Proximidade comercial | 20 / 15 / 10 / 6 · 5 | `ja_cliente` no MESMO `municipio_codigo` (≥30 · 10–29 · 3–9 · 1–2); senão UF com ≥100 clientes = 5 |
   | Contato | 7 + 3 | telefone · e-mail |
   | Inédito no lote vigente | 10 | `primeira_vista_em ≥ iniciado_em` do lote vigente |

   `ja_cliente` ⇒ NULL `{já é cliente}` · `ultimo_lote` < vigente ⇒ NULL `{fora da foto vigente}` · sem lote `complete` ⇒ todos NULL `{sem lote vigente}`. Descartados pontuam (status é workflow, não qualificação). Dado faltante num fator = 0 ponto **e sem motivo** (nunca "capital baixo" para capital NULL). UPDATE só onde `(score, motivos) IS DISTINCT FROM` o atual (2ª rodada = 0 alterados). Ledger `acoes_execucoes` (slug `radar.score_recalcular`, origem `automatica`, detalhes: lote, avaliados, alterados, nulos por motivo, faixas 0–19/20–39/40–59/60–79/80–100, duração). Erro **propaga** (job_run_details `failed` com a mensagem real); só a gravação do ledger é fail-open.
3. **Cron próprio** `radar-score-recalcular-diario`, `30 6 * * *` = **03:30 BRT**, 15 min depois do recruzamento (jobid 213, ~11 s). Não encadeado no job 213: o pg_cron envia o comando como UMA transação — uma falha no score desfaria o recruzamento e o ledger dele; jobs separados = falhas e sensores independentes. Rodar antes do recruzamento custaria no máximo 1 dia de `ja_cliente` defasado.
4. **Front** (cirúrgico, sem tocar a edge nem `carga.ts`): preset default da fila `score` ("Melhores leads", `score DESC NULLS LAST`, tie-break `cnpj`); badge do score na linha (`title` = motivos); na ficha, `score / 100` + lista de motivos; NULL vira **"sem score"** com o motivo do banco (`fora da foto vigente`, `já é cliente`) ou "ainda não calculado" quando a coluna ainda não foi escrita. `scoreUI()` em `src/lib/radar/ui-helpers.ts` (0 é score válido; NULL é estado).

## Medição em prod (psql-ro, 2026-10-19, antes da migration)

553.642 empresas; 501.380 na foto 2026-08; 3.007 `ja_cliente`; 52.262 fora da foto; 27.466 inéditas. Porte: 94 % ME. Capital: 52 % < R$ 10 mil, 4.280 ≥ R$ 1 mi. Idade: 25 % ≥ 10 anos. Geografia: MG tem 2.997 dos 3.007 clientes; 139 municípios com ≥1 cliente (p50 = 4, p90 = 52, máx 290); 491.888 leads em município sem cliente, 4.724 em município com ≥30.

## 1ª execução em prod

Rodada manual pelo canal `postgres` (MCP) em 2026-10-20 11:36 UTC — o cliente MCP estourou o timeout, mas a função é atômica e terminou do lado do banco (ledger `sucesso`, **96,3 s**; rodadas manuais longas: use o SQL Editor ou leia o ledger depois).

| | |
| --- | --- |
| avaliados / alterados | 553.642 / 553.642 (1ª rodada escreve tudo) |
| com score | **498.624** |
| sem score | 3.007 já clientes · 52.011 fora da foto (os 251 restantes dos 52.262 são já-clientes, contados antes) · 0 sem lote |
| faixas | 0–19: 1.657 · 20–39: 233.749 · 40–59: 250.784 · 60–79: 12.401 · 80–100: 33 |
| p50 / p90 / máx / mín | 41 / 53 / 90 / 18 |
| ≥ 60 por UF | MG 5.920 · SP 2.340 · RS 605 · SC 573 · PR 538 · ES 492 |
| ≥ 60 por CNAE | 3101200 móveis madeira 6.620 · 2391503 marmoraria 1.722 · 1629301 artefatos madeira 1.412 · 9529105 restauração 836 · 3102100 móveis metal 644 · 3103900 334 |

Topo da fila (score 90/88/86): fábricas de móveis de porte "demais", capital ≥ R$ 1 mi, em Nova Serrana, Cláudio e Formiga (MG, municípios com 35–117 clientes), com telefone e e-mail. A mesma razão social aparece 3× no topo (filiais com CNPJ próprio) — **follow-up**: agrupar matriz/filiais na fila.

Leitura: a distribuição é um sino centrado em 41 (94 % ME, 52 % com capital < R$ 10 mil puxam para baixo); o que separa o topo é CNAE tier 1 + proximidade + capital. Nenhum 0 fabricado: o mínimo é 18, e o NULL carrega o motivo.

## Camadas de deploy (quem faz o quê)

| Camada | Estado | Quem |
| --- | --- | --- |
| Migration (colunas + índice + função + cron) | ✅ aplicada pelo canal `postgres` (MCP), validada por `psql-ro` | sessão |
| 1ª execução de `radar_score_recalcular()` | ✅ (acima) | sessão |
| Publish do Lovable (front: preset, badge, ficha) | ⏳ após o merge | **founder** (Publish) |

## Codex

- **Desenho: Caminho B.** `scripts/codex-async.sh -r max` devolveu `exit 79` (guard local: cota em 97 %, teto 85 %). A RÉGUA foi escrita e conferida na sessão (está no corpo do PR).
- **Código: gpt-6-astra · max · 538 s · 178.416 tokens**, com a reserva liberada pelo founder (`CODEX_ASYNC_TETO_SALDO=0`). 6 achados, **todos tratados** na migration `20261020120000_radar_score_lead_v2.sql` (molde TRAVA→PRE→CREATE→PÓS sobre a v1 viva) e no front:

| Achado | Severidade | O que mudou | Prova |
| --- | --- | --- | --- |
| Chunk de lote `running` (`ultimo_lote > vigente`) pontuava com "inédito no lote anterior" | ALTO | NULL `{lote em ingestão}` | A4, A14, sabotagem `lote_running_pontua` |
| `UPDATE … FROM calc` gravava score do snapshot velho na linha que o recruzamento/ingestão acabou de mudar (EvalPlanQual reavalia só o alvo) | ALTO | guarda de versão: `updated_at`/`ja_cliente` iguais aos lidos; senão a linha é **pulada** (`pulados` no ledger) e refeita na rodada seguinte | **A17 com duas sessões reais** (lock segurado em `pg_sleep`), sabotagem `sem_guarda_versao` |
| Ledger contava `avaliados` num snapshot diferente do cálculo | MÉDIO | cálculo, UPDATE e resumo num só comando (CTE modificadora + `RETURNING`) | A1, A7b |
| Paginação por offset pula/repete lead quando o ranking muda entre páginas | MÉDIO | a rodada do ledger vira a versão da fila (`versaoDaFila`), entra na `queryKey` e reinicia a paginação; revisada a cada 10 min | vitest `versaoDaFila` |
| Prova de monotonia não pegava inversão de uma faixa inteira de capital | MÉDIO | escada de capital nas bordas (9.999 → 1.000.000) + EPP | A6b, sabotagem `faixa_invertida` |
| Ficha mostrava a idade de hoje e o motivo a idade do lote | BAIXO | o motivo cita a referência: "empresa com 3–10 anos (ref. 2026-08)" | A3, A10 |

- **Aplicação da v2 em prod:** pré-voo (vivo = md5 da v1, volátil, cron ativo) → ensaio com `RAISE 'ENSAIO_OK'` e rollback → apply como `postgres` → psql-ro `✅` (md5 `5413669a…`, ACL fechada, cron 225 intacto).
- **A rodada manual da v2 NÃO persistiu:** desta vez o timeout do cliente MCP (~60 s) derrubou a transação de ~96 s (nenhuma linha nova no ledger). **Nada fica errado na fila:** sem lote em ingestão, 0 linhas acima do vigente, 0 já-cliente com score — os números da v1 são os mesmos da v2; só o texto do motivo de idade muda. O cron 225 grava a v2 às **03:30 BRT de 2026-10-21**. **Lição:** rodada manual longa não vai pelo MCP — use o cron, ou o SQL Editor.

## Provas

- `db/test-radar-score.sh` (no `nucleo-ci.txt`, aplica v1 → v2 como em prod, **21 asserts**, `--falsificar` **14/14** vermelhas com controle verde): determinismo (A5), monotonia por fator e nas bordas das faixas (A6/A6b), NULL honesto (A4/A14/A15), ja_cliente não pontua (A4/A12), idade pelo lote e não pelo relógio (A10), ledger do mesmo snapshot (A7), ACL (A8), cron (A9), erro propaga (A13), `updated_at` intocado (A11), **escritor concorrente em duas sessões (A17)**. Sob `CREATE OR REPLACE` tirar o `REVOKE` da v2 é inerte (medido: suíte verde); a sabotagem de ACL injeta um `GRANT` indevido.
- `src/lib/radar/__tests__/ui-helpers.test.ts`: preset `score`, `scoreUI` (NULL ≠ 0, tons por faixa, motivos na ordem do banco) e `versaoDaFila`.

## Follow-ups (fora deste bloco)

- Agrupar matriz/filiais (mesma razão social, CNPJs distintos) na fila — hoje 3 filiais da mesma metalúrgica ocupam 3 posições do topo.
- Bônus por `cnaes_secundarios` de tier 1 (não entrou: precisa medir se o secundário prediz compra antes de pesar).
- Proximidade por clientes **ativos** do ERP (hoje conta `ja_cliente` do radar, inclusive os fora da foto) — trocar quando houver a tabela de clientes com município normalizado.
- Disparar o recálculo no `finalize` da edge `radar-ingest` (hoje o lote novo só reflete no cron das 03:30).
- Sensor na Sentinela: ausência de `sucesso` do slug `radar.score_recalcular` em 48 h (junto com o check do recruzamento desenhado no bloco 1).
