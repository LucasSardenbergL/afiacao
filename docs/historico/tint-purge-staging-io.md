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
- **Parte 4 (migration `20261103223300_radar_agregado_cnae`, PR #3577):** os filtros de CNAE e "estabelecidas" do ranking saem da tabela. O único escritor (`radar_agregado_recalcular`) grava um agregado fino, `radar_agregado_cnae`: o grão do agregado + `cnae_principal` + `estabelecida` (abertura ≤ corte) + `estabelecida_d1` (≤ corte+1, a madrugada BRT antes do recálculo das 06:35 UTC). O corte (`hoje SP − 5 anos`) fica em `radar_agregado_estado.corte_estabelecida`. O agregado por município virou a soma do fino, e a tabela grande continua lida uma vez por recálculo. A contagem tem 3 caminhos: agregado (sem CNAE nem data), fino (CNAE e/ou `data_max` = corte ou corte+1, sem `data_min`; agregado de outro lote = indisponível) e o vivo de antes (o resto, agora com `starts_with` no prefixo). Prova `db/test-radar-agregado-cnae.sh`: 39/39 em `C` e `pt_BR.UTF-8`, 14/14 sabotagens vermelhas; o caminho fino lê 0 vezes a tabela e o controle vivo lê 1.
- **Apply e 2ª testemunha (04/11):** ledger `db_aplicacoes` #888, `aplicada` às 09:11:40–09:11:42 UTC, sha256 `427f1adf…` do commit `3a9273d8e` (o meu `db:aplicar` seguinte saiu 3, já aplicado). Pelo psql-ro: md5 das 2 funções = arquivo (`f2302e32…`, `78fc4386…`); fino com RLS e sem SELECT para `anon`/`authenticated`; escritor sem EXECUTE para os dois; contagem só para `authenticated`; corte `2021-11-04`; soma do fino = agregado = **573.021** empresas. O `claude_ro` não executa a contagem, então a prova em prod é de uso. **Linha de base:** `seq_scan = 79`, `last_seq_scan` 06:30:22 UTC (o score diário). **Sinal de pronto:** ranking com CNAE e/ou "estabelecidas" no `/radar` sem `seq_scan` subir. Não depende de Publish: o front já manda `p_data_abertura_max` = corte.
- **Medida com uso (04/11 10:59 UTC, psql-ro, `exit 0`):** o founder recarregou o `/radar` e filtrou o ranking por CNAE e "estabelecidas". `radar_agregado_cnae` foi lido às 10:57:43 (`seq_scan` 5 → 6), e `radar_empresas` seguiu com `seq_scan = 79` e `last_seq_scan` 06:30:22 (congelado). No mesmo minuto, a tabela só foi lida por índice (`idx_radar_empresas_raiz`, `idx_radar_lista_score`, `idx_radar_empresas_fila`, `idx_radar_empresas_lote_vista`). **Sinal de pronto atingido.** Uma 1ª tentativa às ~10:50 não chegou ao banco (zero leitura em qualquer tabela do radar, provavelmente cache da aba), e por isso não contou.
- **CNAE secundário (migration `20261104153351_radar_cnae_secundario`, PR #3596):** pedido do founder. Uma marmoraria registrada com CNAE de móveis de madeira precisa ser separável sem sair da base. O `/radar` ganhou um 2º campo, combinado (E) com o principal, e só o código completo filtra. O escritor grava `radar_agregado_cnae_sec` (grão do fino + `cnae_secundario`, código repetido na RFB contado 1×) só para os códigos cobertos: os CNAEs principais da base, gravados em `radar_agregado_estado.cnaes_secundarios_cobertos`. A contagem ganhou um ramo: código coberto lê esse agregado; o resto vai ao vivo com `@>`. A lista ganhou `e.cnaes_secundarios @> ARRAY[$19]`, que usa o GIN `idx_radar_empresas_cnaes_sec`. Prova `db/test-radar-cnae-secundario.sh`: 46/46 em `C` e `pt_BR.UTF-8`, 18/18 sabotagens vermelhas.
- **Apply e 2ª testemunha (04/11):** a tentativa #894 morreu com SIGTERM quando a sessão caiu, e a transação foi desfeita: as funções seguiram nas predecessoras, sem tabela nem índice e sem consulta pendurada. A #895 virou recibo (`EXIT=0`, sha256 `369c7d9b…`). Pelo psql-ro: md5 `d627135c…`/`a9cdbac0…`/`7bd1029e…`, 1 assinatura por RPC, `anon` sem EXECUTE; **21 códigos cobertos, 137.553 grupos**; tabela com RLS e sem SELECT para `anon`/`authenticated`; GIN válido, **5,1 MB**.
- **Medida com uso (04/11 ~22:05 UTC, depois do merge às 22:01 e do Publish):** o founder filtrou por secundário. `idx_radar_agregado_cnae_sec_codigo` teve 10 leituras (última 22:04:43), o ranking e o mapa no agregado. O GIN teve 1 leitura às 22:00:26, junto com `idx_radar_empresas_cnae` e `idx_radar_empresas_local` (lista com principal + secundário). O `seq_scan` de `radar_empresas` (128) **não serve de prova aqui**: soma o apply (recálculo + GIN), as minhas contagens de secundários e o diagnóstico de outra sessão `claude_ro` (`profiles` × `radar_empresas`) que rodava às 22:05:42. Sem acesso a `pg_stat_statements`, a prova é por plano (EXPLAIN sem ANALYZE, `exit 0`): a lista default da tela + secundário, o principal + secundário (BitmapAnd GIN × `cnae_principal`) e a contagem viva de código **não** coberto (`4330404`, ~27 mil linhas) andam o GIN, e nenhuma faz Seq Scan. **Sinal de pronto atingido.**
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

- **Assinatura da receita no cabeçalho, M1 (migration `20261104110100_tint_receita_assinada_no_cabecalho.sql`):** o desenho passou por 4 versões e 3 rodadas do Codex (v1–v3 REPROVAR; notas em `side-session-notes/…/tint-assinatura-desenho-v2.md`). O que entrou:
  - `tint_formulas.receita_assinatura` (sha256 da MESMA string que o `_pulados` montava dos itens) e `receita_desde` (min(created_at) dos itens). O `_pulados` compara pela assinatura e só lê `tint_formula_itens` quando ela é NULL (filtro de uma vez dentro do LATERAL).
  - **Um só assinador:** o gatilho BEFORE ROW `trg_tint_formulas_assinatura`. Gravar qualquer valor não-nulo em `receita_*` pede a assinatura; ele recalcula dos itens com a linha já travada e sobrescreve. INSERT, tombstone da Fase 5 e isolamento acima de READ COMMITTED gravam NULL.
  - **Invalidação:** gatilhos por comando em `tint_formula_itens` (INSERT/UPDATE/DELETE com tabelas de transição, mais TRUNCATE) zeram a assinatura das fórmulas tocadas. Antes do filtro, travam o cabeçalho em ordem de id, porque um assinador em voo que não viu o item novo tem de terminar antes.
  - As funções são SECURITY DEFINER, com `search_path pg_catalog, public, pg_temp` e relações qualificadas. O privilégio TRIGGER foi revogado de quem não é dono (service_role tinha, e um CREATE TRIGGER neutralizaria o assinador).
  - **O promote:** o upsert grava NULL na assinatura. Depois dos itens, ele assina até 20.000 fórmulas por run: até metade para as reescritas, o resto para as puladas sem assinatura. Não há backfill nem cron: cada par converge nos runs que o tocam.
  - **Prova** `db/test-tint-receita-assinada.sh` (lê o cenário da `db/test-tint-promote-diff.sh`):
    - 15 asserts: MD5, EQUIV, ASSINA, LEITURA, CONC_A, CONC_B, RR, FORJA, TEMP, TOMB, PRIV, BULK, ACL, IDEMP e GUARDA, mais os controles DERIVA e TETO, e 15 falsificações com conjunto exato.
    - EQUIV inclui QUAIS chaves são puladas em cada um dos 14 runs.
    - No reenvio idêntico num par de 4.000 fórmulas, o promote varre `tint_formula_itens` 14 vezes. O de hoje varre 4.010.
    - EQUIV compara QUAIS chaves são puladas em cada run, lidas do `_pulados` dentro da transação.
    - O RH isola o hash: a staging vencedora de C8 muda no lugar, o cabeçalho continua igual e os itens continuam frescos.
    - O TETO roda com teto 6, e as 8 reescritas ficam com só 3. Os asserts ITEM e as falsificações F16/F17 entraram por pedido do Codex.
  - **Codex no código** (`max`, 772 s, 176.920 tokens): **APROVAR COM AJUSTES**, nenhum P1. Ele confirmou as 10 trocas e o md5 `4bd0e279…` sobre o corpo 2c6f. Depois disso, a sessão-irmã aplicou a `20261104110000` no promote (recibo #889, `2c6f` → `97d44242`); a M1 foi rebaseada com as mesmas 10 trocas, e o corpo final é `bbd219af…`, a equivalência sha256/`COALESCE` e o frescor `-infinity`, o early-return, o One-Time Filter e a cobertura das 2 ordens pela trava antes do filtro. Os 3 P2:
    1. **Deadlock cabeçalho ↔ item, conhecido e não tratado.** Um escritor DIRETO de item trava o item e depois o cabeçalho, enquanto o promote trava o cabeçalho e depois deleta itens. O PG aborta um dos dois, e a fila do promote tem retry. Hoje o promote é o único escritor de itens. Um escritor novo deve travar os cabeçalhos ANTES de mexer nos itens.
    2. **Lacunas da prova:** fechadas pelos itens acima.
    3. **Custo das tabelas de transição:** medido numa bancada PG17 com `work_mem` de prod (3,5 MB), num par BIG com 5.015 reescritas e 14.985 puladas por run:
       - temp igual nos dois (3,7 MB);
       - tempo de 1,3–1,7 s no promote de hoje, contra 2,1–2,9 s com a M1 (3,1 s no 1º toque, que assina 20.000).
       
       Com cache quente, são cerca de +0,15 ms de CPU por fórmula REESCRITA (as travas da invalidação e a assinatura). O ganho é em leitura de disco das puladas, que a bancada com cache quente não mede. Num run de reescrita total (1,5 M itens), a tabela de transição do DELETE/INSERT derrama em temp na ordem de 100 MB. Esse run já estoura o Mini por conta própria (é o run de 02/11).
  - **Aplicada em 04/11** (`db:aplicar`, recibo #890) sobre o corpo `97d44242`. **Renomeada depois do apply:** nasceu como `20261104061910_…`, que ordenava ANTES da `20261104110000` sobre a qual foi rebaseada. Num replay em ordem de nome a PRE dela abortaria, e o `deriva:corpo:prod` leria a `110000` como último patch. Virou `20261104110100_…` com os MESMOS bytes (sha256 `5db0f742…` = o do recibo #890). O comentário `APLICAR:` dentro dela ainda cita o nome antigo, de propósito: mudar os bytes desligaria o recibo. Validada por fora com psql-ro:
    - promote `bbd219af…` (xmin 13792171), com proconfig preservado;
    - as 2 colunas;
    - os 5 gatilhos habilitados, com o tgtype certo;
    - as 2 funções definer, com search_path fixo;
    - TRIGGER só de `postgres`;
    - promote fechado para anon/authenticated;
    - 0 assinadas: elas nascem no 1º run que toca cada par.
  - **Medir:** depois de alguns runs de fórmulas, `count(*) FILTER (WHERE receita_assinatura IS NOT NULL)` em `tint_formulas` deve crescer. A leitura de `tint_formula_itens` (delta de `pg_statio`) num run de reenvio deve cair para perto de zero, nos pares já assinados. Os 2,4 GB do run 9fdaaee4 eram 1,7 GB de itens; o heap de `tint_formulas` (610 MB) continua até a M2 (índice de cobertura por par).

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

### 2026-11-04 — o fase5 sai do horário de loja (`30 9,21 * * *`, migration `20261103222735`)

- **Decisão do founder:** "Mudar o horário" (e não "Baratear mais"). O volume de cada rodada não mudou. Ela só deixa de cair com a loja aberta.
- **Horário de loja medido:** pelo agente tintométrico (`tint_sync_runs`, 14 dias, seg–sáb), com ~650 runs/h das 10 às 19 UTC, ~470 às 20 e ~260/h das 21 às 09. Portanto, loja = 10:00–20:59 UTC (07–17 BRT).
- **Por que 2 rodadas e esse par:**
  - o dead-man da Camada A (`tint_watchdog_corante_check`, `v_b_atraso > 13 hours`) obriga um intervalo ≤ 12 h;
  - as duas rodadas precisam ficar fora de 10–21 UTC;
  - o **único** par que cumpre as duas coisas é 21:xx + 09:xx. O minuto 30 evita os crons das 09:00/09:05/09:15;
  - assim a Camada A (money-path) não foi tocada.
- **Custo aceito:**
  - **uma** rodada perdida já alarma (`tint_watchdog_fase5_parado`), ~1 h depois. Antes eram precisas duas;
  - a latência de detecção sobe de ≤ 6 h para ≤ 12 h;
  - o nome `tint-watchdog-fase5-6h` ficou, porque o texto do alerta da Camada A o cita.
- **Trava de transição (P7):** a próxima rodada menos o marcador tem que dar ≤ 12 h 30 min. Aplicar entre 21:30–00:00 ou 09:30–12:00 UTC alarmaria. A P6 exige o limite de 13 h no corpo vivo da Camada A.
- **Prova:** `db/test-tint-fase5-horario.sh` (PG17, numa transação como o `db:aplicar`):
  - 12/12 verdes;
  - cobre o mundo PROD (jobid 167 e md5 do comando intocados), DR, ATRASADO (P7 aborta com rollback) e CORANTE (P6 aborta);
  - F1/F2/F3 ficam vermelhos depois do controle verde.
- **Aplicado:**
  - em 04/11 00:2x UTC, `db:aplicar` tentativa **#883**, recibo, logo depois da rodada das 00:00 (`succeeded`, marcador 00:00:29);
  - psql-ro por fora: `30 9,21 * * *`, ativo, md5 do comando `fe21fbd8…` igual ao de antes.
- **Acoplamento em voo:** a v6 do fase5 (`20261104020000_tint_watchdog_fase5_v6_indices.sql`, sessão própria) tem uma P10 que exige `0 */6`. Ela vai abortar limpo até trocar para `30 9,21 * * *`, e a sessão foi avisada. Re-aplicar a v5 (`20261101050000`) volta o job para `0 */6`, porque a última a rodar vence.
- **Medir:** a janela de 15 min das 09:30 e das 21:30 UTC deve ter o pico do fase5, e as janelas das 12:00/18:00 não devem mais ter.

### 2026-11-03 — v6: o watchdog fase5 lê índices, não o catálogo (`20261104020000`)

- **Decisão do founder (03/11):** o pico agendado do fase5 conta para o critério do Mini. A semântica de S1..S5 não muda (o tombstone da Fase 5 é piso de gate).
- **Por que "uma passada só" não bastava:** `tint_formulas` tem 430 MB. Uma única passada já passa do teto de 400 MB por 15 min. E o temp de fundo das janelas limpas já fica em ~95–99 MB, então o ciclo tem de gerar temp **zero**.
- **O que a v6 faz** (mesmas 11 colunas do statement, que alimentam todos os alertas, a série e o marcador):
  - 5 índices: `idx_tint_formulas_wd5_carimbo` (parcial, carimbadas) · `idx_tint_formulas_wd5_ativas` (parcial, ativas, com produto/base/personalizada + `INCLUDE (id)`) · `idx_tint_formula_itens_formula (formula_id)` · `idx_tint_formula_itens_corante_formula (corante_id, formula_id)` · `idx_tint_staging_formulas_conta_criado (account, created_at)`;
  - o universo `k` sai do índice das carimbadas, e o "tem ativa" é uma sonda por chave;
  - o S1 sai pelo **complemento**. São inválidas as ativas sem item (uma sonda por fórmula, com `OFFSET 0` para não virar anti-join) e as ativas com item de corante ruim (a varredura solta em `presentes` acha os ~16 corantes; o `= ANY(ARRAY())` lê só as faixas deles). Há ainda um ramo para corante NULL. A chave não precifica quando **toda** ativa dela é inválida;
  - a `retirada` usa `NOT IN` (subplan em hash, em memória) no lugar do `NOT EXISTS`. Como `jsonb_array_elements_text` sempre estima 100 linhas, o planner ordenava as 718 mil chaves da janela em disco;
  - a config é `enable_seqscan off` + `work_mem 16MB` (a v5 desligava o index scan, o contrário).
- **Bancada PG17 em escala de prod** (1 M fórmulas, 3 M itens, 8 snapshots de 123 mil chaves, `shared_buffers=256MB`, `random_page_cost=1.1`; cache do Postgres frio a cada medida; `EXPLAIN (ANALYZE, BUFFERS)` do statement EXTRAÍDO da migration):

  | statement | lido do disco | temp | tempo | 11 colunas |
  |---|---|---|---|---|
  | v5 (config dela) | 1,37 GB (175.621 blocos) | ~260 MB | 30 s | referência |
  | v6, 1º corte (k materializado, `IN (SELECT ruim)`) | 296 MB | ~150 MB | 93 s | iguais |
  | v6, `= ANY` sem o índice `(corante_id, formula_id)` | 348 MB | 0 | 7 s | iguais |
  | **v6 final** | **114 MB (14.548 blocos)** | **0** | **4 s** | **iguais** |

  O que ainda vem do disco é a leitura, uma vez cada, dos índices parciais (~110 MB). Em prod a escala de `tint_formula_itens` é ~1,2× a da bancada.
- **Custo novo:** ~280 MB de índice (o maior é o `(corante_id, formula_id)`, ~165 MB em prod) e a manutenção dele no promote, que hoje grava só o diff. O `idx_tint_formula_itens_corante (corante_id)` de prod (63 MB) fica redundante para o watchdog; dropá-lo é DDL destrutivo, decisão do founder, e não foi feito.
- **Riscos que continuam:**
  - corante ruim usado por muitos itens, mesmo só em fórmulas desativadas, encarece o ciclo na proporção desses itens;
  - um `k_ret` amplo (retirada em massa) lê o heap das fórmulas retiradas;
  - um visibility map degradado (promote grande antes do autovacuum, que em `tint_formulas` roda a 5%) vira heap fetch.

  Os três custam na proporção do dano e não mudam o resultado.
- **Prova:** `db/test-tint-fase5-watchdog-v6.sh`. É a suíte da v5 inteira, mais:
  - PARIDADE das 11 colunas v5×v6 em 11 estados;
  - E1/E2 contra a VIEW REAL;
  - S1N (item com corante NULL);
  - PRE1 (corpo vivo divergente aborta antes dos builds);
  - PL1 (forma do plano num banco de ESCALA a ~5% de prod, com o planner de prod).

  `--falsificar` com conjunto exato.
- **Codex** (desenho, gpt-6-astra max, 541 s, 169K tokens): 3 P1 + P2, nenhum P0, nenhum contraexemplo de dados admissível. Integrados: `k` sem MATERIALIZED, a falsificação completa, o PL1 forte e em escala, o ramo do corante NULL (contraexemplo fora das premissas de prod), o lock do apply (dura até o COMMIT) e as sabotagens que faltavam (UNION ALL, DISTINCT de `k`/`k_ret`, `OFFSET 0`, PRE). Ficou de fora o P2 preexistente do empate em `ref` (dois snapshots com os mesmos dois relógios), que já existia na v5 e mudaria a semântica.
- **Codex retroativo** (código, gpt-6-astra max, 596 s, 181K tokens, 04/11 10:50 UTC, depois do apply e do merge): **nenhum P0/P1**, nenhuma divergência de resultado, sem v6.2. Conferiu a equivalência do `NOT IN` (os dois lados sem NULL), do `= ANY(ARRAY())` com array vazio, do `UNION` e do `LATERAL … OFFSET 0`; os md5 das três PREs; e a ordem de DR `20261103222735 → 20261104020000 → 20261104040000`. Três P2, na prova e no registro:
  1. o PL1 aceitava `Index Scan` (heap) sem condição nos parciais e não classificava `Bitmap Heap Scan`. Corrigido: os parciais só podem ser lidos **index-only**, e qualquer leitura deles que vá ao heap é vermelha, com ou sem condição. Um `Index Cond` feito só de `IS NOT NULL` conta como "sem condição": o btree o aceita, e foi exatamente assim que o plano sabotado passou na 1ª tentativa. O bitmap de índice sem condição também é vermelho. O PL1u testa o classificador com planos sintéticos, e a sabotagem `plano_carimbo_heap` morde. Ela usa `f.id::text <> ''` porque o PG17 descarta `f.id IS NOT NULL` (PK) no planejamento, e aí o plano não mudava. O caso do visibility map degradado continua sendo custo operacional, já listado acima;
  2. o PRE1 provava o aborto, mas não que ele vem **antes dos builds**. Corrigido: o PRE1b roda o apply com `-e` e exige zero `CREATE INDEX` ecoado, e a sabotagem `pre_depois_dos_builds` morde. A negativa da PRE da **v6** segue sem teste próprio, porque em DR o vivo dela é a v5 exata;
  3. o temp "do ciclo" na série de 04/11 era coincidência temporal num contador do banco inteiro. Agora está registrado como teto (seção abaixo).

  Riscos operacionais que ele apontou, sem falha iminente: um corante popular invalidado transforma as sondas pela PK em centenas de milhares, e `inval`/`k_ret` grandes podem derramar em outros nós. O hash do SubPlan do `NOT IN` é decidido no planejamento, pela estimativa (100 linhas da função JSON), e o crescimento normal dos dados não o derruba.
- **Acoplamento com o horário novo (#3576):** a v6 não mexe no cron. A P10 dela exige o job em `30 9,21 * * *`, e o arquivo foi renomeado para `20261104020000`, para ordenar depois do `20261103222735`. Assim um replay de DR aplica o horário antes da v6. Na prova, o efeito do `20261103222735` é reproduzido pelo mesmo `cron.schedule` entre a v5 e a v6. A migration inteira não roda no harness porque a P6 dela lê o corpo real do watchdog de corante, que lá é stub.
- **v6.1 (`20261104040000`), minutos depois do apply da v6:** a v6 foi aplicada em 04/11 03:43 UTC pelo `db:aplicar`, tentativa #886. Rodei `EXPLAIN (ANALYZE, BUFFERS)` do statement em prod e medi 131 MB do disco, contra os 114 MB previstos pela bancada. Mas apareceram **16 MB de temp**: no ramo dos corantes ruins, o planner de prod fez hash das ~490 mil ativas para casar com 260 itens (`Batches: 2`). A bancada não mostrou isso porque lá o plano é paralelo e divide o hash. A v6.1 busca a fórmula de cada item pela PK (`LATERAL … OFFSET 0`): **temp 0, 11 s** em prod, com as mesmas 11 colunas da v6, que batem com a rodada real das 00:00 (universo 463.995, S1 0, bruto 12.682). O PL1 não pega essa classe: na escala de 5% nem a v6 hasheia, então uma regra para ela seria vigia não falsificável. **Lição:** a forma do plano se prova na fixture em escala; o spill por estimativa errada só aparece em prod. Por isso o `EXPLAIN (ANALYZE, BUFFERS)` do statement em prod, com temp = 0, é etapa obrigatória da verificação pós-apply.

### 2026-11-04 — 1º run real da v6.1 em prod: o fase5 cabe no Mini; o temp de FUNDO, não (série de 60 s, 09:05–09:51 UTC)

- **Série:** `pg_statio`/`pg_stat_database` via psql-ro a cada ~62 s, 43 snapshots (1 snapshot falhou às 09:25:21 e virou um intervalo de 2 min). O cron `tint-watchdog-fase5-6h` rodou às **09:30:01, 17 s, `succeeded`**.
- **O que o ciclo leu** (intervalo 09:30:07→09:31:09): `tint_formulas` 87 MB + `tint_formula_itens` 57 MB + `tint_keys_snapshots` 4 MB ≈ **150 MB do disco**, zero seq scan, contra os 131 MB do `EXPLAIN` pós-apply. Temp: o **banco inteiro** derramou ~10,5 MB nos dois intervalos do run (2,6 + 7,8 MB; a série de 19 s da seção abaixo dá os mesmos 10,5 MB em 3 saltos). Isso é um **teto** para o ciclo, não uma atribuição: `temp_bytes` é do banco, e o padrão de 7,8 MB/2 arquivos do fundo coincide com o segundo intervalo. O `EXPLAIN (ANALYZE, BUFFERS)` do statement em prod deu temp 0. Atribuir de verdade exige medição por statement ou por sessão (Codex retroativo, P2).
- **As 11 janelas de 15 min que contêm o run** (a primeira começa em 09:16:37 e a última em 09:29:02):

  | critério do Mini | medido | |
  |---|---|---|
  | disco ≤ 400 MB | 197–273 MB | ✅ |
  | hit ≥ 99% | 99,66–99,78% | ✅ |
  | conexões ≤ 48 (80% de 60) | máx. 35 | ✅ |
  | temp ≤ 100 MB | 101–145 MB | ❌ |

- **O temp que reprova é de fundo, não do fase5.** As janelas de 15 min **sem** o run (09:30:07–09:50:56) dão **114–158 MB** de temp. Em 03/11 o fundo ficava em ~95–99 MB. O padrão é fixo: 7,8 MB/2 arquivos quase todo minuto, mais 36,8 MB/14 arquivos a cada ~10,5 min (09:16:37, 09:27:27, 09:37:25, 09:47:48), seguido de 15,1 MB/5 arquivos. A atribuição está na seção seguinte: os 36,8 MB são a promoção de catálogos, e os 7,8 MB ainda não têm dono.
- **Outro leitor, fora do tint:** em 09:14:29→09:15:32, `radar_empresas` leu **2.524 MB do disco** em um minuto (seq 0, idx +1). As janelas que pegam esse minuto vão a ~2,9 GB do disco com hit de 94%. É um leitor diferente do `/radar` corrigido no leitor 4 (aquele fazia seq scan).
- **Veredito:** a parte do fase5 está **dentro** do critério (~150 MB do disco, temp ≤ 10,5 MB, 17 s). A janela que contém o run reprova **só** no temp, e pelo fundo. Isso reprovaria mesmo sem o run. O próximo passo do Mini é atribuir o temp de fundo e a leitura de 2,5 GB do `radar_empresas`. Não é mais o watchdog.

### 2026-11-04 — o temp crônico tem dois donos: promoção de catálogos (~73 MB/15 min) e um leitor de 7,8 MB (~56 MB/15 min)

- **Medida:** `pg_stat_database.temp_bytes` a cada ~19 s, das 09:12 às 09:50 UTC (seg, loja abriu às 10:00), pelo psql-ro. A cada salto, registrei os `cron.job_run_details` vizinhos. Resultado: **335 MB em 2,52 janelas de 15 min = ~133 MB/15 min**, acima do teto de 100 MB do Mini mesmo na janela "limpa".

  | origem | MB/15 min | assinatura |
  |---|---|---|
  | **promoção de catálogos**, `tint_promote_sync_run` disparada pelo `tint-promocao-tick` | **~73** | 16 saltos (45–55 MB por ciclo, 5–7 arquivos), sempre 20–100 s depois dos 5 runs `catalogs` do agente (09:15:37, 09:26:04, 09:36:30, 09:46:57; ciclo de ~10,5 min) |
  | **sem dono** | **~56** | 18 saltos de **7,8 MB em 2 arquivos** (paralelo com 1 worker), a cada 1–2 min, em segundos que não caem no minuto cheio de nenhum cron |
  | fase5 v6.1 (09:30) | ~4 | 10,5 MB em 3 saltos: o run real quase não derrama mais |

- **Descartado no "sem dono":**
  - **preparações:** `tint_staging_preparacoes*` tem 0 inserts desde o restart;
  - **ticks de 15 s:** só leem `tint_sync_runs` por índice;
  - **`clientes-import-continuacao-1min`:** os saltos não caem no minuto cheio.
- **Por que o "sem dono" segue sem nome:** o `claude_ro` não lê `pg_stat_statements` (`permission denied for schema extensions`). Também não vê `query_start` nem `query` de outras roles. Atribuir exige `pg_read_all_stats` para o `claude_ro`, que é decisão do founder, ou uma série por `application_name` e `usename`.
- **Próximo passo, promoção:** achar o statement do ramo `catalogs` de `tint_promote_sync_run` (66 mil caracteres) que faz sort/hash em disco. O método é o mesmo da v6.1: cópia read-only, `EXPLAIN (ANALYZE, BUFFERS)` em prod, depois exigir temp 0. A ordem de grandeza é de 4,8 GB de temp por dia. É money-path (catálogo/preço do tintométrico), com prova PG17 e Codex.

### 2026-11-04 — promoção de catálogos sem temp: o `_snap_fonte` só nasce com expansão (`20261104110000`)

- **Dono achado:** não era um statement do "ramo catalogs" (a função não tem ramo por `sync_type`), e sim o filtro de fantasmas da fonte (`20261013150000`). Em TODA promoção com snapshot de fórmulas aplicado, ele fazia `CREATE TEMP TABLE _snap_fonte AS SELECT DISTINCT chave FROM tint_keys_snapshots, jsonb_array_elements_text(keys)` e `CREATE INDEX`. O snapshot de oben/M01 tem **123.388 chaves** (3 chunks). Nos runs `catalogs` (685 das 688 promoções/24 h), o `_expand_uniq` está vazio, então o DELETE que consome o `_snap_fonte` não apaga nada: o DISTINCT era trabalho puro.
- **EXPLAIN (ANALYZE, BUFFERS) em prod** (psql-ro, cópia read-only do SELECT, `work_mem` 3,5 MB): `HashAggregate Batches: 5 Memory Usage: 7105kB Disk Usage: 3688kB`, mais o tuplestore do `jsonb_array_elements_text` (41 mil elementos por chunk, `temp written=465`). Total: `temp written=1222` (~9,5 MB) por promoção.
- **Série de controle** (`temp_bytes` a cada ~15 s, 11:34–11:59 UTC, loja aberta): 126,6 MB/15 min. Cada run `catalogs` deixa a assinatura **+3 arquivos / +7,6 MB**, 5 em sequência a cada ~17 s por ciclo do agente (≈ 46 MB/15 min). Os **+2 arquivos / +8,4 MB** a cada 1–2 min são o outro dono, sem nome e fora desta entrega.
- **Troca:** o `IF v_snap_id IS NOT NULL` passa a exigir `AND EXISTS (SELECT 1 FROM _expand_uniq)`. Com o `_expand_uniq` vazio, o DELETE apagaria 0 linhas e `v_fantasmas_fonte` ficaria 0, que é o valor inicial que ele mantém agora. Com expansão (run de fórmulas ou `catalogs` com sku novo), o filtro é o de antes, verbatim. Única diferença observável (Codex): um snapshot corrompido (`keys` não-array) fazia o SRF abortar até as promoções de catálogo; agora só aborta quando há o que filtrar.
- **Molde:** TRAVA → PRE md5 `2c6f461f` (o `c_este` do #3553) → 1 troca ancorada → PÓS md5 `97d44242` → REVOKE → postcondição de posição (guard depois do `_expand_uniq`, antes do `_snap_fonte` e do filtro) + config + ACL. **Pré-voo psql-ro:** a postcondição contra o estado antigo caiu só no P1, e P2/P3 passaram. **Aplicada** por `db:aplicar` (recibo #889, xmin 13787158). **Validada por fora** (psql-ro): md5 `97d44242`, guard no corpo, `search_path` e `statement_timeout=300s` preservados, `SECURITY DEFINER` mantido, anon e authenticated sem EXECUTE.
- **Prova:** `db/test-tint-promote-snap-fonte.sh`, verde em `C` e `pt_BR.UTF-8`. São 11 asserts (APLICA MD5 PAR_CAT PAR_SKU PAR_FORM MARCA_CAT TEMP_CAT FILTRO IDEMP GUARDA ACL) e 7 falsificações, cada uma com conjunto exato. O promote antigo, no mesmo template, é a referência de paridade nos 3 cenários: catalogs sem expansão, catalogs com sku novo e fórmulas. O TEMP é contado por `log_temp_files=0` com `work_mem` 64 kB e 20 mil chaves. O controle no antigo exige temp > 0 e o `_snap_fonte` criado, senão MARCA_CAT/TEMP_CAT seriam vácuos. **Codex** (gpt-6-astra, high, 150 s): sem P0/P1. O P2 (GUARDA exigia a mensagem da PRE, F4 a reprovaria) e os P3 (F6 virava no-op; paridade por projeção) foram corrigidos antes da rodada final.
- **Baseline da deriva:** entra o PATCH `20261104110000` e é **conciliado** o `tint_apply_keys_snapshot(uuid)` do #3578, que o `deriva:corpo:prod` acusava como `PATCH_NAO_CONCILIADO`. O md5 de prod `ea5acf0e` é o `c_este` daquela migration (xmin 13739024).
- **Série depois do apply** (mesma régua, 12:09–12:44 UTC, loja aberta, 123 amostras): **85,8 MB/15 min** (antes, 126,6), abaixo do teto de 100. Houve **zero** saltos com a assinatura +3 arquivos / +7,6 MB, com 15 runs `catalogs` promovidos (15/15 `promovido`, 0 erros). Os ciclos `catalogs` de ~12:25 e ~12:36 só têm o +2 arquivos / +8,4 MB periódico do outro dono, que caiu na janela por coincidência. Os +2,5/+3,7 MB de 12:15 caem no lote de cron do minuto `:15` e já existiam antes do apply (11:45, 11:52). O `EXPLAIN` com temp 0 é vácuo aqui: nos runs `catalogs`, o statement deixou de executar. A evidência é a série.
- **Fica para depois (não é desta entrega):** os 3 runs/dia de fórmulas seguem derramando ~10 MB cada no `_snap_fonte`. Para eles, tirar só o `DISTINCT` (o `NOT EXISTS` não muda com duplicata) precisa ser medido antes de adotar.

### 2026-11-04 — o "+2 arquivos / +8,4 MB" não é código nosso: trava em fase com o minuto, às :40–:41, e não lê tabela

- **Medida** (psql-ro, 23:25–23:46 UTC, uma conexão com `\watch` a cada 1 s, reconectando a cada 60 ticks, 0 quedas):
  - `pg_stat_database` (temp);
  - `pg_stat_activity` (pid, `usename`, `application_name`; o `claude_ro` não vê query nem estado de outras roles);
  - `pg_stat_user_tables` inteira (465 tabelas, `cron` e `net` incluídos);
  - depois, 4 min de `pg_stat_sys_tables` (`pg_catalog`).
- **A fase:** dos 12 saltos de +2 arquivos / +8,5 MB, 10 caem no **segundo :40–:41**, separados por **60 ou 120 s** exatos: 23:25:41, 23:32:40, 23:33:41, 23:35:41, 23:37:41, 23:38:40, 23:40:41, 23:42:40, 23:44:40, 23:45:40. Os outros dois (23:29:46 e 23:30:53) atrasaram alguns segundos. Nenhum cron nosso dispara fora do `:00`, e um job que derrama "às vezes" no mesmo segundo é um coletor periódico. Os 2 saltos de +1 arquivo / +4,2 MB (23:27:30 e 23:28:17) são outro leitor, pequeno: tabelas `tint_*` via PostgREST.
- **O que ele lê: nada que se veja.**
  - Na maioria dos saltos, a janela de 4 s não tem tupla de tabela de usuário. Nos que têm, a leitura é de outro leitor que coincidiu: as 133.125 tuplas de `omie_customer_account_map` + `sync_reprocess_log` aparecem idênticas a cada ~5 min.
  - No catálogo, o único sinal é o **do próprio observador**: `pg_class` +6.274 e `pg_index` +248 a cada tick vêm do `pg_stat_*_tables` da série.
  - Uma query que derrama 2 × 4,2 MB sem ler tabela nem catálogo encaixa num **SRF materializado acima do `work_mem`** (3,5 MB). O exemplo típico é `pg_stat_statements()`, cujo tuplestore carrega o texto de cada statement.
- **Quem:** não há conexão transitória que discrimine. As que aparecem (`authenticator/postgrest`, o próprio `claude_ro`) estão em ~78% dos ticks longe dos saltos também. Logo, ele roda numa conexão **estável**. Das 12 estáveis, a que coleta a cada minuto é a **`supabase_admin/postgres_exporter`**, o coletor de métricas do Supabase. **Atribuição por eliminação, confiança média:** a fase e o "não lê tabela" são medidos; o exporter é a única explicação de fase fixa que sobra.
- **Peso:** ~56 MB/15 min, a maior parte dos 85,8 MB/15 min da janela de loja aberta depois do #3587. Não é código do repo, então **não há PR que o corrija**.
- **Experimento decisivo (founder, SQL Editor).** O `claude_ro` não lê `extensions` (`permission denied`).
  1. Leitura: `SELECT count(*), pg_size_pretty(sum(length(query))::bigint) FROM extensions.pg_stat_statements;`. Um total de textos na casa dos MB sustenta a hipótese.
  2. Se sustentar: `SELECT extensions.pg_stat_statements_reset();`. Perde-se o histórico de performance, que ninguém aqui consegue ler mesmo. Se os saltos das :41 somem na série seguinte, a atribuição fica **provada**, e o temp de fundo cai de ~86 para ~30 MB/15 min. Mas eles voltam à medida que os textos se acumulam. Também é preciso decidir se esse coletor interno do Supabase conta para o critério do Mini.

## 2026-11-04 — o "5º leitor" de `tint_formulas` não é recorrente: a janela das 13:00 pegou um apply

**Pergunta:** a janela 13:00–13:15 UTC de 04/11 reprovou o Mini: 523,6 MB de disco, hit 96,86%. Desses, 430 MB vieram de `tint_formulas` (2 seq scans) e 84 MB de `tint_sync_runs` (1 seq scan). `pg_stat_user_tables` mostrava 87 seq scans em `tint_formulas` desde o restart de 31/10, o último às 15:28:37, com a loja aberta. Havia uma tela ou edge varrendo a tabela?

**Medida** (psql-ro, só catálogo de stats):
- **Amostrador** de `seq_scan`/`last_seq_scan`, a cada 3 s, das 15:50 às 18:52 UTC, com a loja aberta. Resultado: **zero** seq scans em `tint_formulas` e em `tint_sync_runs` em 3 h. Os contadores ficaram parados em 89 (última 15:32:37) e 37 (última 15:44:14).
- **Os seq scans vêm aos pares:** os 2 das 15:28–15:32 somaram `seq_tup_read` +1.002.148, que é a tabela inteira uma vez (`n_live_tup` 1.002.575). Cada consulta paralela conta um seq scan por processo. Logo, os ~87 seq scans são ~44 consultas em 4,6 dias.
- **Dono da janela das 13:00:** o ledger `public.db_aplicacoes` tem o **#890** aplicado às 13:10:36. É a M1, "receita assinada no cabeçalho" (`20261104110100`, PR #3590), que faz `ALTER TABLE tint_formulas`, gatilho e postcondições sobre a tabela. É evento pontual de DDL, não leitor recorrente.
- **Runs do agente hoje:** 540 `catalogs`, 1 `formulas` (10:18, promovido às 10:27) e 1 `keys_snapshot` (03:13). Nenhum explica 13:00 nem 15:28.
- **Janela limpa de controle** (18:54:37–19:09:40 UTC, loja aberta): disco **3,7 MB**, hit **99,95%**, temp **77,4 MB**, conexões **18/60 = 30%**. Passa os quatro critérios. Nenhuma tabela leu mais de 2 MB do disco.

**Candidatos descartados com EXPLAIN em prod:**
- **E4 da promoção** (recálculo de preço por `tint_staging_precos_base`, junção sem `cor_id`): não roda. O staging de preços de base está vazio e nenhum `tint_staging_corantes` chega com `custo`.
- **Telas:** contador do `TintDashboard`, lista e busca de `TintFormulas`/`TintCatalogo`, `useGlobalSearch`, `TintPricing` e `useCorPrimeiro` via `v_tint_formula_canonica`. Todas usam índice (`idx_tint_formulas_busca_cor` index-only, `idx_tint_formulas_ativas`, `uq_tint_formulas_chave`).
- **Ressalva, um leitor que não aparece como seq scan:** as buscas com `ilike`/`imatch` em `cor_id` (sem trigram) percorrem `idx_tint_formulas_ativas` inteiro, ~490 mil fórmulas ativas, com filtro no heap. É o heap quase todo, contado em `idx_scan`. Na janela de controle não leu do disco (cache quente). Vira leitor de disco só com cache frio. Se aparecer numa janela reprovada, a correção é um trigram em `cor_id` ou busca por prefixo.

**Lições de régua** (valem para as próximas janelas):
1. **Antes de culpar um leitor, cruze a janela com `db_aplicacoes`** (`iniciado_em`/`concluido_em`). Um apply, ou o ensaio de outra sessão, com postcondição sobre tabela grande reprova o Mini sozinho e não se repete.
2. **O amostrador pode contaminar a própria medida.** A consulta de contexto do primeiro amostrador (`tint_sync_runs WHERE created_at > … OR completed_at > … OR promovido_em > …`) fazia seq scan na tabela que ele vigiava. Os 3 seq scans de 15:43–15:44 foram dele. A versão corrigida prefixa `started_at > now() - 120 s` (indexado) e foi conferida com `EXPLAIN` antes de rodar.
3. **`pg_stat_activity` não serve para dar nome ao dono:** para o `claude_ro`, as linhas de outros papéis vêm sem `query`, `state`, `backend_type` e `leader_pid`. Sem `pg_read_all_stats`, quem dá o nome é o tempo: `last_seq_scan` em ms, `cron.job_run_details`, `tint_sync_runs` e `db_aplicacoes`.

**Donos do par das 15:28:37/15:32:37** (achados depois do merge do #3597, nas transcrições das sessões no Mac):
- **15:28:17**: a sessão do expurgo tint (worktree `v4-lote12-expurgo-tint`) rodou pelo psql-ro um `count(*) … FILTER (WHERE receita_assinatura IS NOT NULL) FROM public.tint_formulas` **sem WHERE**. A varredura terminou às 15:28:37 (`last_seq_scan`).
- **15:32:30**: a sessão `tint-m2-indice-cobertura` rodou a mesma contagem, terminando às 15:32:37.

Os dois são diagnóstico, não produto. Isso fecha a conta dos ~87 seq scans desde 31/10, que somam ~44 consultas paralelas. Todos os donos achados são pontuais ou de madrugada: applies e ensaios de migration sobre a tabela (o ensaio do `db:aplicar` **não** grava no ledger, então é invisível em `db_aplicacoes`), contagens de diagnóstico das sessões, o fase5 v5 4×/dia até 03/11, builds de índice e o expurgo da madrugada. **Regra para diagnóstico em prod:** `count(*)` sem filtro em `tint_formulas` custa 430 MB de disco e reprova uma janela do Mini sozinho. Use `pg_class.reltuples` / `pg_stat_user_tables.n_live_tup` para o tamanho, e um `FILTER` só com predicado indexado.

## 2026-11-05 — 1º run de fórmulas depois da M1 (`82be55dc`): medida, e a M2 fica segurada

**Pergunta:** a M1 (#3590, recibo #890) já gera sinal? E o índice de cobertura por par em `tint_formulas` (M2: chave `(account, produto_id, base_id, cor_id, embalagem_id)` + INCLUDE das colunas do lookup do `_pulados`, `WHERE desativada_em IS NULL`) deve entrar agora?

**Gate de entrada (04/11):** de 13:10 a 21:56 UTC não houve run de `formulas`, só 65 de catálogo, e havia 0 assinadas. O índice **não** foi criado sem sinal. Um vigia psql-ro tirou snapshot de `pg_statio`/`pg_stat` a cada 60 s até o próximo run de fórmulas ser promovido.

**Janela de controle sem run de fórmulas** (15:36–21:24 UTC de 04/11):
- `tint_formulas` leu 39 blocos de heap e 309 de índice do disco.
- O banco inteiro leu ~230 MB por 15 min, com temp de ~83 MB por 15 min e hit de **97,67%**. O hit fica abaixo da meta do Mini mesmo sem run, e o culpado não é `tint_formulas`.

**O run `82be55dc`** (ingerido 10:02:52 e promovido 10:09:06 UTC de 05/11). Delta das 10:01:50 às 10:11:20, sozinho na janela:

| | `tint_formulas` | `tint_formula_itens` |
|---|---|---|
| lido do disco: heap | 106.302 blocos (**871 MB**) | 215.280 (**1.764 MB**) |
| lido do disco: índice | 24.600 (202 MB) | 48.174 (395 MB) |
| escritas | 208 ins + 20.064 upd, **HOT 97,3%** | 976 ins + 192 del |

- **Metadata:** 271.008 chaves; `formulas_identicas_puladas` 270.736; `receitas_assinadas` **20.000** (o teto `c_teto_assinar` por run); `recalculadas` 0.
- **Banco inteiro em 9,5 min:** 4.366 MB do disco, hit 94,37%, temp 499 MB.
- **Por chave, contra o `9fdaaee4`:**
  - `tint_formulas`: 3,2 KB, contra 4,3 KB.
  - itens: 6,5 KB, contra 5,9 KB. Com 4% assinadas (e o 1º toque lendo os itens para assinar), a M1 ainda não aparece na leitura de itens.

**Sinal da M1:** positivo, com denominador. São 20.000 assinadas de 493.788 vivas (4,05%). O teto é de 20 mil por run, e os runs de fórmulas vêm 1 a 3 vezes por dia desde 28/10. A convergência leva ≥ 24 runs, ou 1 a 3 semanas, e só nos pares que cada run toca.

**Decisão do founder (05/11): segurar a M2 até a M1 convergir.** O índice não traz ganho durante a convergência, e traz custo:
1. **HOT:** os ~20 mil UPDATEs do assinador por run são 97,3% HOT hoje. Com `receita_assinatura`/`receita_desde` no INCLUDE, que é obrigatório para o index-only, todos deixariam de ser HOT e escreveriam nos 8 índices da tabela. O lote 11 (#3591) foi na direção oposta.
2. **Visibility map:** as 20 mil linhas, em ordem de `formula_id` (uuid), sujam ~30% das 55,1 mil páginas do heap a cada run (1−e^(−20000/55103)). O autovacuum só dispara perto de 50 mil linhas mortas: depois do run eram 19.398, e o último autovacuum foi em 02/11. Durante a convergência, o "Index Only Scan" voltaria ao heap numa fração grande do lookup.
3. **O maior bloco do run são os itens (1,76 GB),** e esse corte é da M1. O heap de `tint_formulas` (871 MB) é o alvo da M2, que só paga quando o assinador parar de sujar páginas.

**Pré-voo do desenho, já feito para a retomada:**
- No corpo vivo do promote (md5 `bbd219afff819b3d2401f8e33a8a4010`), o lookup do `_pulados` lê `id, updated_at, nome_cor, sku_id, volume_final_ml, preco_final_sayersystem, personalizada, receita_assinatura, receita_desde`, e filtra por `subcolecao_id` (com `COALESCE`).
- `updated_at` e `preco_final_sayersystem` hoje não são indexados. Os 2 UPDATEs de recálculo de preço (`SET preco…, updated_at = now()`) deixariam de ser HOT. Esse recálculo esteve em 0 nos 7 dias até 04/11 (2.370 runs de catálogo e 14 de fórmulas).

**Quando revisitar** (é uma query, não um recado; lê só `tint_sync_runs`, sem varrer `tint_formulas`):
```sql
SELECT sum((metadata->>'receitas_assinadas')::int) AS assinadas_desde_m1
  FROM public.tint_sync_runs
 WHERE sync_type = 'formulas' AND started_at > '2026-11-04 13:10:37+00';
```
- É limite superior: uma reassinatura de par já assinado conta de novo.
- Retome a M2 com ≥ ~90% das vivas e a leitura de itens por run em queda, medida no delta de `pg_statio` de um run de reenvio.

**Medição:** a regra do `count(*)` (acima) se repetiu. As duas contagens desta sessão, às 21:55 de 04/11 e às 10:11:55 de 05/11, leram cada uma o heap inteiro: 55,1 mil blocos, 451 MB do disco.
