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

__PROD_RUN__

## Camadas de deploy (quem faz o quê)

| Camada | Estado | Quem |
| --- | --- | --- |
| Migration (colunas + índice + função + cron) | ✅ aplicada pelo canal `postgres` (MCP), validada por `psql-ro` | sessão |
| 1ª execução de `radar_score_recalcular()` | ✅ (acima) | sessão |
| Publish do Lovable (front: preset, badge, ficha) | ⏳ após o merge | **founder** (Publish) |

## Codex

Desenho: **Caminho B** — `scripts/codex-async.sh -r max` devolveu `exit 79` (guard local: cota em 97 %, teto 85 %; janela reabre 24/10 19:09). A RÉGUA foi escrita e conferida na sessão (prompt em `logs/`… não; está no corpo do PR). Código: ver o corpo do PR (`sem-codex:` ou parecer, conforme a decisão do founder sobre gastar a reserva).

## Provas

- `db/test-radar-score.sh` (no `nucleo-ci.txt`, 18 asserts, `--falsificar` 12/12 vermelhas com controle verde): determinismo (A5), monotonia por fator (A6), NULL honesto (A4/A14/A15), ja_cliente não pontua (A4/A12), idade pelo lote e não pelo relógio (A10), ledger com faixas (A7), ACL (A8), cron (A9), erro propaga (A13), `updated_at` intocado (A11). Três sabotagens são pegas pela própria postcondição da migration (ACL, cron, md5 do corpo) e as variantes `_sem_post` provam que o assert da suíte pega sozinho.
- `src/lib/radar/__tests__/ui-helpers.test.ts`: preset `score` + `scoreUI` (NULL ≠ 0, tons por faixa, motivos na ordem do banco).

## Follow-ups (fora deste bloco)

- Bônus por `cnaes_secundarios` de tier 1 (não entrou: precisa medir se o secundário prediz compra antes de pesar).
- Proximidade por clientes **ativos** do ERP (hoje conta `ja_cliente` do radar, inclusive os fora da foto) — trocar quando houver a tabela de clientes com município normalizado.
- Disparar o recálculo no `finalize` da edge `radar-ingest` (hoje o lote novo só reflete no cron das 03:30).
- Sensor na Sentinela: ausência de `sucesso` do slug `radar.score_recalcular` em 48 h (junto com o check do recruzamento desenhado no bloco 1).
