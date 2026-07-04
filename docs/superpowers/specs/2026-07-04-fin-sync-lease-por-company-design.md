# Lease por company no `omie-financeiro` — design (achado P1 Codex, 2026-07-04)

## Problema (achado + PROVA empírica)

`sync.md` (armadilha 1 do backfill): **invocações concorrentes na MESMA conta Omie = rate-limit
FATAL e SILENCIOSO** → `callOmie` esgota retries, retorna `null`, a edge trata como "página vazia =
fim" e responde `{synced:0, complete:false}` MAS grava `status=complete` no `fin_sync_log` — MENTE
conclusão com 0 sincronizados (recebíveis/DRE/caixa congelam sem alerta).

Rate-limit do Omie é **por conta** (= por company; cada company tem app_key própria). Hoje NÃO há
single-flight por conta: kickoffs por-entidade (`fin-sync-cp/cr/mov-2x`, escalonados) + continuação
de cursor (`fin-sync-continuacao-10min` `*/10`) + retry de kick perdido (`fin_sync_tick`, PR irmão)
podem disparar `sync_contas_*`/`sync_movimentacoes` da MESMA company ao mesmo tempo.

**Provado em prod (fin_sync_log, 2026-07-04):**
- `sync_contas_receber` colacor 08:50:04→08:50:20 **sobrepondo** `sync_movimentacoes` colacor
  08:50:06→08:50:41 — concorrentes na conta colacor, ambos `complete`.
- `sync_contas_pagar` colacor 10:10:05→10:10:16 **sobrepondo** `sync_movimentacoes` 10:10:04→10:10:37.
- A continuação `*/10` roda mov colacor quase todo tick (cursor sempre pendente) → overlap frequente.

## Invariante alvo

**No máximo 1 invocação viva do `omie-financeiro` fazendo enumeração pesada por conta Omie (company).**
Contas distintas seguem em paralelo (independentes). Quem não adquire o lease **termina como
`skipped_busy`, NUNCA `complete`** (não mente conclusão) e **preserva o cursor** (trabalho adiado,
não perdido — a continuação `*/10` retoma).

**Por que o lease vai na EDGE, não nos crons (guard na fronteira — money-path #5):** os 3 invocadores
(`fin-sync-cp/cr/mov-2x`, `fin-sync-continuacao-10min`, e o **`fin_sync_retry_tick` do #1166** —
mergeado em `main` durante esta sessão) chamam a MESMA edge com `{action:'sync_<resource>', company}`.
O lease na edge cobre os TRÊS automaticamente — confirmado lendo `20260704102000` linha 197
(`net.http_post ... body:=jsonb_build_object('action','sync_'||resource,'company',company)`). Proteção
por-cron (ex.: DISTINCT ON num cron) deixaria o retry tick descoberto.

## Design

Espelha o padrão da casa `vendas_sync_cursor` (migration `20260617133633`): lease atômico via **RPC
SQL-pura** (`.or()` em UPDATE do PostgREST quebra 42703 — CLAUDE.md), `SECURITY DEFINER` + `search_path`
pinado, gate na fronteira via `REVOKE`/`GRANT service_role`, provável no PG17 antes de produção.

**Diferença estrutural chave vs vendas:** o lease é **por company** (conta), NÃO por `(company,resource)`.
Reusar `fin_sync_cursor` (granularidade company+resource) daria leases distintos p/ cp e cr da mesma
company → não se bloqueariam. Logo: **tabela dedicada `fin_sync_lease` com `company` como PK** (3 linhas).

### 1. Tabela `fin_sync_lease`
```sql
CREATE TABLE public.fin_sync_lease (
  company     text PRIMARY KEY CHECK (company IN ('oben','colacor','colacor_sc')),
  token       uuid NOT NULL,
  holder      text,                                  -- logId da invocação (observabilidade)
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,                  -- livre quando expires_at <= now()
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```
RLS espelha `fin_sync_cursor` (staff SELECT, service_role ALL).

### 2. RPCs (SQL puro, SECURITY DEFINER, grant só service_role)
```sql
-- acquire: token uuid se adquiriu; NULL se busy. Atômico via ON CONFLICT ... WHERE.
CREATE FUNCTION public.fin_sync_lease_acquire(p_company text, p_holder text, p_ttl_seconds int DEFAULT 300)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO public.fin_sync_lease AS l (company, token, holder, acquired_at, expires_at, updated_at)
  VALUES (p_company, gen_random_uuid(), p_holder, now(), now() + make_interval(secs => p_ttl_seconds), now())
  ON CONFLICT (company) DO UPDATE
    SET token = gen_random_uuid(), holder = EXCLUDED.holder, acquired_at = now(),
        expires_at = now() + make_interval(secs => p_ttl_seconds), updated_at = now()
    WHERE l.expires_at <= now()            -- só rouba se o lease atual EXPIROU
  RETURNING token;                          -- NULL quando a WHERE bloqueia (busy)

-- release: token-guarded. Só libera se o token é o meu (não roubado). Retorna se liberou.
CREATE FUNCTION public.fin_sync_lease_release(p_company text, p_token uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH freed AS (
    UPDATE public.fin_sync_lease SET expires_at = now() - interval '1 second', updated_at = now()
     WHERE company = p_company AND token = p_token
    RETURNING company)
  SELECT EXISTS (SELECT 1 FROM freed);
$$;
```
**TTL = 300s.** Budget interno da edge é 100s (`TIME_BUDGET_MS`); kill duro da plataforma 150s →
uma invocação legítima nunca passa de ~150s << 300s (nunca expira no meio). Se a edge crashar sem
liberar, o lease auto-expira em ≤300s → a continuação `*/10` perde no máx ~meio ciclo. Sem heartbeat
(o progresso já é persistido pelo `writeCursor` existente; simplicidade).

⚠️ **Pós-Codex (invariante do TTL):** o TTL 300s só é são se A morre antes dos 300s. Hoje `callOmie`
NÃO tem timeout de fetch → um fetch pendurado deixaria A vivo além do TTL → B roubaria → concorrência
(o token-guard do release protege o lease, mas NÃO impede A de continuar batendo no Omie). Correção
obrigatória: **`AbortSignal.timeout(30_000)` no fetch do `callOmie`** (abaixo do budget) → nenhum
request pendura → A termina em ≤~130s < TTL. Fecha o buraco "steal enquanto A vivo". O AbortError já
cai no catch de rede do `callOmie` (tratado como transitório, com retry).

### 3. CHECK constraint do status (OBRIGATÓRIO)
`fin_sync_log_status_check` hoje = `CHECK (status IN ('running','complete','error'))` → gravar
`skipped_busy` FALHA (23514). Recriar incluindo o valor (ADD-only, linhas existentes seguem válidas):
```sql
ALTER TABLE public.fin_sync_log DROP CONSTRAINT IF EXISTS fin_sync_log_status_check;
ALTER TABLE public.fin_sync_log ADD CONSTRAINT fin_sync_log_status_check
  CHECK (status = ANY (ARRAY['running','complete','error','skipped_busy']));
```

### 4. Edge (`supabase/functions/omie-financeiro/index.ts`)
- Helper `runOmieWithLease(db, company, holder, fn)`: `acquire` → 3 desfechos:
  - **busy** (`data===null`, sem erro) → retorna `{skipped_busy:true}` (NÃO chama Omie, NÃO toca cursor).
  - **erro de RPC** → **1 retry curto**; se persistir → **fail-CLOSED**: retorna `{lease_error:<msg>}`,
    NÃO roda o sync, e a company entra como `error` (o watchdog tail-failing alerta). **Revisão Codex:**
    fail-OPEN (rodar sem lease) re-abriria o buraco de concorrência SILENCIOSAMENTE se a RPC começar a
    falhar (drift de grant/assinatura/função ausente). Money-path: falha da infra de lock deve
    congelar+alertar, não rodar destravado mentindo `complete`.
  - **adquiriu** → roda `fn`, libera no `finally` (token-guarded).
- Envolver com lease SÓ as actions do cluster do achado: **`sync_all`, `sync_contas_pagar`,
  `sync_contas_receber`, `sync_movimentacoes`**. (Ver "Escopo" abaixo.)
- **Log POR COMPANY nas lease actions** (`runLeasedCompanySync`): cada company tem sua própria linha
  `fin_sync_log` com `companies=[co]` e status honesto — `complete` | `skipped_busy` (`completed_at=NULL`,
  invisível p/ os consumidores de frescor) | `error` (lease_error, fail-closed → watchdog alerta).
  ⚠️ **Por quê por-company e não 1 linha/invocação (achado Codex — CRÍTICO, revisto):** numa chamada
  multi-company (`syncAll` das 3 via `useFinanceiro.ts:181`), 1 linha com `companies[]` COMPARTILHADO
  faria a company pulada herdar o `complete` de outra — os consumidores filtram `status='complete' AND
  co=ANY(companies)` → **frescor FALSO da pulada**. Log por-company garante ESTRUTURALMENTE (1 company
  por linha) que ninguém herda status alheio. Non-lease actions (calcular_dre*, cats/cc, debug_raw)
  seguem com 1 linha/invocação (não tocam o lease).
- `completeSync` **não engole erro de update** (Codex #8): logar claro. Se o UPDATE do status falhar
  (ex.: CHECK ainda sem o valor pq migration não aplicada), a linha fica `running` → vira órfã → o
  watchdog varre p/ `error` (fail-safe honesto).

### 5. Cron de continuação — SEM mudança neste PR (Codex #6)
Cogitei `DISTINCT ON (company) ORDER BY updated_at` p/ o cron não disparar 2 resources da mesma company
por tick (reduzir ruído de skipped_busy). **Dropado:** o Codex mostrou starvation — o resource que
sempre perde o lease é `skipped_busy`, NÃO atualiza `updated_at` (não rodou), continua o mais antigo e
é reescolhido eternamente → os outros resources da company starvam. Corrigir exigiria um
`last_attempt_at` separado do progresso do cursor (mais código). **O lease sozinho já serializa**: o
cron segue disparando todos os pendentes; os extras viram `skipped_busy` e retomam via cursor (sem
perda, cada resource é tentado todo tick). O ruído de skipped_busy é o preço aceitável. Otimização →
follow-up.

## Escopo — por que NÃO gatear `sync_categorias` / `sync_contas_correntes`

cats/cc são leves (1-2 págs), rodam só no `fin-sync-base-diario` (06:00), métodos Omie DISTINTOS
entre si e de cp/cr/mov. Gateá-las traz **starvation**: a continuação `*/10` segura o lease da conta
quase todo tick → cats/cc às 06:00 quase sempre colidiriam → `skipped_busy` crônico SEM retomada
(cats/cc não têm cursor) → saldo/classificação congelam por dias, silenciosamente.
Precisão > recall: não gatear evita starvá-las.

**Evidência (fin_sync_cursor prod, 2026-07-04):** `colacor movimentacoes next_page=529` (incremental
normal, sem `backfill_desde`) → a continuação roda mov colacor TODO tick até drenar 529 páginas
(horas/dias). Gatear cats/cc colidiria com ela quase sempre AGORA → starvation concreta, não teórica.

**Divergência consciente do Codex (#2):** o Codex quer proteger o saldo (contas_correntes = money).
Contrapeso: `sync_contas_correntes` **degrada honestamente** hoje — em falha do `ListarExtrato` ele
PRESERVA o saldo anterior (não fabrica; `index.ts:604`) → pior caso ungated = saldo 1 dia velho, não
número inventado (respeita "ausente≠zero"). Gatear cc = starvation (saldo congelado por DIAS) ou
alerta-fadiga (fail-closed vira `error` por mera contenção de lease). **Risco residual aceito e
documentado**; follow-up possível = dar cursor/retomada a cats/cc OU escalonar 06:00 p/ longe da
continuação. `debug_raw` (1 req manual) e `calcular_dre*` (não tocam Omie) também ficam fora.

## Consumidores do status — verificados em prod (psql-ro), por que `skipped_busy` não quebra

Todos filtram por cláusula POSITIVA e explícita; `completed_at=NULL` os torna cegos ao skip:
- `fin_sync_watchdog_check`: sweep de órfã `status='running'` (skip≠running, não vira 'error');
  staleness `status='complete'` (skip não conta → se só houver skip por 18h, alerta stale — CORRETO);
  tail-failing `status IN ('complete','error')` (skip ignorado).
- `_data_health_compute`: lê último log `WHERE completed_at IS NOT NULL` → skip (completed_at NULL)
  é invisível → NÃO fabrica frescor. **É por isso que `completed_at` fica NULL no skip.**
- `fin_calcular_confiabilidade` / `fin_sync_heartbeat`: `WHERE status='complete'` → skip ignorado.
- Hooks UI (`useAlertaCreditoCliente`, `useUtiContas`): `status='complete'` → ignorado.
- `getSyncLogs` (`select *`): mostra skip como texto cru (observabilidade). Sem mapa status→cor que quebre.

## Prova (PG17, prove-sql-money-path) — asserts + falsificação
1. acquire 1ª vez → token não-nulo; 2ª concorrente → NULL (busy); após expirar TTL → rouba (token novo).
2. release token certo → true + acquire volta a funcionar; release token ERRADO (roubado) → false, no-op.
3. CHECK: aceita 'skipped_busy'; rejeita 'lixo' (SQLSTATE 23514 + re-raise).
4. **Falsificar:** remover `WHERE l.expires_at <= now()` do acquire → o assert "busy retorna NULL" fica
   VERMELHO (rouba lease ativo) → prova que o assert tem dente.

## Deploy (ordem)
1. Migration (SQL Editor do Lovable): tabela + RPCs + CHECK + RLS + grants + cron continuação.
2. Edge `omie-financeiro` (chat do Lovable, verbatim do repo pós-merge).
Migration ANTES da edge (a edge nova chama a RPC).

## Veredito do Codex (challenge, `high`, 2026-07-04) + resoluções
NEEDS-REVISION → revisado. Resoluções:
- **(C) Fail-open → FAIL-CLOSED** (a falha mais grave do Codex): erro de RPC persistente → `error`
  (congela+alerta), nunca roda destravado. ✅ incorporado.
- **(B) TTL 300s → + `AbortSignal.timeout(30s)` no fetch** do `callOmie` (garante A morre < TTL).
  ✅ incorporado. Heartbeat descartado (timeout resolve melhor; heartbeat cego em fetch pendurado piora).
- **(D) DISTINCT ON no cron → DROPADO** (starvation edge). Lease sozinho serializa. ✅
- **(E) `completed_at=NULL` no skip → confirmado correto** p/ os consumidores verificados. ✅
- **(#5) Log invocação-level → mantido** (crons single-company) + marcar skip no results. ✅
- **(#8) `completeSync` não engole erro de update** → logar. ✅
- **(A) Escopo cats/cc → NÃO gatear** (divergência consciente, ver "Escopo"; embasada no cursor 529).
- **(#7) Atomicidade do acquire confirmada** → provar corridas no-row/expired/active no PG17.
- **(#9) `sync_all` roda cp/cr/mov sem cursor (parcial→complete)** = bug PRÉ-EXISTENTE, fora de escopo;
  o lease previne overlap mas não o parcial. Follow-up: deprecar sync_all ou fazê-lo despachar as
  actions cursor-aware.
