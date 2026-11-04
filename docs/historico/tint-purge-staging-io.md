# Purge de staging tint saiu de cada promoção (2026-10-21)

**Gatilho:** o relatório de créditos do Lovable (08–21/10) apontou o porte `cloud_compute_small` como 89% do Run e sugeriu otimizar as views `v_titulo_baixas`/`v_oportunidade_economica_hoje` e espaçar crons. Medido via psql-ro, a causa era outra.

## O que a medição mostrou

- Janela de 15 min (`pg_statio_user_tables`, delta): `tint_staging_formulas` = **35.088 MB lidos do disco de 35.782 MB no banco inteiro (98%)**, 124 seq scans da tabela inteira (291 MB), cache hit 11,7%. Cache hit do banco: 77,7%.
- Causa: o bloco PURGE no fim de `tint_promote_sync_run` (DELETE de staging superseded >30d com `EXISTS` self-join) rodava em **toda** promoção, ~1.300/dia. 95% das linhas têm >30d e são latest-por-chave, então o predicado casa quase tudo e não apaga nada; índice em `created_at` não resolve.
- 18.580 de 18.581 runs `catalogs` em 14 dias tiveram efeito zero; 696 de 986 por dia tinham `total_records = 0`: o conector manda padracores/colecoes/subcolecoes/personcores, que a edge não grava, e cada lote abria run + promoção vazia.
- As views citadas eram ruído (`v_titulo_baixas` 1,5 s sobre 58 MB).

## O que mudou

- `20261021203000_tint_purge_staging_fora_do_promote.sql`: os mesmos 9 DELETEs em `tint_staging_purge()` (trava do tick, cron `tint-staging-purge-diario` 05:23 UTC), recortados do corpo vivo do promote (md5 PRE/PÓS). Prova `db/test-tint-purge-staging-diario.sh`: catálogo promovido idêntico ao do promote antigo + 9 falsificações.
- Edge `tint-sync-agent` v1.1: lote de `/catalogs` sem entidade gravável recebe o mesmo ack sem run (PR separado).

## Lições

- **Relatório de custo aponta sintoma; `pg_statio_user_tables` em DELTA (duas leituras com intervalo) aponta a tabela.** Os contadores cumulativos desde o boot misturam passado e presente.
- **Manutenção dentro do caminho quente multiplica pela frequência do caminho.** Purge/retention vai para cron próprio.
- **`string_agg` pula NULL** — assert por `string_agg` de coluna anulável é cego ao NULL (a falsificação F6 pegou).
- Leitores de preço pegam o latest **não-nulo**: o purge por "tem linha mais nova" pode apagar o último custo válido aos 30d (latente; registrado na migration).

## Próximo passo de custo

Downsize `small → micro` só depois de medir o I/O pós-apply (cache hit perto de 99% e leitura de disco ordens de grandeza menor).

### 2026-10-27 — o reenvio idêntico da personalizada (edge v1.2)

A medição de 27/10 (12:52–13:07 UTC) deu queda de 96% na `tint_staging_formulas`, mas ainda 1.271 MB/15 min (teto 350) e hit 97,08%. Causa restante: o conector 0.2.5 reenvia a cada ciclo (~10,5 min) a personalizada de `data_atualizacao` máxima (HWM com margem de 5 min + filtro de hash só com HWM zerado; detalhe em `docs/agent/tintometrico.md`). Foram 442 reenvios byte-idênticos da ERVA MATE desde 23/10; antes dela, COPAIBA, VERDE ACRILICO e CHOCOLATE, em revezamento. Cada um abria run de 1 registro e a promoção re-expandia o par FO20.6501/20 (8.240 fórmulas, ~35 s, ~320 MB de disco).

- Edge `tint-sync-agent` v1.2 (`formula-identica.ts`): lote de 1 a 5 fórmulas PERSONALIZADAS, com itens e sem subcoleção, recebe o ack sem run do #3333 quando CADA uma é idêntica à última staging da chave da promoção (raw_data canônico, colunas do header que o builder de hoje gravaria, itens como multiconjunto, run `promovido`) **e** o oficial já reflete essa staging (linhas de `tint_formulas` da chave existentes, todas ativas, com `updated_at` posterior a ela e com TODOS os itens de `tint_formula_itens` gravados depois dela), nenhum keys-snapshot foi recebido depois dela e a conta tem uma loja só. Qualquer diferença ou erro de consulta segue o caminho normal (falso negativo custa I/O; falso positivo seria dado perdido, porque o conector cacheia o hash no 200).
- **Lição (Codex P1, 1ª rodada): igualdade de STAGING não prova equivalência.** A 1ª versão só comparava a staging, e o Codex achou 3 contraexemplos concretos: fórmula desativada por snapshot e recriada idêntica na fonte; run `promovido` que não aplicou aquela linha (o `promovido` é do run, não da fórmula); e duas lojas sobre o mesmo oficial. A prova certa é o OFICIAL refletir a staging. E nem o `updated_at` basta (2ª rodada): o recálculo de preço também o avança sem reaplicar a receita. O carimbo confiável é o `created_at` dos ITENS oficiais, porque a promoção apaga e reinsere os itens de toda fórmula aceita e nada mais os toca.
- Falsificação: 26 sabotagens, uma por vez, todas vermelhas, com controle verde antes e depois na mesma invocação.
- Resíduo aceito: mudar `volume_ml` de embalagem não reexpande as doses. É a limitação já registrada em `docs/agent/tintometrico.md` e vale para todas as fórmulas cujo hash o conector cacheou.
- **Deploy e efeito (psql-ro, 2026-10-28 00:27 UTC):** a v1.2 foi deployada e atestada pela sonda (#3360, ~15:30 UTC de 27/10; `pendencias:deploy` → `✅ confere — 83`). O último run de `formulas` saiu às 15:30:50 UTC. Entre 15:31 e 20:16 UTC (último heartbeat do agente 0.2.5), houve 135 runs de catálogo e **zero** de fórmula, contra ~6 por hora antes (12h–15h UTC: 21 runs, 20 deles de 1 registro com 8.240 inserts). Cálculo: ~28 promoções de par evitadas no período, ~9 GB de leitura de disco poupados pelo perfil de 320 MB cada. A medição de I/O de 15 min com o agente ativo ficou na tarefa agendada `medir-io-pos-purge-tint` (28/10, 11h BRT), que também confere se a ERVA MATE só reaparece 1 vez por dia, depois do keys-snapshot.
- **Medição e veredito (2026-10-28, janela 14:01:11–14:16:13 UTC, agente ativo):** `tint_staging_formulas` leu **0 MB** do disco (Δheap_blks_read = 0; era 35.088 MB em 21/10 e 1.271 MB em 27/10). O banco todo leu **46,7 MB** (`pg_stat_database` Δblks_read = 5.973), e o cache hit da janela ficou em **99,92%**. Houve zero promoção em erro em 24h e 0 de 55 catálogos vazios em 2h. A ERVA MATE apareceu **1 vez** no dia, às 10:10:46, logo após o keys-snapshot das 10:00:09. Os demais runs de fórmula do dia (CINZA, AMARELO BAUDUCCO e outras, OFF WHITE) são cores novas legítimas. **Veredito: ✅ downsize `cloud_compute_small` → `micro` liberado.** A troca de porte é do founder, no painel do Lovable. Hoje a maior leitura de disco é `sales_price_history` (12 MB na janela), não o tint.
- Fica para outra entrega: o conector consultar o hash também com HWM funcional (a correção de verdade), e o 2º evento não atribuído de 13:33 UTC (+557 MB, scan de `idx_tsf_acct_par` lendo a tabela inteira por `account`, perfil compatível com `public._tint_preflight()`, que tem EXECUTE para anon e authenticated).

## 2026-10-29 — micro reprovado, de volta ao small

- **Troca e volta:** o founder trocou para `micro` em 29/10 às 00:25:56 UTC (`shared_buffers` 256MB, `max_connections` 60) e voltou para `cloud_compute_small` às 19:57:15 UTC (`shared_buffers` 512MB, `max_connections` 90). Não houve erro de promoção nem falha de cron no período. A promoção de catálogo seguiu em ~30 s; o `tint-watchdog-fase5-6h` das 06:00 levou 439 s, contra 75–167 s no small.
- **Medido no micro (psql-ro, deltas de `pg_statio_all_tables` com a loja ativa):**
  - janela limpa das 11:16 às 11:26 UTC: o banco leu **1.682 MB** do disco, com cache hit de **94,7%**. As tabelas que mais leram foram `tint_staging_formulas` 579 MB (o total da relação é 320 MB), `tint_sync_runs` 455 MB (9 seq scans dos 87 MB do heap em 10 min), `tint_sync_errors` 306 MB e `tint_receita_versoes` 199 MB;
  - tarefa agendada, das 14:00 às 14:16 UTC: **534 MB** e cache hit de **98,87%**, com `tint_sync_runs` 381 MB.
  - No small, em 28/10, tinham sido 46,7 MB e 99,92%.
- **Lição: medir o I/O no porte atual não prova que o porte menor aguenta.** Os 99,92% do small só mostravam que o conjunto de trabalho cabia em 512 MB. Com metade do cache, ~600 MB do tint passam a ir ao disco a cada promoção de catálogo (~30 por hora) e a cada varredura de `tint_sync_runs`, que não tem índice em `started_at`. Antes de tentar o micro de novo, é preciso encolher esse conjunto: quem varre `tint_sync_runs` e as leituras de staging na promoção de catálogo. Depois, medir com uma janela limpa, sem consultas de diagnóstico no meio: uma consulta por `started_at` relê os 87 MB e suja o delta, como aconteceu na 1ª janela de 5 min desta medição.

## 2026-10-30 — correção do conector (filtro de hash em delta)

- **O que mudou (`connector/sayersync`):** o filtro de hash agora vale também em delta, então a personalizada de `data_atualizacao` máxima deixa de voltar a cada ciclo. A poda do cache acontece no keys-snapshot, nas mesmas chaves que o servidor usa para desativar, e é persistida antes do envio. O cache herdado da 0.2.5 perde os hashes de personalizada na carga (`alinharCacheAoSnapshot`).
- **Codex, 4 rodadas:**
  - P1 do cache v1 herdado;
  - P1 de downgrade ou rollback do `.prev` e volta;
  - P1 de marca vazia com state perdido;
  - na 4ª rodada, **LIBERA**, com 1 P2 aceito: snapshot da 0.2.5 aceito sem avançar o state.
- **Falsificação:** 20 sabotagens, todas vermelhas, com controle verde antes e depois.
- **Lição:** um cache que muda de semântica precisa invalidar o estado que a semântica antiga deixou. Bumpar a versão não basta quando a versão velha pode voltar a rodar (downgrade, rollback automático) e preserva o número da versão nova. A âncora certa é um fato que as duas versões escrevem: o `LastKeysSnapshot` do state.
- **Em prod (psql-ro, 2026-10-31 03:11 UTC):** o 0.2.6 foi publicado pela tela Releases do conector. O sha256 do `.exe` no bucket é `ea2e3096…1c31`, igual ao build. A loja se atualizou na virada do dia UTC (o conector checa o manifesto 1 vez por dia), e o heartbeat das 03:06 já veio com `agent_version = 0.2.6`. O 1º keys-snapshot do código novo saiu entre 03:02 e 03:06. Resultado: zero fórmula desativada em 24h, 1.098 personalizadas ativas, zero promoção em erro, e 90 runs de catálogo contra 0 de fórmula desde 00:08. **Limite da evidência:** o ganho próprio da 0.2.6, que é deixar de fazer o POST, não aparece no banco. A edge v1.2 já respondia ao reenvio idêntico sem abrir run, e a tabela de integração não guarda contagem por ciclo. A prova direta fica no log do conector na loja.

## 2026-10-30 — índices em `tint_sync_runs` (#3419): a promoção para de varrer a tabela

- **Quem varria:** o próprio `tint_promote_sync_run`, com 1 seq scan dos 87 MB por promoção no somatório do cap de limpezas em 24h (`account`, `store_code`, `COALESCE(promovido_em, started_at)`, `metadata ? 'receitas_limpas'`). Não era tela nem cron. A prova veio dos contadores desde o restart das 19:57: o `seq_scan` de `tint_sync_runs` (120) era igual aos scans de `tint_staging_bases`/`_produtos`/`_embalagens` e aos `idx_scan` de `idx_tint_sync_runs_status`, que acontecem uma vez por promoção.
- **Mudança:** `20261029211738_tint_sync_runs_indices_conjunto_trabalho.sql`, aplicada pela sessão via `db:aplicar` (tentativa #770, sha `ac6f49cb…`) e validada por psql-ro. Ela cria três índices (o parcial do cap, `started_at` e `(account, sync_type, started_at)` para as telas) e roda `ANALYZE`. Nenhuma lógica mudou. Na prod, o plano genérico do cap passou a ser Index Scan com 541 buffers, contra as 11.077 páginas da tabela. Prova PG17: `db/test-tint-sync-runs-indices.sh`.
- **Delta no small** (janelas limpas de 15 min, com um amostrador de `pg_stat_activity` para consultas `tint_*` de outras sessões `claude_ro`; ele não pegou nenhuma):

  | | antes (30/10 00:16–00:31 UTC, 5 promoções) | depois (03:42–03:57 UTC, 10 promoções) |
  |---|---|---|
  | `tint_sync_runs` seq scans | 5 | 0 |
  | `tint_sync_runs` lógico | 456 MB (91 MB/promoção) | 89 MB (8,9 MB/promoção) |
  | `tint_staging_skus` lógico | 102 MB (20 MB/promoção) | 206 MB (21 MB/promoção) |
  | `tint_staging_corantes` lógico | 324 MB (65 MB/promoção) | 662 MB (66 MB/promoção) |
  | banco: lido do disco · hit | 513 MB · 96,11% | 5,4 MB · 99,91% |

  Os 513 MB do "antes" foram quase todos (430 MB) **1 seq scan de `tint_formulas`** de origem não identificada. Não veio de cron (`cron.job_run_details` da janela) nem do snapshot de chaves (aplicado 1×/dia às 10:06), e foi o único desde 19:57. Fica como pista, não como causa.
- **O que sobra para o micro** (por promoção, medido): o "último por chave" do staging lê todas as versões retidas, porque cada run de catálogo reenvia o catálogo inteiro (224 SKUs e 57 bases por run, ~2.190 runs em 30 dias). Os números: `skus` ~20 MB, `corantes` ~66 MB (heap de 11 MB relido) e `bases` ~6 MB. Índice não reduz as páginas tocadas. As saídas são reescrever com `LATERAL … LIMIT 1` por chave (money-path: Codex mais falsificação) ou encurtar a retenção do superseded. Também segue em aberto a origem dos 306 MB de `tint_sync_errors` e dos 199 MB de `tint_receita_versoes` lidos no micro: nenhuma função os lê, e eles tiveram 0 scans desde 19:57, então tela ou ANALYZE pós-restart são os suspeitos.
- **Lição: no porte atual, o critério certo é o volume LÓGICO por promoção, não o MB do disco.** No small, o disco fica perto de zero antes e depois porque tudo cabe no cache. O que prevê o micro é quanto cada promoção toca: o heap inteiro de 87 MB contra 541 buffers.

## 2026-10-31 — latest por chave indexado no promote (#3431): o staging deixa de ser relido por promoção

- **Mudança:** `20261030071806_tint_promote_latest_por_chave_indexado.sql`, aplicada pela sessão via `db:aplicar` (tentativa #773, sha `e9915806…`, às 03:10 UTC) logo depois de um ciclo de promoção, e validada por psql-ro (`md5(prosrc)` = `954a9641…`, 7 índices válidos).
  - Os 4 `DISTINCT ON` de produtos, bases, embalagens e corantes viraram `CROSS JOIN LATERAL (… ORDER BY created_at DESC, id DESC LIMIT 1)`, cada um sobre um índice `(account, store_code, chave, created_at DESC, id DESC)`.
  - O de skus virou `EXISTS` sobre `(account, store_code, cod_produto, id_base, id_embalagem)`.
  - Corantes ganhou o índice em `sync_run_id` que faltava: eram 2 seq scans por promoção.
  - O `cor_latest` manteve o texto e passou a usar o parcial `WHERE custo IS NOT NULL AND volume_ml IS NOT NULL`.
- **Por que (a), e não encurtar a retenção:** o Codex apontou que o purge preserva o último por chave **independentemente de custo**, enquanto o `cor_latest` procura o último **com custo**. Encurtar a retenção apagaria o último custo válido de um corante cuja versão mais nova veio sem custo.
- **Prova:** `db/test-tint-promote-latest-indexado.sh`, no núcleo do CI.
  - O template é o corpo de prod. O catálogo promovido sai idêntico, comparado por md5 da chave natural completa.
  - Numa promoção BIG, a leitura de staging cai de 7.924 para 517 blocos no catálogo e de 4.812 para 46 na fórmula, com plano custom e genérico.
  - Roda com 12 falsificações de conjunto exato, nos locales C e pt_BR.
- **Delta no small** (janelas limpas de 15 min, amostrador sem nenhuma consulta `tint_*` de outra sessão):

  | por promoção de catálogo | antes (31/10 02:39–02:54 UTC, 5 promoções) | depois (31/10 03:17–03:33 UTC, 5 promoções) |
  |---|---|---|
  | `tint_staging_corantes` | 71,8 MB | 0,7 MB |
  | `tint_staging_skus` | 21,6 MB | 5,3 MB |
  | `tint_staging_bases` | 7,1 MB | 1,3 MB |
  | `tint_staging_produtos` + `_embalagens` | 2,7 MB | 0,6 MB |
  | **staging total** | **~103 MB** | **~8,1 MB** |
  | banco: disco · hit · temp (janela) | 2,5 MB · 99,99% · 42 MB | 4,0 MB · 99,92% · 8 MB |

- **O que sobra:** o 1º ciclo sob o corpo novo (03:15) fechou com 5 runs `complete`, 0 erros e o oficial íntegro (21/57/4/26/224). No staging, `skus` passou a ser o maior item, com 5 MB por promoção: o `EXISTS` faz 224 buscas no índice (o heap não é mais lido). Fora do staging, o maior item tint por promoção passa a ser `tint_sync_runs`, com ~11 MB lógicos (515 idx scans na janela, igual antes e depois).
- **Lição:** uma medida de custo dentro de uma prova precisa ser fail-closed como qualquer assert. Uma promoção que aborta cedo lê ~0 blocos e passa em qualquer teto. O `blocos()` só devolve número quando o promote retornou `ok=true` **e** o efeito do run medido aparece no oficial (parecer Codex). Quando ele entrou, a F3 (corantes pegam a versão mais velha) passou a cair também na leitura, porque a descrição do run não aparece.

### `tint_sync_errors` e `tint_receita_versoes` saem da lista do Mini (medido 31/10 02:32 UTC pela sessão-mãe)

- Pelo `pg_stat_user_tables` (PG17: `last_seq_scan`/`last_idx_scan`), desde o restart de 29/10 19:57 UTC:
  - `tint_sync_errors` (110 MB) teve 2 seq scans, o último em 30/10 10:09:38, e 0 idx scans;
  - `tint_receita_versoes` (66 MB) teve 1 seq scan e 288 idx scans, os últimos também às 10:09:38.
  - O mesmo segundo nas duas indica uma sessão de diagnóstico. Depois disso não houve **nenhuma** leitura até 31/10 02:30, cerca de 10 h de loja.
- Nenhuma função lê `tint_sync_errors`: o promote e os ticks só fazem INSERT. A FK com cascade para `tint_sync_runs` tem índice. O único leitor recorrente de `tint_receita_versoes` é o cron diário das 05:03 UTC, que roda em 3 a 11 s.
- Os 306 + 199 MB lidos no micro em 29/10 foram diagnóstico daquele dia, não carga de produção. ~~Para o Mini, o staging "último por chave" era o único item restante; esta entrega o resolve.~~ **Errado** (medido no Mini em 31/10, subseção abaixo): o staging já não lê nada, e o banco reprova por leitores fora dele. Um deles é justamente `tint_sync_errors`, que passou a ser lido às 12:34 UTC, 10 h depois desta medida (#3441).

## 2026-10-31 — Mini: quem lê fora do staging (diagnóstico, nada corrigido ainda)

O founder trocou para o Mini (`shared_buffers` 256MB, `max_connections` 60) às 10:33:02 UTC. Critério: ≤400 MB do disco por 15 min, hit ≥99%, temp ≤100 MB, conexões ≤80%.

- **Medido (psql-ro):**
  - janela das 18:10:30 às 18:25:54 UTC (sessão-mãe): **589,5 MB**, hit 99,56%, **temp 237,6 MB**, 45/60 conexões;
  - série de 30 s das 18:29:47 às 19:01:42 UTC:
    - 1ª metade (18:29–18:44): **~266 MB** reais (390 MB, menos 124 MB de duas consultas minhas, às 18:31 e às 18:33), hit **99,23%**, temp 25 MB, ≤34 conexões. **Passa**;
    - 2ª metade (18:45–19:01): **1.957 MB**, hit **97,95%**, temp 109 MB. **Reprova**;
  - acumulado desde o restart (7,9 h, até 18:30): **26,6 GB** do disco, ~840 MB por 15 min em média.
- **Atribuição sem texto de query:** o `claude_ro` não tem `pg_read_all_stats` (`pg_stat_activity.query`/`state` vêm nulos para outros usuários), então o amostrador por texto não atribui nada. A atribuição foi por **série temporal**: `pg_statio_all_tables` + `pg_stat_all_tables` a cada 30 s, cruzados com `cron.job_run_details`, `gh run list` e o grep do repo.

| # | leitor | medida | proposta (quem faz) |
|---|---|---|---|
| 1 | **cron `tint-watchdog-fase5-6h`** (`tint_watchdog_fase5_check`, 00/06/12/18 UTC). O S1 junta `v_tint_formula_canonica`, que é correlacionada por fórmula (2 subconsultas em `tint_formula_itens` + LATERAL no grupo da chave), com as 464 mil chaves carimbadas | **~8 GB por execução**: `tint_formula_itens` 8,7 GB + `tint_formulas` 7,6 GB nas 2 execuções do Mini, de 26,6 GB no total. Duração: 86–154 s no small, 403–503 s no micro (29/10), **581 s** às 12:00 e **timeout de 600 s** às 18:00. A janela da sessão-mãe começou 29 s depois do cancelamento | **Antes de tudo, o sensor:** se a execução das 00:00 também falhar, o dead-man de 13 h do `tint_watchdog_corante_check` dispara ~01:10 UTC de 01/11. Imediato: tirar as execuções das 12h e 18h UTC do horário de loja, junto com o dead-man (migration, sessão via `db:aplicar`). Definitivo: o S1 em agregação única set-based (1 passada em `tint_formula_itens`), ou `receita_valida` em coluna dedicada com 1 escritor. É oráculo de preço do balcão, então passa por money-path + Codex |
| 2 | **badge do AppShell `useTintAlertas`** (#3441) e card do `TintDashboard` (`useFormulasRejeitadas`, mesma query). Embed `tint_sync_runs!inner(...)` filtrado na tabela embutida | No plano **genérico** (`PREPARE` + `force_generic_plan`), é seq scan dos 110 MB de `tint_sync_errors` + 1 probe no PK de `tint_sync_runs` por run distinto (5.173): 2 polls ≈ 10.346, contra **10.481 idx scans** medidos. Série: 3 polls (18:34:40, 18:54:17, 19:01:05), ~110 MB + ~32 MB cada. Desde 10:59 só há seq scans (0 idx). **Cresce com a adoção do build**: é 1 poll a cada 5 min por aba de staff visível | Ler `tint_sync_errors` com `.in('sync_run_id', ids)`, usando os ids que a função já busca em `runs`, sem embed. Vai pelo `idx_tint_sync_errors_run` (front, PR + Publish). Depois, retenção de `tint_sync_errors` (91 mil linhas desde 12/06) |
| 3 | **Dashboard `useTintometricoZone`** (poll de 5 min + realtime em `tint_importacoes`) e `TintDashboard.tsx:31` | 2 seq scans dos 21 MB por refresh: não há índice em `created_at` (114 mil linhas) | Índice `(account, created_at DESC)`, aditivo (sessão via `db:aplicar`) |
| 4 | **tela `/radar`** (`radar_kpis`, `radar_contagem_por_municipio`, contagens `count: 'exact'`, busca `ilike` sem trigram) — provável: nenhum cron, workflow (`radar-carga-mensal` rodou 02:08–04:34) ou edge no minuto | **18:56:43–18:57:48: 4 seq scans em paralelo, 1,43 GB do disco + 64 MB de temp**, num heap de 731 MB. Antes: 7 seq scans em 7,9 h (4,3 GB) | Contagens do Radar pré-computadas por lote (o universo muda 1 vez por mês com a carga, e o score 1 vez por dia), mais `pg_trgm` na busca (migration + front) |
| 5 | tela de Venda (`venda_painel`/`venda_gerar_lista`) | 18:34:08: 103 MB (`venda_sugestao` 61 MB em seq, `order_items`, `sales_orders`) | Sob demanda e abaixo do teto sozinha. Fica para depois do 1–4 |
| 6 | telas do financeiro (`fin_movimentacoes`/`fin_contas_receber` em seq) | 18:37 e 18:44–18:47: 63 MB do disco + 44 MB de temp | Idem |

- **Temp:** na série, 150 MB em 32 min (Radar 64 · financeiro 44 · resto difuso), ou ~70 MB por 15 min. Os 237,6 MB da janela das 18:10 **ficam sem atribuição**: o fase5 já tinha sido cancelado às 18:10:01.
- **No cache, mas acima do resto:** `sales_orders` teve 429 seq scans em 32 min (8,3 GB lógicos, ~1 a cada 4,5 s) e `fin_contas_receber` 7,4 GB lógicos. Quase não leram do disco, mas disputam os 256 MB. Vale identificar o poll antes de cortar mais RAM.
- **Veredito:** sem o fase5 em horário de loja, sem o badge e sem uma abertura do Radar, o Mini passa (1ª metade da série). Hoje ele reprova em toda janela com o fase5 (12h/18h UTC), com o Radar aberto, e cada vez mais com o badge. A volta para o small é decisão do founder. O argumento de urgência é o item 1: no Mini, o próprio sensor do fase5 está estourando o timeout.
- **Lição: uma janela de 15 min não vê leitor de cadência longa.** O fase5 terminou 29 s antes do T0, e a janela concluiu "~310 MB fora do tint" sem ver os ~8 GB de 10 min antes. Quem acha a cadência longa é a duração por job em `cron.job_run_details` desde o restart; o delta curto só acha a curta.
- **Lição: o mesmo SELECT do PostgREST tem dois planos.** Com literal, o embed desce pelo índice dos runs; no plano genérico, varre a tabela-mãe. O `EXPLAIN` que vale é `PREPARE` + `SET plan_cache_mode = force_generic_plan`, nunca só com o literal.

### 2026-11-01 — leitor 1 corrigido: watchdog Fase 5 v5 em passada única

- **Onde estavam os 8,1 GB** (`EXPLAIN (ANALYZE, BUFFERS)` do statement da v4 em prod, 04:38 UTC, 620 s):
  - 4,7 GB no oráculo do S1. O planner achatou `v_tint_formula_canonica WHERE receita_valida` num filtro `EXISTS`/`NOT EXISTS` por fórmula, sobre as 493 mil ativas em ordem aleatória, com 481 mil heap fetches: o visibility map de `tint_formula_itens` estava em 49,6%, e o índice usado (272 MB) não cabe nos 256 MB de `shared_buffers`;
  - 2,4 GB no `IN` do universo `k` (Index Scan da tabela inteira).
- **v5** (`20261101050000`, prova `db/test-tint-fase5-watchdog-v5.sh`, no núcleo do CI):
  - `k` por `GROUP BY … HAVING bool_or(motivo fase5)`;
  - oráculo `receita_ok`/`v_ok` numa passada. É equivalente porque a canônica da chave é a de menor `rank_pref`, e `rank_pref <= 1` é exatamente `receita_valida`;
  - config da função `enable_indexscan`/`enable_indexonlyscan = off` + `work_mem = 16MB`;
  - guard em runtime: o md5 do `pg_get_viewdef` da view revisada. Se a view mudar, a função aborta sem marcador, e quem alarma é o dead-man.

  | mesmo SELECT em prod | tempo | disco | temp |
  |---|---|---|---|
  | v4 | 620 s | 8,1 GB | ~200 MB |
  | v5 sem a config | 220 s | 3,5 GB | 698 MB |
  | v5 (com a config) | **18 s** | **1,14 GB** em seq scan (ring buffer, não expulsa o cache) | 365 MB |

- **Equivalência nos dados de prod** (04:50–04:59 UTC, uma fotografia): oráculo 493.064 = 493.064 chaves, universo 463.995 = 463.995, zero diferença nos dois sentidos; S1 0 = 0.
- **Prova:**
  - roda a suíte da v4 contra a v5, mais uma fixture de 600 chaves com os 9 estados de corante. Os CTEs são extraídos do texto da migration e comparados com a view real;
  - mede S1 nas três exposições (metadata, série, alerta), o limiar 999/1000 e o guard da view;
  - 47 asserts; `--falsificar` com 39 sabotagens de conjunto exato, nos locales C e pt_BR.
- **Codex** (gpt-6-astra max, 301 s): LIBERA COM AJUSTES, sem P0/P1. A equivalência foi re-derivada por ele. Os P2 foram aplicados antes do apply:
  - P9 insensível a caixa;
  - P10 com comando, cadência e unicidade;
  - P11 `IS NOT TRUE` (`proconfig` NULL);
  - S1 nas 3 exposições e no limiar;
  - fingerprint da view na PRE e em runtime, helper v2 na PRE.
- **Aplicada** pela sessão via `db:aplicar` (tentativa #838, sha `4ab0399c…`), depois de 2 ensaios em prod. Validada por psql-ro: corpo v5, config, definer, ACL e cron intactos.
- **Em prod:** a 1ª execução sob a v5 (cron das 06:00 UTC de 01/11) levou **53,8 s**, contra 575,7 s às 00:00 e 581 s/timeout em 31/10. Os números saíram idênticos aos da última v4: universo 463.995, S1 0, bruto 12.682, S2 0, fantasmas 0, cor nova 0.
- **Fica em aberto:** o pico de memória da chamada inteira no Mini. O `claude_ro` não vê a memória dos processos, e o que mediu foi ≤ 33 MB por nó no `EXPLAIN`. A duração vem na série `tint_watchdog_fase5_amostras.duracao_s`.
- **Lição: medir o plano é o que separa o conserto do palpite.** O primeiro corte (só reescrever os CTEs) ainda lia 3,5 GB, porque o planner estimou 50 mil grupos onde havia 464 mil e voltou a percorrer a tabela pelo índice. Só o `EXPLAIN ANALYZE` da versão nova mostrou isso.
- **Lição: a 1ª falsificação achou a fixture cega.** No pool, o corante de volume NULL só aparecia ao lado de outro corante ruim, e o `bool_and` ignora NULL. Então a sabotagem que tirava o `IS NOT NULL` ficava verde. Cada estado ruim precisa aparecer também ao lado de corantes só bons.

### 2026-11-01 — leitor 2 corrigido: badge `useTintAlertas` lê os erros pelos runs da janela

- **Mudança (só front):** em `lerFormulasRejeitadas`, a 2ª leitura saiu do embed `tint_sync_runs!inner(account, sync_type, started_at)` filtrado. Agora lê `tint_sync_errors` com `.in('sync_run_id', ids)`, usando os ids dos runs da janela de 24h que a função já busca. Continuam `fetchAllPages` e a ordem (`created_at desc`, `id`). Sem run na janela, não consulta (`.in()` vazio não é filtro). `LinhaDeErro`/`agruparPorCor` não usavam campo do embed. O badge e o card seguem com a mesma query/queryKey (#3441). De quebra, `rejeicoesNaJanela` e `cores` passam a sair do MESMO conjunto de runs.
- **Plano genérico em prod** (psql-ro, 01/11 ~12:05 UTC; `PREPARE` + `plan_cache_mode = force_generic_plan`, forma que o PostgREST gera; o EXPLAIN com literal esconde o seq scan):

  | query | plano | buffers | disco | tempo |
  |---|---|---|---|---|
  | antiga (embed) | Parallel Seq Scan em `tint_sync_errors` (90.995 linhas) + Memoize/PK de `tint_sync_runs` (6.491 probes) | 40.102 | 14.057 (≈ 110 MB) | 629 ms |
  | nova, janela de hoje (6 runs) | Index Scan `idx_tint_sync_errors_run` | 13 | 7 | 8,7 ms |
  | nova, 150 runs (porte típico de 24h, ciclo ~11 min) | Index Scan `idx_tint_sync_errors_run` | 211 | 114 (≈ 0,9 MB) | 141 ms |

- **Prova no repo:** `src/hooks/__tests__/useTintAlertas.leitura-por-run.test.tsx` trava o `.in('sync_run_id', <ids>)`, a ausência do embed e a não-consulta sem runs. Falsificado: com o embed de volta e sem o guard de vazio, os 2 casos ficam vermelhos.
- **Linha de base para o pós-Publish** (12:09 UTC): `pg_stat_all_tables` de `tint_sync_errors` com `seq_scan = 69`, `idx_scan = 941` e `last_seq_scan` 12:07:29 UTC (o badge polando). Merge ≠ produção: o efeito só aparece depois do **Publish** no Lovable e conforme as abas trocam de build (o SW só troca quando o cliente clica). Sinal de pronto: `seq_scan` para de subir e `last_seq_scan` congela, enquanto `idx_scan` sobe.
- **Em prod (conferido 03/11 00:37 UTC, psql-ro):** PR #3485 mergeado em 01/11 às 13:10 UTC, com Publish feito. `seq_scan` 69 → 81 e `last_seq_scan` **congelado em 02/11 09:21 UTC** (~15 h sem nenhum, contra 1 por poll antes). Os 12 a mais são das abas que ainda tinham o build velho até trocar. `idx_scan` 941 → 259.663, pela query nova em `idx_tint_sync_errors_run`. Leitor 2 resolvido.

### 2026-11-03 — leitor 4 corrigido: `/radar` conta pelo agregado, não pelos 731 MB de `radar_empresas`

- **Atribuição (psql-ro, 03/11 ~09:30 UTC; EXPLAIN com `PREPARE` + `force_generic_plan` e com literal, sem executar).** A abertura default do `/radar` disparava **4 seq scans** de `radar_empresas` (731 MB, 573 mil linhas, 88% no lote vigente `2026-10`). Batem com os 4 em paralelo de 31/10 18:56 (1,43 GB do disco + 64 MB de temp):

  | # | consulta (call-site) | plano antes |
  |---|---|---|
  | 1 | RPC `radar_kpis` → `count(*) … prospeccao_status = 'a_contatar' AND ja_cliente = false AND ultimo_lote = v_lote` (`useRadarKpis`) | Parallel Seq Scan |
  | 2 | RPC `radar_contagem_por_municipio`, caminho com lote/região/contato, o default da tela (`RadarRankingCidades`, `RadarMapa`) | Parallel Seq Scan + Sort (o temp) |
  | 3 | RPC `radar_penetracao_por_municipio`, CTE `mercado` (`useRadarPenetracaoMunicipios`) | Parallel Seq Scan |
  | 4 | `count: 'exact'` de inéditos, `ultimo_lote = lote AND primeira_vista_em >= iniciado_em` (`useRadarIneditos`) | com literal: Parallel Seq Scan (sem índice em `primeira_vista_em`) |

  Não leem a tabela inteira: a lista default (anda `idx_radar_lista_score`), o count de sugeridos (`idx_radar_empresas_fila` com `em_conversa`), `em_conversa`/`virou_cliente` dos KPIs (índice). **No uso:** a busca com termo raro (`razao_social ILIKE '%t%' OR nome_fantasia ILIKE '%t%'`) cai em Parallel Seq Scan. O município clicado no ranking (`municipio_nome ILIKE`) anda o índice de score inteiro quando a cidade é pequena.
- **Os seq scans fora de loja:** o das **06:30 UTC** é o cron `radar_score_recalcular` (`cron.job_run_details` 06:30:00–06:30:21.87; `last_seq_scan` 06:30:21.85). É o escritor diário e lê a tabela por desenho. O das **00:38 UTC** de 03/11 coincide com a medição da amostra do Radar por psql-ro de outra sessão (21:37 BRT, última atividade 00:38:47): medição de agente, não uso. Dois às **09:28:18 UTC** de 03/11 (uma consulta paralela) ficaram sem atribuição. Não foram meus: `TABLESAMPLE` não move `seq_scan`, medido.
- **Mudança (migrations `20261103100000_radar_agregado_municipio` e `20261103100100_radar_busca_trgm`, aplicadas por `bun run db:aplicar`):**
  - `radar_agregado_municipio` (contagens por lote × município × status × já-cliente × telefone × contato × inédito) + `radar_agregado_estado` (identidade do lote-base: `mes_referencia` + `iniciado_em`). RLS ligada, sem policy, sem GRANT. **21.665 grupos, 1,8 MB.**
  - 1 escritor, `radar_agregado_recalcular()`, pelo cron `radar-agregado-recalcular` (`35 * * * *`). Ele recalcula quando o lote vigente muda (≤1 h depois da carga) ou uma vez por dia depois das 06:35 UTC (depois de situação, recruzamento e score). Fora disso sai sem ler a tabela (0 scans, medido em `pg_stat_xact_user_tables` na prova).
  - As 3 RPCs leem o agregado. Agregado de outro lote = **indisponível**: `a_contatar` NULL nos KPIs, `RAISE 'agregado indisponível'` na contagem/penetração, nunca 0. CNAE, data de abertura (preset "estabelecidas") e inéditos de outro lote seguem na consulta viva de antes.
  - Índice `idx_radar_empresas_lote_vista (ultimo_lote, primeira_vista_em)`, 4,2 MB: o count de inéditos vira **Index Only Scan** (custo 1.215 contra ~98.500).
  - GIN `pg_trgm` `idx_radar_empresas_busca_trgm` em `razao_social`/`nome_fantasia`/`municipio_nome` (94 MB, apply 10:11:57–10:12:39 UTC). A postcondição exige que a busca rara e o município USEM o índice (EXPLAIN dentro do `DO`). Em prod: cidade pequena (`BRAZOPOLIS`) → Bitmap Index Scan no trigrama; termo comum (`marcenaria`, ~5 mil) segue no índice de score, que acha 50 cedo. **Errado para o app (corrigido na parte 3, abaixo):** a postcondição rodou como dono e o EXPLAIN como `claude_ro` (`rolbypassrls`), os dois fora do RLS. Para `authenticated` a busca seguiu em seq scan.
- **Prova:** `db/test-radar-agregado.sh` (núcleo, 50 asserts nos locales `C` e `pt_BR.UTF-8`). Equivalência com o corpo vivo de prod em 17 contagens, 4 penetrações e nos KPIs; lote novo indisponível; escritor que não lê; RLS/ACL; cron; PRE. `--falsificar`: controle verde + 17/17 sabotagens vermelhas no assert declarado.
- **2ª testemunha (psql-ro, 03/11 ~10:06 UTC, depois do apply de 10:01–10:04):** md5 das 3 RPCs = arquivo; estado `2026-10`/`2026-10-27 16:20:37.722+00`, 573.021 empresas; agregado = tabela viva em 3 municípios lidos pelo índice (`4123` 6.511, `7107` 25.008, `0255` 2.666); cron ativo como `postgres`; as 2 tabelas com RLS e sem SELECT para `anon`/`authenticated`. Os 2 seq scans de 10:04:47 são o próprio apply (cálculo inicial + índice) e o de 10:12:39 é a construção do GIN.
- **Front (PR deste leitor):** o card "A contatar" mostra "indisponível" no NULL e "contagem de dd/mm hh:mm" no hint. Ranking, mapa e roteirizador deixam de transformar erro em "0 empresas · nenhuma cidade". Esse defeito era anterior e ficaria visível na janela de indisponível.
- **Linha de base para o pós-Publish:** `radar_empresas` com `seq_scan = 49` e `last_seq_scan` 10:12:39 UTC (03/11). As RPCs já leem o agregado sem Publish, porque o banco mudou e o front velho chama as mesmas RPCs. O count de inéditos já usa o índice. O que depende do Publish é só a tela de indisponível. **Sinal de pronto:** com o `/radar` aberto, `seq_scan` só sobe às 06:30 (score) e às 06:35 (agregado, 1×/dia). **Pendente medido:** CNAE e "estabelecidas" no ranking continuam lendo a tabela quando o usuário aplica esses filtros (21 CNAEs; incluí-los multiplicaria o grão lido em toda abertura). O `idx_radar_muni_cover` (150 MB) perdeu o único leitor (o caminho rápido da contagem, que hoje vai ao agregado). Dropá-lo é DDL destrutivo e fica com o founder, depois de 1 semana com `idx_scan` parado.
- **Pós-Publish, com a tela em uso (03/11 13:03 UTC):** a abertura ficou limpa. KPIs (`idx_radar_empresas_fila`), lista sem termo (`idx_radar_lista_score`, 21), inéditos (`idx_radar_empresas_lote_vista`, 6), sugeridos, ranking (agregado, 10 chamadas) e irmãos (`idx_radar_empresas_raiz`) não leram a tabela. **A busca, não:** `seq_scan` 49 → 71 (a outra sessão mediu 73 às 13:06 e 6,4 GB lidos de `radar_empresas` entre 12:58 e 13:06, 15× o teto do Mini). `idx_radar_empresas_busca_trgm` com 0 leituras.
- **Causa:** `radar_empresas` tem RLS (`radar_empresas_select_gestor`) e o operador do ILIKE (`texticlike`) não é LEAKPROOF. Sob RLS, o planejador não aceita qual não-leakproof como condição de índice (ela não pode rodar antes da policy). Para `authenticated`, toda busca por razão/fantasia ou município vira Parallel Seq Scan. Reproduzido em PG17: dono → Bitmap Index Scan no trigrama; `SET ROLE authenticated` → `Seq Scan`. **Lição:** plano de leitura do app se mede no papel do app; `claude_ro` e o dono ignoram RLS e aprovam o que o app nunca recebe.
- **Parte 3 (migration `20261103131500_radar_lista_rpc`):** a lista inteira (`useRadarLista`) passa pela RPC SECURITY DEFINER `radar_lista`, com o gate da policy (`cap_radar_prospectar`) e os recortes do hook um a um. SQL dinâmico com `USING`: cada chamada é planejada com os valores, e só entram os predicados pedidos. O termo usa `private.padrao_like_contem` (curinga literal). Prova `db/test-radar-lista-rpc.sh`, toda sob `SET ROLE authenticated`: 19 recortes iguais à consulta de antes sob RLS; o controle reproduz o seq scan; busca e município pela RPC leem o trigrama com 0 seq scan; gate/ACL; entrada mal formada `22023`; PRE. 34 asserts em `C` e `pt_BR.UTF-8`, `--falsificar` 15/15.
- **Apply e 2ª testemunha (03/11 ~13:57 UTC):** `bun run db:aplicar`, tentativa #881, depois do `--ensaio` verde. Pelo psql-ro: md5 do corpo = arquivo (`3da72da3…`), SECURITY DEFINER STABLE, dono `postgres` (bypassrls), `anon` sem EXECUTE, `authenticated` com, PUBLIC fora do ACL. **Linha de base para o pós-Publish:** `seq_scan = 74`, `last_seq_scan` 13:10:16 UTC; `idx_radar_empresas_busca_trgm` com 0 leituras. **Sinal de pronto:** uma busca no `/radar` depois do Publish sobe o `idx_scan` do trigrama e não move o `seq_scan`.
- **Medida pós-Publish (03/11 17:16 UTC, psql-ro, `exit 0`):** merge do #3559 às 14:44; o founder publicou, recarregou e buscou. `radar_empresas` seguiu com `seq_scan = 74` e `last_seq_scan` 13:10:16 UTC (congelado), enquanto `idx_radar_empresas_busca_trgm` foi de 0 para **16** leituras (última 17:13:39), junto com `idx_radar_lista_score`, `idx_radar_empresas_local` e `idx_radar_empresas_raiz` subindo no mesmo minuto. **Sinal de pronto atingido:** abrir, filtrar e buscar no `/radar` não leem mais a tabela inteira. Resta o 1º recálculo diário do agregado (04/11 06:35 UTC) e os pendentes já medidos (CNAE/"estabelecidas" no ranking; drop do `idx_radar_muni_cover` com o founder).

## 2026-11-03 — a promoção de fórmulas escreve só o que mudou (migration `20261103093424`)

- **O que reprovou o Mini em 02/11:** o run `dc93c806` (formulas, OBEN/M01) tinha **606 stagings = 275 chaves em 44 pares** (cod_produto, id_base), todas personalizadas. Comparadas com a versão anterior da mesma chave (psql-ro, 03/11): **599 idênticas**, 2 chaves novas, 1 header e 4 receitas mudaram. Mas a promoção reexpande o PAR inteiro (todas as cores × embalagens, ~28 mil fórmulas por par nos 16 maiores), e para cada chave fazia upsert com `DO UPDATE` incondicional (`updated_at`, `importacao_id`) e `DELETE` + re-`INSERT` de toda a receita. Resultado: **408.470 updates em `tint_formulas` e 1.504.224 deletes + 1.504.240 inserts em `tint_formula_itens`** (`pg_stat_user_tables` desde o reset de 31/10 10:33, única promoção de fórmulas no intervalo), 14 min 59 s, **11.693 MB lidos do disco em 15 min** (hit 96,87%, temp 1.188 MB; `tint_formula_itens` 7.001 MB, `tint_formulas` 3.692 MB). Runs de 16 stagings reescreviam 130–140 mil fórmulas (26/10–30/10).
- **A correção:** antes do upsert, sai de `_expand_uniq` (tabela `_pulados`) a chave cujo oficial já é o que seria gravado — header (ativo, nome, sku, volume, preço com o mesmo `COALESCE`, personalizada; numeric pelo TEXTO) e receita (mesmo `DISTINCT ON`, desempate, predicado de dose e arredondamento do `INSERT`) — **e** é mais novo que a staging vencedora (`updated_at` e `created_at` de todo item: a prova que o `formula-identica.ts` da edge usa para descartar reenvio idêntico). O resto segue o caminho antigo verbatim. O E4 exclui o que foi aceito NESTA invocação (`_promoted` ∪ `_pulados`), e o promote ganhou advisory lock por account. Detalhe dos invariantes → `docs/agent/tintometrico.md`.
- **Prova:** `db/test-tint-promote-diff.sh`, verde em `C` e `pt_BR.UTF-8` (10 asserts + 16 falsificações com conjunto exato). O estado do par é comparado com o promote ANTIGO **depois de cada um dos 17 runs** do cenário. Run BIG (2 cores reenviadas num par de 4.000 fórmulas/12.000 itens): **56 tuplas escritas contra 28.000**.
- **Codex** (`max`): 1ª rodada REPROVAR (529 s, 181.917 tokens) — P1: o E4 excluía por `importacao_id = run`, e a chave pulada guarda o do último run que a REESCREVEU; re-promover esse run deixava de recalcular o preço. P2: duas lojas da mesma account em paralelo classificavam `_pulados` sem trava. Os dois corrigidos (E4 por invocação, lock por account) com cenário e falsificação (F15, F16). 2ª rodada APROVAR COM AJUSTES (354 s, 142.340 tokens): pediu a prova do desvio deliberado (assert `DESVIO`, feita) e apontou um P2 residual, documentado e não tratado: `tint_apply_keys_snapshot` toma só o lock de loja; só alcançável fora do `tint_promocao_tick`, que é o único chamador dos dois e é serial.
- **Desvio deliberado:** re-promover um run JÁ promovido, sem outro run ter reaceitado a chave no meio, agora recalcula pelo E4 a chave que a 1ª invocação gravou (antes ficava com o preço da 1ª invocação porque o `importacao_id` reaproveitado coincidia). É a intenção escrita no próprio E4 ("já saiu com o preço novo" = nesta invocação).
- **Aplicada em 2026-11-03 ~10:26 UTC** pelo `db:aplicar` (ensaio ok → recibo #879), fora de promoção (fila vazia, contadores de `tint_formulas` parados). Validada por fora (psql-ro): md5 do corpo `2c6f461f9c9d4f8c54ea817e25f88f61`, `_pulados` e lock por account presentes, exclusão por `importacao_id` ausente, `proconfig` e ACL preservados.
- **Lição: comparar só o estado FINAL deixou 2 camadas verdes por engano.** O preço que o diff deixava velho era "curado" pelo E4 de um run seguinte, e a desativação pelo reenvio seguinte. Fotografar o estado depois de cada run tornou as duas falsificações vermelhas. E chave com staging nova é sempre reescrita (frescor), então a comparação de valores só é alcançável pelo que muda FORA da staging da chave (volume de embalagem, preço de base, desativação, edição de staff/legado no oficial) — o cenário precisa de cada um desses.
- **Medida depois (03/11, psql-ro, só `pg_stat_*` a cada 10 s, nenhuma leitura de tabela `tint_*` durante a janela):** o 1º run de fórmulas pós-apply foi o `cefea03a` (1 staging, ingerido 13:03:36, promovido 13:04:35 UTC). A promoção reexpandiu o par e aceitou **1.028 chaves**: **1.024 puladas** (`formulas_identicas_puladas`) e 4 reescritas (as embalagens da chave da staging nova, que o frescor obriga a reescrever). Os contadores mudaram só no commit (13:04:28→13:04:38):

  | | antes (run de 02/11, 606 stagings) | depois (run de 03/11, 1 staging) | o corpo antigo, neste mesmo run |
  |---|---|---|---|
  | chaves aceitas (`inserts`) | 408.470 | 1.028 | 1.028 |
  | `tint_formulas` escritas (upd) | 408.470 | **4** | 1.028 |
  | `tint_formula_itens` apagados + inseridos | 1.504.224 + 1.504.240 | **12 + 12** | ~3.084 + ~3.084 (3 itens/fórmula) |
  | blocos lidos do disco nas 2 tabelas oficiais (heap + índice) | 10,7 GB na janela de 15 min | **3.056 (23,9 MB)** | — |
  | blocos lógicos (hit + read) nas 2 tabelas | — | 14.946 (117 MB) | — |
  | WAL do banco na janela de 10 s do commit | — | 1,0 MB | — |

  O banco inteiro leu 18.339 blocos (143 MB) nos 10 s do commit, mas esse número inclui o resto da carga daquele intervalo. Limite da medida: é um run pequeno; a classe que reprovou o Mini (centenas de stagings em dezenas de pares) ainda não passou pelo corpo novo. Nela a escrita cai do mesmo jeito, mas a LEITURA das fórmulas do par para comparar continua: ~1 GB nas duas tabelas por promoção grande (estimativa; o item abaixo mediu mais). Ao contrário da escrita, essa leitura não suja páginas, mas expulsa o cache: o que ela traz para os 256 MB de `shared_buffers` derruba o resto.
- **Medida do 1º run médio (03/11, psql-ro, `pg_stat_*`):** o `9fdaaee4` (24 stagings, ingerido 13:24, promovido 13:29:03 UTC) aceitou **140.864 chaves e pulou todas** (`formulas_identicas_puladas` = 140.864, `recalculadas` = 0). Delta de 13:07:58 a 16:31:19, uma janela em que ele foi o único run de fórmulas:

  | | `tint_formulas` | `tint_formula_itens` |
  |---|---|---|
  | escritas | 64 ins + 32 upd | 276 ins + 84 del |
  | lido do disco: heap | 78.040 blocos (610 MB) | 107.137 (837 MB) |
  | lido do disco: índice | 12.293 (96 MB) | 108.198 (845 MB) |
  | tamanho atual (heap / índices) | 430 / 563 MB | 571 / 592 MB |

  O corpo antigo reescreveria ~141 mil fórmulas e ~420 mil itens apagados mais ~420 mil inseridos. O corpo novo escreveu 96 fórmulas e 360 itens. A **leitura** das duas tabelas, porém, somou **305.668 blocos (~2,4 GB)**, mais que o tamanho delas (~2,2 GB). Comparar 140 mil chaves espalhadas varre as tabelas quase inteiras, e o que os 256 MB de cache despejam no meio é lido de novo.

  A atribuição foi confirmada por controle: de 16:32:40 a 16:42:40 só rodaram promoções de catálogo, e as duas tabelas leram **0 blocos do disco** (2.640 + 363 hits). O banco inteiro leu 119 MB nessa janela.

  **Veredito:** a escrita acabou, mas a leitura de comparação de um run de 24 stagings é ~6× o teto de 400 MB/15 min do Mini. A causa é o volume que a reexpansão por par aceita (140 mil chaves para 24 stagings), e não o diff. Os 3 caminhos possíveis são de outra entrega:
  - comparar sem ler os itens, com uma assinatura da receita e um carimbo de frescor no próprio cabeçalho (1 escritor: o promote). Isso corta os ~1,7 GB de `tint_formula_itens`;
  - não reexpandir chave cuja entrada não mudou. Isso toca a granularidade por par (#3333/#3355) e é decisão de produto;
  - aceitar o pico, porque runs de fórmula são ~2 por dia.

  **Decisão do founder (03/11): aceitar o pico.** O Codex (`max`, 391 s, 126.025 tokens) REPROVOU o desenho da assinatura no cabeçalho (colunas de assinatura da receita mantidas por trigger nos itens + índice de cobertura por par + backfill por cron), com 6 P1:
  1. o trigger agrega os itens antes de travar o cabeçalho, e duas edições concorrentes gravam assinatura velha. É falso "igual", o mesmo erro que o diff evita;
  2. a RLS "Staff can manage" (FOR ALL) deixa staff gravar as colunas derivadas, e o grant de coluna não neutraliza o grant da tabela;
  3. o backfill bate no guard do tombstone da fase 5 (42501);
  4. `TRUNCATE` não dispara trigger de DELETE;
  5. o índice de expressão `COALESCE(subcolecao_id, …)` pode impedir o index-only scan no PG17;
  6. `ADD COLUMN` + `CREATE INDEX` na mesma transação segura o ACCESS EXCLUSIVE e bloqueia a leitura do balcão.

  Corrigido, o desenho vira ~3 migrations em janelas separadas, uma proteção efetiva das colunas, um backfill com cursor durável e um ensaio de concorrência em PG17. É desproporcional para 2 janelas por dia acima do teto, num Mini que passa folgado nas demais (16,7 MB na janela aprovada).

  **Reabrir se** o pico passar a doer: hit caindo, balcão lento na janela de um run de fórmulas, ou runs grandes ficando frequentes. A lista de P1 acima é o ponto de partida.

  **Reaberto pelo founder no mesmo dia (03/11):** ele pediu para resolver o desenho corrigido e o P2 residual. O P2 saiu primeiro (item abaixo); a assinatura no cabeçalho segue em outra entrega.

- **P2 residual fechado (migration `20261103222838_tint_apply_keys_snapshot_lock_por_account.sql`):** o `tint_apply_keys_snapshot` desativa fórmulas ativas da account inteira, mas só tomava o lock de loja. Agora toma também o `tint_formulas_account:<account>` do promote, logo depois do de loja e antes de qualquer leitura do oficial. A ordem nos dois é a mesma (loja, depois account), então não há ciclo.
  - **Prova** `db/test-tint-apply-lock-account.sh`: verde em C e pt_BR.UTF-8, com 8 asserts (APLICA MD5 LOCK LOJA ACL IDEMP GUARDA CFG) e 6 falsificações. O controle sem a migration mostra que o lock por account não era tomado antes.
  - **Codex** (`max`, 475 s): APROVAR COM AJUSTES. Pediu que a guarda de `search_path` deixasse de ser NULL-cega (`ANY(NULL)` com `RESET search_path` passaria calado); feito, com o assert CFG e a falsificação F6.
  - **Deadlock preexistente, não tratado:** o tick (lock global → linha do run → loja) pode entrar em ciclo com um promote DIRETO do mesmo run (loja → account → `UPDATE` da linha do run), porque o tick segura a linha ao incrementar tentativas. Já existia só com o lock de loja. Manutenção manual deve passar pela fila, ou tomar o lock global antes de tudo.

## 2026-11-03 — Mini aprovado na janela limpa, depois dos leitores 1, 2 e 4 e da promoção de fórmulas por diff

- **Medida:** delta de `pg_statio` de **todas** as tabelas de `public`, das 12:43 às 12:59 UTC de 03/11, no Mini (256MB e 60 conexões, no ar desde 31/10 10:33). A janela teve 5 promoções de catálogo, e o amostrador não pegou nenhuma consulta de outra sessão `claude_ro`.

  | critério do Mini | 31/10 18:10–18:26 (reprovado) | 03/11 12:43–12:59 |
  |---|---|---|
  | lido do disco ≤400 MB / 15 min | 589,5 MB | **16,7 MB** |
  | hit ≥99% | 99,56% | **99,98%** |
  | temp ≤100 MB | 237,6 MB | **99,4 MB** (no limite) |
  | conexões ≤80% | 75% | **72%** (43 de 60) |

- `tint_sync_errors` e `radar_empresas` já não leem do disco. O staging fica em ~8 MB lógicos por promoção, igual ao do small depois do #3431. A tabela que mais leu do disco foi `acoes_execucoes`, com 9,9 MB.
- **Riscos que continuam no cache e não aparecem no disco:**
  - o temp ficou a 0,6 MB do teto, com a origem ainda não identificada (o `claude_ro` não tem acesso ao `pg_stat_statements`);
  - `venda_items_history` teve 514 MB lógicos em 5 seq scans;
  - `user_roles` teve 219 MB lógicos em 9.287 idx scans, provavelmente das checagens de RLS.

  Se um deles crescer, ele volta a disputar os 256 MB. É a próxima frente se o Mini voltar a apertar.

### 2026-11-03 — a janela do fase5 ainda reprova o Mini (série de 60 s, 17:18–18:12 UTC)

- **Medida:** delta de `pg_stat_database` e de `pg_statio_all_tables` (`public`, `cron`, `net`) a cada 60 s, pelo psql-ro, com o Mini no ar (256MB e 60 conexões).

  | janela de 15 min | disco | hit | temp | conexões |
  |---|---|---|---|---|
  | 17:18–17:33 (controle) | 99,7 MB | 99,69% | 95,6 MB | 29/60 |
  | 17:34–17:49 (contaminada: eu rodei `deriva:corpo:prod` e o audit de migrations às ~17:32–17:36) | 158,2 MB | 99,77% | 140,3 MB | 42/60 |
  | **17:56–18:11, com o `tint-watchdog-fase5-6h` das 18:00** | **2.178 MB** | **90,98%** | **466 MB** | 42/60 |

- **Quem leu:** 2.153 MB cabem no minuto das 18:00, e o resto da janela somou ~22 MB. Os três `last_seq_scan` ficaram em 18:00:27, o fim exato do fase5 (início 18:00:00, 26,2 s, `succeeded`):
  - `tint_formulas`, 1.290 MB, ou seja **3 passadas** da tabela de 430 MB;
  - `tint_formula_itens`, 571 MB, 1 passada;
  - `tint_staging_formulas`, 291 MB, 1 passada.

  Nos outros crons do mesmo minuto, o mais longo foi o `data-health-watchdog`, com 8,8 s.
- **O que isso muda no "Mini aprovado" (subseção acima):**
  - **continua valendo** para a janela limpa;
  - **4 vezes por dia** (0h/6h/12h/18h UTC), a janela de 15 min que contém o fase5 reprova nos três critérios. O disco e o temp estouram por 5×;
  - a v5 baixou o job de 575 s para ~26 s. Mas o volume ainda é o de uma passada do catálogo inteiro (2,15 GB, contra os 1,14 GB medidos no statement da v5 em 01/11), e ele ainda vai para o temp.
- **O que é atenuante:** seq scan grande usa o *ring buffer*, então não expulsa o cache quente, e o pico dura menos de 30 s. Isso explica o hit voltar a ≥99,9% no minuto seguinte. Se o critério "≤400 MB por 15 min" vale para esse pico agendado é **decisão do founder**. Sem essa decisão, a régua diz que reprova.
- **Próximo passo, se a decisão for "conta":** tirar as 3 passadas de `tint_formulas` e a de `tint_staging_formulas` do fase5. Por exemplo, ler `tint_formulas` uma vez só, ou fazer o universo incremental por `updated_at`. Também pode baixar a cadência de 6 h para 24 h, fora do horário de loja.
