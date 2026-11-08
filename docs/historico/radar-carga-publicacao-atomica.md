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

## No ar (2026-11-08, PR #3739 mergeado em `4f70daf95`)

- **Migration aplicada pela sessão** (envelope via MCP `query_database`, 13:4xZ): ensaio `ENSAIO_OK` com P1–P9 +
  md5 dos 5 corpos (= md5 do arquivo, conferido em PG17 local) e prod intacta conferida; apply com `COMMIT`; 2ª
  testemunha por psql-ro: staging com RLS e sem grant a anon/authenticated, 6 colunas `carga_*`, CHECK
  `convalidated`, os 5 `md5(prosrc)` iguais ao arquivo, ACL (4 RPCs só service_role, publicação só owner), cron
  `radar-publicar-lote` jobid 279 ativo como `postgres`. Lotes existentes intactos (`carga_fase` NULL = legado).
- **Edge `radar-ingest` v1.7 deployada pela sessão** (MCP `send_message`, colagem do `pendencias-pacote`, 0,8
  crédito, 9/9 sha256 conferidos pelo agente contra `4f70daf95`). Sonda `db/sonda-radar-ingest-2026-11-08.sql`
  (db:aplicar recibo #1005) → **DEPLOY CONFIRMADO** (`v1.7-carga-staging-atomica`); `pendencias:deploy` exit 0.
- Sensor de edição: exit 1 (`EDICAO_DETECTADA`) só pelo `edit_id`/`commit_sha` da resposta — o único commit do bot
  (`2ab3f8dcf`) é o `src/integrations/supabase/types.ts` regenerado (+110 linhas = exatamente a tabela, as colunas e
  as 5 RPCs desta migration), que o próprio sensor lista como tolerado. Nada a reverter.

## Camadas de deploy (merge ≠ produção)

1. ✅ Migration (aplicada 2026-11-08) — **antes** da edge. A v1.6 segue funcionando com a migration aplicada; a v1.7
   sem a migration falha no `begin_lote` sem tocar a fila.
2. ✅ Edge `radar-ingest` v1.7 (DEPLOY CONFIRMADO pela sonda, 2026-11-08).
3. Publish: não há mudança de front (só comentário em `lote-vigente.ts`).
4. 1ª carga real (próxima segunda, 03:00 BRT): conferir `carga_fase = 'publicada'` e o ledger `radar.publicar_lote`.

## ⚠️ 1ª carga real: a publicação não cabe numa transação (2026-11-08, cron PAUSADO)

**O que aconteceu.** Re-run do 2026-10 (503.929 linhas) validou às 16:57Z. O job `radar-publicar-lote`
das 17:00 rodou o upsert staging→viva numa transação só e morreu no `statement_timeout` de 30 min
(17:30:01, `57014`); a execução seguinte (enfileirada pelo pg_cron) repetiu. A foto vigente ficou
**intacta** (rollback — a garantia (a) do desenho se cumpriu em prod), mas apareceram dois defeitos:

1. **Laço.** `57014` (`query_canceled`) **não** é capturado por `WHEN OTHERS` → o lote não virava
   `falhou`, ficava `validada`, e o cron retentava sem fim (30 min ligado a cada ~45).
2. **Dano colateral da transação longa.** Enquanto ela roda, segura row lock em ~500k linhas de
   `radar_empresas` (edição de prospecção espera) **e trava o Supabase Realtime**: medido
   `realtime_replication_connection` e `realtime_rls` em `ShareLock` com `pg_blocking_pids = {pid do cron}`.

**Por que é estrutural, não ajuste de timeout.** A foto é um RÓTULO por linha (`ultimo_lote = vigente`).
Trocar a foto = reescrever ~500k linhas, e `radar_empresas` tem **27 índices** (3 GIN, trigram,
expressões com regexp) com `ultimo_lote`/`updated_at` indexados → todo UPDATE é não-HOT e reinsere em
todos. Em pedaços isso já custava 9–61 min (cargas 2026-08/09/10); numa transação passa de 30.
Subir o timeout só aumenta o tempo com Realtime travado.

**Contenção aplicada (envelope, validada por psql-ro às 17:41–17:43Z):**
- `pg_cancel_backend` da execução condenada + `radar_ingest_state` 2026-10 → `carga_fase='falhou'`
  (`status` segue `complete`; staging fica até o próximo `begin_lote`).
- `cron.alter_job(279, active := false)` — o job `radar-publicar-lote` está **inativo**. Com ele
  pausado, uma carga nova **valida e espera**; a foto vigente não muda (modo de falha seguro). O
  `begin_lote` seguinte recusa enquanto houver lote `validada` → o workflow fica vermelho (sinal).

**Pendente (redesenho — decisão de arquitetura):** publicar em transações CURTAS sem expor foto
parcial. Candidatos: (i) refresh cadastral em lotes sem mexer no rótulo + inserção dos CNPJs novos e
troca de ponteiro no fim, com leitores lendo `ultimo_lote IN (vigente, em_publicacao)` durante a
troca; (ii) foto por ponteiro (tabela de membresia/partição) em vez de rótulo por linha. Em qualquer
um: capturar `query_canceled` explicitamente, e **não religar o cron** antes da prova.
Religar (só depois do fix): `SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname='radar-publicar-lote'), active := true);`

**Lição.** A prova em PG17 tinha 37 asserts de CORREÇÃO e nenhum de CUSTO: rodou com centenas de
linhas e 2 índices. Desenho "uma transação" precisa ser medido no volume e nos índices REAIS (aqui,
27 índices × 500k) antes de ir ao ar, e a falha por timeout precisa de ramo próprio (`57014` ≠ OTHERS).
