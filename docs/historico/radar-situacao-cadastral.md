# Radar: situação cadastral (RFB) — baixa de CNPJ descarta lead e avisa o gestor

> PR: #PR_NUM (2026-10-19). Bloco seguinte ao #3169 (carga mensal) e ao #3175/#3192 (CNPJ alfanumérico). Origem: medição da 1ª carga automática.

## O problema

Na 1ª carga automática (lote 2026-08, 2026-10-19, 2h58), **52.262** empresas sumiram do dump entre 2026-05 e 2026-08 e **seguem na fila** com `ultimo_lote` antigo; **251** delas são clientes (`ja_cliente=true`). Sumir ≠ baixa: a empresa pode ter trocado o CNAE principal e continuar ativa. A regra precisa da **situação cadastral extraída** (02 ativa · 03 suspensa · 04 inapta · 08 baixada · 01 nula), não da ausência — e a carga só guardava quem era `situacao='02' AND cnae1 IN alvo`.

Dois públicos, duas ações: **lead** baixado/inapto/suspenso sai da fila (`descartado`, com motivo RFB no histórico); **cliente** (nosso, dentro ou fora do radar) nessa situação vira **e-mail ao gestor** — tarefas e WhatsApp estão congelados até 2027-01-10, então o canal é `fornecedor_alerta` → `dispatch-notifications` (padrão Sentinela) + selo na UI.

## Medido ANTES de escrever (dump 2026-08, streaming local dos 10 zips de Estabelecimentos, 2026-10-19)

MEDICAO_PLACEHOLDER

## O que entrou

1. **`scripts/radar/carga.ts`** — passo 0 novo: pede à edge a lista de CNPJs conhecidos (ação `cnpjs_conhecidos`, keyset de 50.000) **antes** dos zips; o scan de cada zip passa a ter **uma** leitura do CSV com as duas condições em `OR` para uma temp table pequena, de onde saem o parquet filtrado (como antes) e `sit_conhecidos_i.parquet` (cnpj, situacao, dt_sit, motivo). Cache/resume só vale com os dois parquets. `Motivos.zip` (63 pares) dá a descrição. Depois dos chunks normais, `chunk_situacao` (1000/vez); o `finalize` devolve o resultado da aplicação e a carga imprime. Edge antiga (sem a ação ou sem `descartadas_por_motivo`) **aborta** — ausente ≠ vazio. Dry-run local: `--conhecidos <csv>`; sem ele a extração é pulada com aviso. Helpers puros em `scripts/radar/situacao.ts` (`normalizarSituacao`, `mapaDeMotivos`, `decisaoSituacao` = espelho legível da regra SQL).
2. **Migration `20261019200000_radar_situacao_cadastral.sql`** (envelope `BEGIN/COMMIT`, postcondição com 9 predicados):
   - `radar_situacao_cadastral (cnpj, lote) PK` — foto por lote de TODO CNPJ conhecido, em qualquer situação; sem FK (cliente fora do radar entra); RLS leitura gestor como as demais `radar_*`, escrita só service_role; `alertado_em` = dedupe do aviso (**coluna dedicada, 1 escritor**).
   - `radar_empresas.rfb_situacao/_data/_lote` — denormalização lida pela UI (`select('*')`), 1 escritor; o upsert do `chunk` não toca (preservação por omissão, como `ja_cliente`).
   - `radar_docs_clientes()` — espelho da normalização de `radar_recruzar_ja_cliente()` (20261019150000) com nome; a função viva **não** foi tocada (arquivo quente). `radar_cnpjs_conhecidos(p_apos, p_limite)` — keyset radar ∪ clientes. `radar_rfb_descricao()` — texto único (`RFB: BAIXADA em dd/mm/aaaa (01 — EXTINCAO …)`).
   - **`radar_aplicar_situacao(p_lote, p_agora DEFAULT now())`** (SECURITY DEFINER, ACL só service_role), chamada pela edge no finalize **depois** do recruzar: (a) foto → `rfb_*`, nunca regride para lote mais velho; (b) lead (não-cliente, status ∉ descartado/virou_cliente) com 03/04/08 → `descartado` + linha em `radar_contatos` com `criado_por` = **UUID de sistema `00000000-0000-0000-0000-00000000ad0f`** ("Radar · RFB", documentado em `COMMENT ON COLUMN`; `criado_por` é NOT NULL sem default e não havia convenção) e `status_anterior`; (c) cliente (`ja_cliente` OU documento nas fontes) com 03/04/08 **visto pela 1ª vez para o par (cnpj, situacao)** → UMA linha em `fornecedor_alerta` (`oben`/`outro`/`atencao`, título `[Radar] N cliente(s) com baixa/inaptidão no lote YYYY-MM`, mensagem com razão social, CNPJ, situação, data, motivo e o denominador `de M clientes verificados`), marca `alertado_em`; (d) 02/01 → só (a). Guarda `vigente`: lote mais velho que a foto conhecida da empresa não descarta nem avisa.
3. **Edge `radar-ingest` `v1.1-cnpj-alfanumerico` → `v1.2-situacao-cadastral`**: ações `cnpjs_conhecidos` e `chunk_situacao` (validação por motivo em `situacao.ts` + teste Deno; upsert `onConflict: cnpj,lote` **sem** `alertado_em`); `finalize` chama `radar_aplicar_situacao` e propaga erro (lote vira `error`). Fingerprint regravado.
4. **UI**: selo "Baixado/Inapto/Suspenso pela RFB em dd/mm/aaaa" na linha (`RadarLinha`) e na ficha (`RadarDetailSheet`, + linha "Situação RFB"); `seloRfb`/`formatarDataIso` em `ui-helpers.ts` (sem `Date`, fuso não entra). 02/01/ausente não mostram nada — ausente ≠ ativa.

## Provas

- `db/test-radar-situacao-cadastral.sh` (no `nucleo-ci.txt`, `21 falsificar=8`): relógio controlado (`p_agora` fixo), 3 lotes (2026-08 → 2026-09 → 2026-07 chegando depois). Sabotagens, após controle verde na mesma invocação e nos dois locales (`LC_ALL=C` e `pt_BR.UTF-8`): `descarta_cliente`→A5 · `repete_alerta`→A9 · `descarta_02`→A4 · `so_radar`→A7 (cliente fora do radar some do e-mail) · `regride_lote`→A11 · `sem_denominador`→A7b · `acl_aberta`→post:A7 · `acl_aberta_sem_post`→A12. Também: espelho `radar_docs_clientes()` × `radar_recruzar_ja_cliente()` vivo (A13/A13b), RLS por `SET ROLE` + GUC (A15), keyset (A16).
- Vitest: `scripts/radar/situacao.test.ts` (parser/decisão, 8), `src/lib/radar/__tests__/ui-helpers.test.ts` (selo, +3), `scripts/radar/radar-ingest-situacao.test.ts` (edge e carga como TEXTO: ordem recruzar→aplicar, upsert sem `alertado_em`, um scan por zip, VERSAO). Deno: `situacao_test.ts` (3).

## Camadas de deploy (quem faz o quê)

| Camada | Estado | Quem |
| --- | --- | --- |
| Migration `20261019200000` | DEPLOY_MIGRATION_PLACEHOLDER | sessão (envelope MCP + 2ª testemunha psql-ro) |
| Edge `radar-ingest` v1.2 | DEPLOY_EDGE_PLACEHOLDER | `bun run pendencias:deploy` → `pendencias:pacote` → chat do Lovable, após o merge |
| Publish do Lovable (selo na UI) | ⏳ após o merge | founder (Publish) |
| 1ª execução real | próxima carga (2026-09, segunda 03:00 BRT ou `gh workflow run`) — o retorno do `finalize` nos logs traz `leads_descartados`/`clientes_alertados_novos` | auto |

## Codex

CODEX_PLACEHOLDER

## Follow-ups (não feitos aqui)

- **Consulta em tempo real por API pública** (cartão CNPJ na ficha, sob demanda) — fora do escopo; o dump mensal é a fonte.
- **Sugestão de CNPJ sucessor pelos sócios** (empresa baixada cujos sócios abriram outra — `Socios*.zip` já é lido pela carga) — fora do escopo.
- **Lead descartado pela RFB que reativa (02) em lote posterior**: fica `descartado` com o motivo RFB preservado e o selo some; reabrir automaticamente é decisão de produto (hoje o gestor reabre pela ficha).
- **Cliente que oscila 03 → 02 → 03**: o dedupe por (cnpj, situacao) não re-avisa; se a oscilação importar, trocar a chave para (cnpj, situacao, data_situacao).
- **Sensor na Sentinela** (`radar_lote_idade`, `radar_recruzamento_tick`) continua desenhado e não instalado — ver `radar-carga-mensal-e-recruzamento-diario.md`.

## Lições

- **Sumir do dump não é evento**: só a situação extraída é. A primeira versão do filtro jogava fora exatamente a coluna que decide.
- **Dois públicos, dois verbos**: o mesmo código 08 é "tira da fila" para lead e "avisa" para cliente — e `ja_cliente` sozinho não basta (cliente só-documento, cliente fora do radar), por isso a função reclassifica pelo documento, depois do recruzar.
- **Dedupe mora em coluna dedicada da tabela que observa** (`alertado_em`), não no `fornecedor_alerta` (sem chave) nem em jsonb multi-writer.
