# Radar — carga mensal publica a foto de uma vez (staging + troca atômica)

**Entrega:** migration `20261110130000_radar_carga_publicacao_atomica.sql` + edge `radar-ingest` v1.7
(`v1.7-carga-staging-atomica`) + `scripts/radar/carga.ts`. Prova PG17: `db/test-radar-carga-atomica.sh`
(núcleo do CI, 37 asserts, 12 sabotagens, verde em `C` e `pt_BR.UTF-8`).
Origem: 2ª revisão do Radar (Fable + Codex); era follow-up do Codex no bloco 1 (PR #3169).

## O defeito (medido no código e na prod, 2026-11-08)

- O `chunk` fazia upsert direto em `radar_empresas` com `ultimo_lote = <mês novo>`. Os leitores (fila, KPIs,
  card, e-mail, score, agregado) filtram `ultimo_lote = <vigente>`, e vigente = maior `mes_referencia` `complete`.
  ⇒ durante os ~10 min de POSTs, **cada chunk tirava ~1.000 empresas da foto vigente**; uma carga que morresse
  no meio deixava o lote `error` e a foto vigente **pela metade** até a próxima carga completa (o retry do
  `post()` aborta a carga inteira, então o finalize nunca chegava).
- O re-run `--forcar` de lote `complete` rebaixava o lote para `running` no `begin_lote` ⇒ vigente = mês anterior,
  cujas linhas já tinham o rótulo do mês re-rodado ⇒ fila quase vazia durante a carga.
- Prod: `radar_empresas` 573.021 linhas / 1,26 GB / 23 índices; o authenticator tem `statement_timeout=8s` (o
  `service_role` não tem config própria) ⇒ nenhuma troca O(n) cabe num request da edge — o mesmo 57014 do lote
  2026-09 (`radar-finalize-timeout-2026-09.md`).

## O desenho

| Etapa | Quem | O que garante |
|---|---|---|
| `begin_lote` → `radar_carga_iniciar` | edge | TRUNCATE do staging; fase `recebendo`; lote `complete` **continua** `complete`; recusa lote mais antigo que o vigente e begin com lote validado pendente |
| `chunk` → `radar_carga_receber` | edge | grava em `radar_empresas_carga` (staging), nunca na viva; recusa lote fora de `recebendo` (`FOR SHARE` × `FOR UPDATE` da validação = corte limpo) |
| `finalize` → `radar_carga_validar` | edge | staging = `esperado` (Σ `upserted` dos chunks, a carga dedup por CNPJ antes), sem queda > 15% contra a foto vigente (`aceitar_queda` libera); replay devolve o veredito gravado |
| `radar_carga_publicar_pendente` | cron `radar-publicar-lote` (`*/15 0-5,7-23 * * *`, owner) | **uma transação**: upsert staging → viva, postcondição de contagem, `radar_recruzar_ja_cliente`, `complete` + `finalizado_em`, TRUNCATE, ledger `radar.publicar_lote`. Erro → foto intacta e lote `falhou`; lock/deadlock → `adiado` (fica `validada`) |
| catch da edge → `radar_carga_falhar` | edge | só carga `recebendo` vira `falhou`; lote `complete` nunca cai |

- **Fase separada do status:** `carga_fase` (`recebendo`/`validada`/`publicada`/`falhou`) é da carga; `status` é do
  leitor. Nenhum leitor mudou (`loteVigente` em `src/lib/radar/lote-vigente.ts` e todas as RPCs já ignoravam não-`complete`).
- **Hora 06 UTC fora do cron:** 06:05 situação · 06:15 recruzar · 06:30 score · 06:45 aviso · 06:50 contábil
  regravam/leem `radar_empresas` em massa — publicar junto daria deadlock/lock longo.
- **Consequência aceita:** o lote vira vigente até ~15 min depois do finalize; a publicação segura locks de linha
  de `radar_empresas` por alguns minutos (o mesmo upsert que antes se espalhava pelos chunks) — vendedor que editar
  um lead nesse instante espera até 8 s (lock_timeout do PostgREST) e pode ver erro; segunda de manhã, como a carga.

## Lições

- **Atomicidade de foto não se compra com contagem no fim:** o finalize antigo contava `ultimo_lote = mês` com
  `count exact` e marcava `complete` — a contagem estava certa e a foto já tinha vazado. O que protege é o leitor
  não enxergar a escrita até o fim (staging), não o veredito sobre ela.
- **"Ausente ≠ zero" no protocolo:** sem `esperado` a validação reprova (fail-closed); edge antiga (sem `upserted`)
  aborta a carga em vez de declarar 0.
- **Sabotagem de ACL que troca o `REVOKE` inteiro acende a camada ERRADA** (default privileges abrem para anon e o
  P6 grita antes do P7): sabote ACRESCENTANDO o grant, mantendo o resto — uma camada por vez.

## Camadas de deploy (merge ≠ produção)

1. Migration (SQL Editor / MCP) — **antes** da edge. A v1.6 segue funcionando com a migration aplicada; a v1.7
   sem a migration falha no `begin_lote` sem tocar a fila.
2. Edge `radar-ingest` v1.7 (decidido por `bun run pendencias:deploy`).
3. Publish: não há mudança de front (só comentário em `lote-vigente.ts`).
4. 1ª carga real (próxima segunda, 03:00 BRT): conferir `carga_fase = 'publicada'` e o ledger `radar.publicar_lote`.
