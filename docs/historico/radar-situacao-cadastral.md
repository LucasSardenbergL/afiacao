# Radar: situação cadastral (RFB) — baixa de CNPJ descarta lead e avisa o gestor

> PR: #3212 (2026-10-19/20). Bloco seguinte ao #3169 (carga mensal) e ao #3175/#3192 (CNPJ alfanumérico). Origem: medição da 1ª carga automática.

## O problema

Na 1ª carga automática (lote 2026-08, 2026-10-19, 2h58), **52.262** empresas sumiram do dump entre 2026-05 e 2026-08 e **seguem na fila** com `ultimo_lote` antigo; **251** delas são clientes (`ja_cliente=true`). Sumir ≠ baixa: a empresa pode ter trocado o CNAE principal e continuar ativa. A regra precisa da **situação cadastral extraída** (02 ativa · 03 suspensa · 04 inapta · 08 baixada · 01 nula), não da ausência — e a carga só guardava quem era `situacao='02' AND cnae1 IN alvo`.

Dois públicos, duas ações: **lead** baixado/inapto/suspenso sai da fila (`descartado`, com motivo RFB no histórico); **cliente** (nosso, dentro ou fora do radar) nessa situação vira **e-mail ao gestor** — tarefas e WhatsApp estão congelados até 2027-01-10, então o canal é `fornecedor_alerta` → `dispatch-notifications` (padrão Sentinela) + selo na UI.

## Medido ANTES de escrever (dump 2026-08, streaming local dos 10 zips de Estabelecimentos, 2026-10-19)

Streaming dos 10 zips de `Estabelecimentos` (2026-08) no Mac, sem descompactar em disco (`unzip -p | tr -d NUL | iconv | python3 -I`), casando cada CNPJ (b+o+dv) com o conjunto radar ∪ clientes exportado de prod por `psql-ro` (563.159 CNPJs: 551.123 do radar + 15.063 documentos de cliente normalizados como `radar_recruzar_ja_cliente`). **563.158 casaram** — só 1 documento de cliente não existe no dump.

| Universo | n | 02 ativa | 03 suspensa | 04 inapta | 08 baixada | 01 nula | **irregulares (03/04/08)** |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Radar inteiro | 551.101 | 502.077 | 60 | 38.603 | 10.353 | 8 | **49.016** |
| **Sumidos** (`ultimo_lote` ≠ 2026-08) | 52.128 | 3.104 | 60 | 38.603 | 10.353 | 8 | **49.016 (94%)** |
| … dos quais `ja_cliente` | 251 | 11 | 0 | 193 | 47 | 0 | **240 (96%)** |
| … dos quais lead na fila | 51.877 | 3.093 | 60 | 38.410 | 10.306 | 8 | **48.776** |
| Vigentes (2026-08) | 498.973 | 498.973 | 0 | 0 | 0 | 0 | 0 |
| Clientes por documento (profiles ∪ Omie) | 15.062 | 12.272 | 52 | 1.074 | 1.661 | 2 | **2.787 (18,5%)** |
| … fora do radar (CNAE fora do alvo) | 12.058 | 9.508 | 52 | 881 | 1.614 | 2 | **2.547** |

Leituras: (1) **sumir do dump É quase sempre baixa/inaptidão** — 94% dos sumidos (e 96% dos clientes sumidos) estão em 03/04/08; só 3.104 trocaram de CNAE e seguem ativos (ficam na fila com lote antigo — bloco 2). (2) A **hipótese "pode ser mudança de CNAE"** valia para 6%, por isso a regra precisa da situação extraída, não da ausência. (3) O 1º finalize com esta regra descarta **48.776 leads** e abre **um** e-mail com **2.787 clientes irregulares de 15.061 verificados** — a maioria (2.547) são clientes Omie fora do radar, cadastros históricos; por isso o e-mail lista os **100 mais recentes** e aponta a lista completa na tabela (teto `c_teto_linhas`, assert A17). (4) Nenhum caso de 02 → descarte: os 498.973 vigentes são todos 02, como o filtro da carga garante.

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

- `db/test-radar-situacao-cadastral.sh` (no `nucleo-ci.txt`, `22 falsificar=9`): relógio controlado (`p_agora` fixo), 3 lotes (2026-08 → 2026-09 → 2026-07 chegando depois). Sabotagens, após controle verde na mesma invocação e nos dois locales (`LC_ALL=C` e `pt_BR.UTF-8`): `descarta_cliente`→A5 · `repete_alerta`→A9 · `descarta_02`→A4 · `so_radar`→A7 (cliente fora do radar some do e-mail) · `regride_lote`→A11 · `sem_denominador`→A7b · `sem_teto`→A17 (e-mail com teto de 100 linhas + "… e mais N") · `acl_aberta`→post:A7 · `acl_aberta_sem_post`→A12. Também: espelho `radar_docs_clientes()` × `radar_recruzar_ja_cliente()` vivo (A13/A13b), RLS por `SET ROLE` + GUC (A15), keyset (A16).
- Vitest: `scripts/radar/situacao.test.ts` (parser/decisão, 8), `src/lib/radar/__tests__/ui-helpers.test.ts` (selo, +3), `scripts/radar/radar-ingest-situacao.test.ts` (edge e carga como TEXTO: ordem recruzar→aplicar, upsert sem `alertado_em`, um scan por zip, VERSAO). Deno: `situacao_test.ts` (3).

## Camadas de deploy (quem faz o quê)

| Camada | Estado | Quem |
| --- | --- | --- |
| Migration `20261019200000` | ✅ APLICADA em 2026-10-20 10:18 UTC pelo envelope MCP (`postgres`): ensaio com `RAISE EXCEPTION 'ENSAIO_OK'` + md5 dos 4 corpos iguais ao arquivo (`4857…`, `51e4…`, `b162…`, `ec75…`), rollback conferido, apply real, 2ª testemunha psql-ro em outra conexão: `tabela_pk_ok=t rls_ok=t policy_ok=t anon_select=f cols_rfb=3 check_ok=t`, 3 funções `secdef=t anon/auth/public=f service=t`, `ja_cliente_total=3007` (inalterado), `linhas_sit=0`. **Reaplicada às 11:5x UTC** com o teto de 100 linhas no e-mail (TRAVA→PRE md5 `4857…`→CREATE→PÓS md5 `73e049de…`, ensaio com rollback antes), 2ª testemunha psql-ro: md5 `73e049de…`, ACL fechada, zero efeito (`linhas_sit=0`, `alertas_radar=0`, `descartados_sistema=0`) | sessão |
| Edge `radar-ingest` v1.2 | ✅ **DEPLOY CONFIRMADO** em 2026-10-20 (detalhe na seção abaixo) | sessão (`pendencias:pacote` → chat do Lovable → sonda) |
| Publish do Lovable (selo na UI) | ✅ feito 2026-10-20 e verificado no bundle servido | founder (Publish) |
| 1ª execução real | próxima carga (2026-09, segunda 03:00 BRT ou `gh workflow run`) — o retorno do `finalize` nos logs traz `leads_descartados`/`clientes_alertados_novos` | auto |


## Deploy da edge (2026-10-20, após o merge do #3212)

- `pendencias:deploy` (main `928e74e1c`): só `radar-ingest` pendente (prod `v1.1-cnpj-alfanumerico` → main `v1.2-situacao-cadastral`); as outras 82 conferem.
- `pendencias:pacote` (`eeaaba0b01c9`): pré-condição de banco verde — `radar_aplicar_situacao`, `radar_cnpjs_conhecidos` e `radar_recruzar_ja_cliente` existem em prod com o corpo da última migration do repo.
- Antes do envio: chat do Lovable ocioso há ~11 h; único PR aberto no fecho da edge era o #3215, que só mexe na entrada da `omie-vendas-sync` do mapa de fingerprints (se mergeasse no meio, o hash divergente faria o bot parar sem deployar). Main re-conferida colada ao envio.
- Envio às **12:43:05 UTC**. O bot conferiu os 7 arquivos (`sha256sum -c` exit 0), deployou e respondeu "No files were edited.".
- **Sonda** (`db/2026-10-20-sonda-disparo-radar-ingest-v1.2.sql` por `db:aplicar`, ensaio antes, tentativa #577; passo 2 por psql-ro): request 124207, HTTP 200, `versao=v1.2-situacao-cadastral`, `fonte=3e3fa6c7…` (= `FONTE_SHA256["radar-ingest"]` da main) → **DEPLOY CONFIRMADO**. `pendencias:deploy` saiu **0** com `radar-ingest` em ✅ "via sonda".
- **Sensor de edição: EDICAO_DETECTADA, e a leitura dele.** A regra é "qualquer eixo com edição vence": a resposta do MCP trouxe `edit_id`/`commit_sha` (`23b0882b9`). No eixo git, os dois commits do bot desde o envio (`5d765941e` "Work in progress" e `23b0882b9` "Lovable update") tocam **só** `src/integrations/supabase/types.ts` e foram classificados `tolerado`: é a sincronização automática do schema que acrescenta a tabela nova `radar_situacao_cadastral` (+58 linhas, 0 removidas, uma ocorrência só no arquivo final). Nenhum arquivo em `supabase/` mudou desde o commit do pacote, e `typecheck:app` na main com a mudança sai 0. **Decisão: não reverter** — o tipo espelha a tabela real de prod; reverter só desalinharia o arquivo gerado. Fica registrado como edição do bot benigna, não como "No files were edited." verdadeiro.
- Observação do bot, sem relação com esta leva: o log de build acusa `src/sw/releases.ts:133` TS2304 (`RequestCache`/`RequestCredentials`); o `typecheck:app` local, que é o gate, passa.
- **Publish** feito pelo founder e verificado no bundle servido em `steu.lovable.app` (2026-10-20 12:56 UTC): o chunk `RadarClientes-CKdhPUgt.js` traz os 2 `data-testid="selo-rfb"` (linha e ficha) e o rótulo "Situação RFB"; o helper compartilhado (`RadarOutcomeMenu-Dbfo8AXP.js`) traz "pela RFB" e lê `rfb_situacao`. Disponibilidade, não adoção: o service worker troca de build no clique do cliente.

## Codex

**Não consultado — Caminho B.** `scripts/codex-async.sh -r max` recusou as duas chamadas (desenho e código) com `exit 79 SALDO_ALTO`: cota em 94% (teto 85%), janela de 7 dias reabre em 24/10 19:09. As 3 saídas são do founder (DRAFT · Caminho B · `CODEX_ASYNC_TETO_SALDO=0` para gastar a reserva); o PR nasce DRAFT com `sem-codex:` no corpo e o prompt de desenho (com a RÉGUA) fica em `docs/historico/radar-situacao-cadastral-codex-prompt.md` para rodar quando a janela reabrir. Perguntas que eu levaria ao Codex e respondi sozinho: (1) dedupe por (cnpj, situacao) não re-avisa oscilação 03→02→03 (documentado como follow-up); (2) lead reativado fica descartado com motivo preservado; (3) `rfb_*` denormalizado tem 1 escritor e o `chunk` não toca; (4) uuid fixo de sistema em vez de `DROP NOT NULL` (o undo humano filtra `criado_por = auth.uid()` e não alcança a linha de sistema — por desenho); (5) `radar_docs_clientes()` é cópia literal da normalização viva, provada igual no seed (A13/A13b); (6) custo do scan: uma leitura por zip com `OR` + semi-join em 563k chaves, sem segunda passada.

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
