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

## ✅ Redesenho: publicação em PASSOS curtos (migration `20261111120000`)

**O que mudou.** A troca da foto deixou de ser um UPSERT de 500k linhas numa transação. Cada linha ganhou
`lote_anterior` (o rótulo que tinha antes de a publicação trocá-lo, gravado no MESMO UPDATE), e o "lote em
publicação" P é `public.radar_lote_publicando()` (validado, publicação começada, MAIS NOVO que o vigente V).
A foto de V passa a ser `ultimo_lote = ANY(ARRAY[V, P]) AND (ultimo_lote = V OR lote_anterior = V)`: durante a
publicação isso é exatamente a foto velha (rótulo V intocado + rótulo P vindo de V), sem a empresa nova
(rótulo P, anterior NULL) nem a que volta ao dump (rótulo P, anterior < V). A virada é UMA linha de
`radar_ingest_state` (`complete`): no mesmo snapshot V := P, P := NULL, e a foto vira B inteira.

| Peça | O que faz |
|---|---|
| `CALL public.radar_carga_publicar()` (cron `radar-publicar-lote`, `*/15 0-5,7-23`) | procedure INVOKER sem `SET` (as duas coisas proíbem COMMIT), trava advisory de SESSÃO, laço de passos com COMMIT, orçamento 8 min/tick, lote adaptativo (começa em 500, mira ~1 s, teto 3.000) |
| `radar_carga_publicar_passo()` | reivindicar (espera score/agregado em voo; re-run só com membresia IGUAL) → lotes (cursor = último CNPJ examinado; UPDATE só do que difere + INSERT dos novos) → recruzar ja_cliente → virar (conferências só-leitura + a linha `complete`) |
| erros | antes de escrever → `falhou`; depois → segue em publicação com `carga_erro`/`carga_tentativas` e o tick seguinte retoma (a foto segue coerente porque P continua valendo); `query_canceled` em ramo próprio; lock/deadlock → adiado |
| leitores | `radar_lista` e `radar_contagem_por_municipio` (STABLE = 1 snapshot) usam o predicado e escondem a nova sem filtro de lote; `radar_agregado_recalcular`, `radar_score_recalcular`, `radar_avisar_lote` esperam a virada; `radar_coorte_sortear` recusa; `radar_carga_iniciar` zera o progresso da publicação anterior do mesmo lote |
| front | `rotuloEfetivo`/`fotoPostgrest`/`lotePublicando` (`src/lib/radar/lote-vigente.ts`) nas 3 leituras diretas (inéditos, sugeridos, ranking de sugeridos) e nos selos |

- `publicando` não é valor novo de `carga_fase` (alargar o CHECK pediria DROP CONSTRAINT): é `validada` +
  `carga_publicacao_iniciada_em`. Por isso `radar_carga_iniciar` já recusa carga nova no meio — o staging fica imutável.
- 2ª opinião Codex (desenho, 2026-11-08, gpt-6-astra high, 159 s): aprovou o núcleo do mês novo; os ALTOs viraram
  desenho — re-run só com membresia igual (3), `publicando` bloqueia tudo com trava de SESSÃO (4), predicado e P no
  mesmo snapshot (2), claim espera score/agregado (MÉDIO 5). Recomendou trocar para membresia por geração + view
  compatível; **não adotado**: a view no lugar da tabela muda o que PostgREST, Realtime, `SETOF radar_empresas` e
  as escritas do vendedor enxergam, e nem ela resolve o V em cache do cliente.
- **Residual aceito (Codex ALTO 1):** build ANTIGO do PWA nas 3 leituras diretas (`.eq('ultimo_lote', V)`) vê a foto
  encolher durante a publicação (só enquanto P existe; segunda ~04:00 BRT; RPCs corrigem até o build antigo,
  porque recebem V e expandem no servidor). O front novo usa o rótulo efetivo.

**Prova de correção** `db/test-radar-publicacao-curta.sh` (núcleo do CI): 41 asserts — a cada passo comitado a
lista/contagem devolvem exatamente a foto A, sem filtro a nova não aparece, jobs esperam, erro e 57014 no meio não
viram `falhou`, CALL vira de uma vez, re-run só com membresia igual, ACL. `--falsificar` 12/12 vermelhas, verde
em `C` e `pt_BR.UTF-8`.

**Prova de CUSTO** `db/test-radar-publicacao-curta-custo.sh` (à mão, fora do CI): DDL real de prod
(`db/fixtures/radar-empresas-ddl-prod-20261108.sql`, 24 índices — 4 GIN) × distribuição real de rótulos, mês
novo com 506.049 linhas (494k que ficam, 10k novas, 2k que voltam), CALL real com vendedor concorrente:

| medida (PG17 na M2, 2026-11-08) | 1ª rodada (teto 5.000) | final (500 → ~1 s, teto 3.000) |
|---|---|---|
| publicação inteira (1 tick) | 91 s | **56 s** (antes: > 30 min sem terminar, numa transação) |
| maior transação COM xid (lock de linha / Realtime) | 4,1 s | **1,54 s** (171 transações; 1 acima de 1,5 s) |
| espera do vendedor concorrente (UPDATE de 1 linha, 20/s) | máx 1,05 s | p99 0,027 s · **máx 0,17 s** · 0 erro |
| foto vigente amostrada NO MEIO da publicação | 25 × 503.929 | **16 × 503.929** (nunca encolheu) |
| WAL · tabela+índices | 3,9 GB · 628 → 1.038 MB | 3,9 GB · 628 → 1.037 MB |

O WAL (~7,7 KB por linha reescrita, 24 índices) e o inchaço são o custo do rótulo por linha — iguais ao
desenho antigo, só que espalhados em ~170 transações curtas. A prod é mais lenta que o Mac (o UPSERT de uma
transação passou de 30 min lá): o lote adaptativo encolhe sozinho até 50 linhas, e o orçamento de 8 min por
tick retoma no seguinte.

**Lições.**
- **Foto por rótulo + publicação fatiada pede o rótulo de ORIGEM na própria linha** — fatiar com o predicado
  antigo tiraria empresas da foto a cada lote comitado; o `lote_anterior` gravado no mesmo UPDATE é o que deixa a
  troca ser incremental e a virada continuar sendo uma linha.
- **Progresso persistido precisa ser zerado por quem RECOMEÇA, não só por quem termina:** a prova pegou que um
  re-run do mesmo lote herdava `varrida/recruzada` da publicação anterior e o passo ia direto à virada sem
  processar nada (`G1/G2` vermelhos antes do conserto em `radar_carga_iniciar`).
- **"Maior transação" se mede por xid, não por `xact_start`:** a parte só-leitura de um passo (contagens da virada)
  não trava linha nem Realtime; o que trava é o tempo com xid vivo. O amostrador separa as duas.

### No ar (2026-11-08, PR #3752)

- **Migration aplicada pela sessão** com `bun run db:aplicar db/2026-11-08-radar-publicacao-curta.sql`, a cópia sem
  envelope da migration (o executor lê os bytes commitados; nada transcrito no chat). Ensaio com ROLLBACK verde,
  recibo #1021, reaplicado como #1025 com a postcondição P2 em `IS DISTINCT FROM` (fiscal
  `assert-verde-por-ausencia`). Os corpos não mudaram. A 2ª testemunha, por psql-ro, conferiu o md5(prosrc) dos 11
  corpos igual ao do arquivo, `lote_anterior` presente, ACL (passo/procedure só do owner; P para authenticated e
  não para anon) e o cron 279 com `CALL public.radar_carga_publicar()`.
- **Religado** com `db/2026-11-08-radar-publicacao-religar.sql` (recibo #1023): o 2026-10 marcado `falhou` pela
  contenção voltou a `validada` (staging intacto, 0 diferenças de cadastro, mesma membresia = re-run) e
  `cron.alter_job(279, active := true)`.
- **1ª publicação real:** o tick das 22:00 reivindicou às 22:00:10 e virou às 22:01:23 (73 s). Examinou 503.929
  linhas, regravou 0, deixou `complete/publicada`, total 503.929, novos 8.587, foto 503.929, staging vazio e ledger
  `radar.publicar_lote` com `sucesso`. Em `cron.job_run_details` ficou `succeeded`, e nenhuma sessão esperou atrás
  do cron (`pg_blocking_pids`, amostrado a cada 15 s).
- **Falta medir:** a 1ª publicação de um MÊS NOVO em prod (rótulo trocado em ~490k linhas). Ela vem com a carga
  mensal de segunda. Conferir `carga_gravadas`, `carga_tentativas`, o tempo entre `carga_publicacao_iniciada_em`
  e `carga_publicada_em` e o ledger.
- **Publish do front** (rótulo efetivo nas 3 leituras diretas) pela sessão, via MCP, depois do merge.

## Pacote K1 — erro transitório num chunk não derruba mais a carga (edge `v1.8-chunk-recuperavel`, 2026-11-08)

- **O bug (3ª revisão Codex+Fable):** o catch geral da edge chamava `radar_carga_falhar` para QUALQUER ação com
  `mes`, inclusive `chunk`. Um 5xx transitório num chunk punha a carga em `falhou`, `radar_carga_receber` passava a
  recusar o lote (`RCARGA_LOTE_FECHADO`) e as 4 tentativas do loader morriam a partir da 2ª — a carga inteira caía
  por um soluço de rede.
- **Desenho:** todo erro da edge é RECUPERÁVEL para o chamador (chunk = upsert por `(lote, cnpj)`; finalize repetido
  devolve o veredito gravado). Quem sabe que desistiu é a CARGA: `scripts/radar/ingest-cliente.ts` re-tenta e, ao
  esgotar as tentativas com o lote aberto (entre `begin_lote` e o `finalize`), declara a nova ação `falhar`
  (best-effort, uma vez) e relança o erro original. Depois do finalize, falha de concorrentes/sócios não toca o lote.
  Carga que morre sem declarar (processo morto) fica `recebendo` — é o caso do sensor de carga parada (K3).
- **Prova:** `scripts/radar/ingest-cliente.test.ts` (edge falsa com o protocolo da staging): transitório → repetição
  → lote validado [K1]; o controle [K2] reproduz a v1.7 e a MESMA carga morre em `RCARGA_LOTE_FECHADO`; desistência
  declara `falhar` uma vez [K3]. Texto da edge: `[E7]` em `radar-ingest-situacao.test.ts`. Falsificado (cliente sem
  declarar → K3 vermelho; catch voltando a marcar → E7 vermelho; sem `fecharLote` → E7 vermelho).
- **Sem migration:** `radar_carga_falhar` já existia e já só fecha lote `recebendo`.
