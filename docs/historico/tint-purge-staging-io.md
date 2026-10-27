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
