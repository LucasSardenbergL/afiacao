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
- Fica para outra entrega: o conector consultar o hash também com HWM funcional (a correção de verdade), e o 2º evento não atribuído de 13:33 UTC (+557 MB, scan de `idx_tsf_acct_par` lendo a tabela inteira por `account`, perfil compatível com `public._tint_preflight()`, que tem EXECUTE para anon e authenticated).
