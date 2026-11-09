# Saúde de dados: botão "Re-executar" (fase 1) em vez de remediador automático (2026-10-31)

## Pedido

O founder pediu correção automática "toda vez que os checks da `/gestao/saude-dados` ficarem vermelhos".
Antes de construir, um levantamento em prod (psql-ro + conector Lovable com `SET TRANSACTION READ ONLY`
atestado `transaction_read_only=on`, sem escrita).

## O que a prod mostrou

- `_data_health_compute()` emite **33** checks; em 31/10 ~16h BRT, 33/33 `ok`. O `data_health_watchdog`
  vigia 25 (ARRAY `v_sources`) e grava episódios em `fin_alertas` (`tipo = 'data_health_<source>'`).
- 60 dias de episódios: `sync_state_saude` 41 (mediana 0,5 h, máx 30 h), `pedidos_compra_sync` 9,
  `sync_reprocess_saude` 6, `tint_cobertura_bases` 3, `reposicao_disparo`/`reposicao_portal_humano` 2 cada
  (centenas de horas — correção humana). **Todos fecharam pelo `ok` automático, 0 dismiss humano.**
- Os episódios longos tinham causa **determinística**: `pedidos_compra_encerrados` (18/10) teve dois
  re-disparos manuais que REPETIRAM a falha (#3144/#3164, [ospc-passada-encerrados-earlydrop.md](ospc-passada-encerrados-earlydrop.md));
  `customers/servicos` congelado 37 dias era guard de colisão ([sync-servicos-congelado-verificacao.md](sync-servicos-congelado-verificacao.md)).
  Retry automático não teria curado nenhum dos dois.

## Decisão

Nenhum incidente qualifica uma máquina meta (regra do CLAUDE.md). A fase 1 é superfície de produto com
sensor: botão por check, só quando o check não está `ok`, que re-dispara o MESMO job do cron.

- Catálogo em `src/lib/dataHealth/reexecutar.ts`: `customer_metrics` (RPC staff `request_customer_metrics_refresh`),
  `carteira_scores` (`calculate-scores`), `carteira_rebuild` (`carteira-rebuild`), `estoque_inventario`
  (`omie-analytics-sync` `sync_inventory`/`vendas`), `estoque_reposicao` (`omie-sync-estoque` OBEN — a edge já
  grava `reposicao.sync_estoque`, então o front não abre 2º registro).
- Fora: money-path (exige `/codex` + `prove-sql-money-path`), correção humana (portal Sayerlack, cadastro no
  Omie, identidade, credencial), `radar_recruzamento_tick` e `omie_tipo_produto_oben` (sem caminho staff hoje),
  `vendas_cadastros`/`sync_state_saude` (ação depende da entidade).
- Lease ocupado (`{skipped:true}` do calculate-scores, 409 do carteira-rebuild) vira "já em andamento", não sucesso.
  O toast nunca diz "resolvido": o check só volta a verde pelo compute.
- Sensor: `acoes_execucoes` com slug `saude_dados.reexecutar_<source>` (+ `track('saude_dados.reexecutar')`).
  Denominador: episódios em `fin_alertas` do mesmo source.

## Quando medir a fase 2 (remediador automático)

```sql
-- cliques por source e se o check voltou a ok depois (cruzar com fin_alertas.resolvido_em)
SELECT acao, status, count(*) FROM public.acoes_execucoes
 WHERE acao LIKE 'saude_dados.reexecutar_%' GROUP BY 1, 2;
```

Fase 2 só com esse sinal **e** um incidente citado por ID. Desenho proposto (cron próprio fora do trio
compute/watchdog/heartbeat, `UNIQUE(alerta_id, tentativa)`, teto 2 por episódio, nunca toca `fin_alertas`) na
proposta da sessão de 2026-10-31.
