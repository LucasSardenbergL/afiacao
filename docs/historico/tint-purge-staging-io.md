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
