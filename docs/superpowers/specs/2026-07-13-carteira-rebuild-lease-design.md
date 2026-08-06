# carteira-rebuild — lease anti-intercalação (fecha o mosaico de dois writers)

> Data: 2026-07-13 · money-path (carteira/positivação) · segue `docs/agent/money-path.md`
> Status: **IMPLEMENTADO, PROVADO e ENDURECIDO** (PG17 **31/31** verde: lease + RLS + idempotência +
> concorrência robusta + 3 falsificações; `deno check`/`eslint`/`shellcheck` OK). Codex consult (metodologia,
> "A com condições") + challenge (código, **2 P1 + P2 achados e CORRIGIDOS** — ver §Hardening); re-challenge
> em curso. Deploy pendente (handoff drenado).
>
> Artefatos: `supabase/migrations/20260713160000_carteira_rebuild_lease.sql` ·
> `supabase/functions/carteira-rebuild/index.ts` · `db/test-carteira-rebuild-lease.sh`.

## Problema

`supabase/functions/carteira-rebuild/index.ts` reconstrói `carteira_assignments` (6.909 linhas, 1:1 com
o espelho `omie_clientes`) lendo 3 snapshots, computando em TS (helper account-safe, 4 invariantes já em
prod) e fazendo **upsert por chunks de 500 via PostgREST** (`index.ts:357-362`), SEM lease e SEM
transação de conjunto.

**Furo (P2, classificado por gpt-5.6-sol em 2026-07-13, adiado; este é o follow-up):** dois runs
concorrentes (cron `carteira-rebuild-nightly` 30 7 × disparo manual staff, ou 2 manuais) podem
intercalar chunks de **snapshots diferentes** → carteira em "mosaico". Só um próximo run limpo conserta.
Os 4 guards barram carteira degenerada/100%-Hunter, mas NÃO a intercalação. (O outro cron de carteira,
`carteira-positivacao-snapshot-mensal`, escreve `carteira_positivacao_snapshot`, não `carteira_assignments`.)

## Descoberta técnica (reorienta a "opção a" literal da tarefa)

`pg_try_advisory_lock` **de sessão** no handler é inseguro aqui: **toda escrita da edge é via PostgREST**,
que não dá afinidade de conexão — o lock de sessão pode ser liberado por outra conexão do pool ou ficar
preso numa conexão reciclada e vazar. O repo usa lease row-based via `sync_state`
(`claim_estoque_full_sync`/`finalizar_estoque_full_sync`) — é esse padrão que espelhamos.

## Restrições

1. **Triggers em `carteira_assignments`:** `trg_carteira_reconcile_score_owner` (AFTER INSERT/UPDATE OF
   owner) e `trg_carteira_cleanup_orphan_score` (AFTER DELETE) ⇒ swap `DELETE+INSERT` dispara cleanup em
   massa. Qualquer B tem de ser **upsert-em-massa** (sem DELETE). O design atual nunca deleta.
2. **Fencing por plataforma:** edge morto pelo wall-clock (150s Free / 400s pago, não-configurável;
   `waitUntil` não amplia). TTL do lease **15min (900s) > 400s** ⇒ nenhum run **vivo** tem o lease
   roubado. ⚠️ `service_role` (a edge) **não tem `statement_timeout`** (confirmado via psql-ro) — o teto
   efetivo é o wall-clock do edge, não o timeout de 60s do PostgREST. Rebuild dura ~segundos (~14 chunks).
3. **Consumidores toleram a janela parcial p/ ESTE ticket, mas ela NÃO é estritamente benigna** (Codex #4):
   RLS `carteira_visivel_para` muda acesso por-chunk; `get_minha_positivacao()` pode ver prefixo-novo +
   sufixo-antigo; paginação frontend multi-request pode montar lista mista; `carteira_positivacao_snapshot`
   pode **materializar** donos mistos se rodar durante o rebuild. `farmer_client_scores` e
   `criar_plano_tatico` são consistentes por-cliente (trigger na mesma tx / `FOR UPDATE`). ⇒ **atomicidade
   observável de leitura é um requisito SEPARADO** (versionamento por geração / leitura em RPC única);
   B não a resolve para leitores paginados. Fora do escopo deste ticket.

## Decisão: **A** (lease via `sync_state`) — selada pelo Codex

O furo classificado é a intercalação **rebuild × rebuild**; A elimina isso enquanto o lease é válido,
custo mínimo, padrão confiado, robusto ao pooler. Formulação honesta (correção do Codex #1): **A elimina
100% da intercalação entre invocações lease-aware enquanto o lease é válido** — não é fencing formal
contra writers antigos/não-cooperativos. B/C não se justificam para este P2.

## Design da opção A (com as condições do Codex)

### Migration `supabase/migrations/<ts>_carteira_rebuild_lease.sql` — 2 RPCs
- `claim_carteira_rebuild(p_run_id text) RETURNS boolean` — chave **`carteira_rebuild`/`global` e TTL 15min
  HARDCODED na RPC** (Codex #6/#1: sem parâmetro `account`; nada de outra conta abrir outro lease na mesma
  tabela). Usa **`now()` do Postgres** para gravar e comparar idade (Codex #1: relógio do banco, não
  `p_at` da edge — imune a clock skew). `INSERT … ON CONFLICT (entity_type,account) DO UPDATE … WHERE
  status IS DISTINCT FROM 'syncing' OR last_sync_at IS NULL OR last_sync_at < now()-interval '15 minutes'
  RETURNING true`.
- `finalizar_carteira_rebuild(p_run_id text, p_status text) RETURNS boolean` — `UPDATE … WHERE … status=
  'syncing' AND metadata->>'run_id'=p_run_id RETURNING true` (ownership).
- Ambas `SECURITY DEFINER`, `search_path=public,pg_temp`, `REVOKE … FROM PUBLIC, anon, authenticated`,
  `GRANT EXECUTE … TO service_role`. Validação pós-apply read-only.

### Edge (`carteira-rebuild/index.ts`)
1. `run_id = crypto.randomUUID()` (Codex #1: **não** `Date.now()` — evita colisão de run_id).
2. **Claim OBRIGATORIAMENTE após `authorizeCronOrStaff`, ANTES de qualquer snapshot/baseline** (Codex #5:
   a opção "só antes do upsert" tem TOCTOU semântico — dois runs leriam baselines diferentes e o mais
   lento sobrescreveria o mais novo, burlando a catraca do baseline). `claim=false` → **409 fail-closed**,
   sem ler nem escrever.
3. **Finalize honesto** (Codex #3 — NÃO best-effort silencioso como o baseline):
   - `await` sempre; finalize **imediato** em todo caminho de saída pós-claim (inclusive aborts de guard).
   - retorno `true` = ok; retorno **`false` = perda de ownership = incidente** (`console.error`, não warn).
   - **erro de transporte** no finalize após o upsert ter commitado → resposta honesta **503** com
     `{writes_committed:true, finalize:'unknown'}` + `console.error`; retry curto (idempotente p/ o mesmo
     run_id) antes de desistir. O lease auto-expira em 15min (fail-closed; **sem** force-release, **sem**
     reduzir TTL).

### Rollout com quiescência (Codex #7 — migration-antes-da-edge NÃO basta)
O cutover tem janela onde a edge velha (sem lease) e a nova (com lease) coexistem. Handoff:
1. desabilitar `carteira-rebuild-nightly` temporariamente + não disparar manual;
2. aplicar a migration (SQL Editor) e testar as RPCs;
3. **drenar** edge velha + cauda PostgREST (~8min dá margem sobre 400s+60s);
4. publicar a edge nova (chat Lovable, verbatim);
5. testar claim concorrente (2 disparos → um 409);
6. reativar o cron.
Rollback p/ código sem lease exige a MESMA drenagem.

### Gate de deploy (Codex — verificações que ele não pôde rodar; EU confirmei)
- Registros: **6.909** (psql-ro ✓). Timeout PostgREST: `service_role` sem statement_timeout, wall-clock do
  edge é o teto (✓, ver Restrição 2). Reconfirmar no dia do deploy se algo mudou.

## Prova (money-path) — reforçada pelo Codex

`db/test-carteira-rebuild-lease.sh` (PG17), além do espelho de `db/test-claim-full-sync.sh` (claim livre;
'syncing' fresco→false; stale >15min→true; finalize dono→true; alheio→false; não-'syncing'→false; REVOKE
anon/GRANT service_role), acrescenta (Codex #8 — o teste sequencial não basta):
- **concorrência real:** dois claims em sessões psql simultâneas → **exatamente um** `true`;
- **clock skew:** idade calculada com `now()` do banco resiste a `p_*` divergente da edge;
- **finalize idempotente** p/ o mesmo run_id;
- **Falsificação:** sabotar o `WHERE` do claim → o assert "claim fresco = false" fica VERMELHO.

Edge: `deno check` + revisão (a edge orquestra `supabase.rpc`; a lógica vive nas RPCs provadas no PG17).

## Hardening pós-challenge do Codex (2 P1 + P2 corrigidos)

- **[P1] Adulteração direta do lease.** `sync_state` dá DML a `authenticated`/`anon` (grant) + policy
  permissiva `"Staff can manage sync state"` sem filtro por `entity_type` → um employee faria `UPDATE
  sync_state SET status='complete'` e furaria a exclusão. **Fix:** 3 policies **RESTRICTIVE**
  (`no_insert`/`no_update`/`no_delete`, `entity_type <> 'carteira_rebuild'`). `service_role` é BYPASSRLS
  (confirmado, `rolbypassrls=t`) e as RPCs são SECURITY DEFINER (owner bypassa) → escrevem normal; staff
  fica barrado da linha do lease. Furo do padrão `sync_state` em outras chaves (estoque) = **dívida separada**.
- **[P1] Finalize não-idempotente.** Retry após resposta HTTP perdida acusava falso ownership-lost. **Fix:**
  `finalizar` aceita re-finalize do mesmo run (`status=p_status AND fase='fim'`), mantendo ownership por
  `run_id`. `complete` posto por fora (`fase='inicio'`) não re-finaliza.
- **P2:** validação (`p_run_id` vazio→22004, `p_status ∉ {complete,error}`→22023); edge — `leaseReleased`
  marca só no sucesso; `'ownership'` no fim → **500** `integrity:'unknown'` (fencing quebrado, não
  retentável) distinto de `'transport'` → **503**; upsert parcial → `{writes_committed, partial, upserted}`.
### Re-challenge (GATE FAIL → corrigido)
- **[P1] Regressão de branch stale:** a edge revertia a fonte de membership `omie_clientes`→`carteira_membership_ledger` já corrigida na `main` (PR #1329). **Fix:** rebase sobre `origin/main`, preservando o ledger + o lease.
- **[P2] `p_status=NULL` escapava** (`NULL NOT IN` = NULL) → `IF p_status IS NULL OR p_status NOT IN (...)`.
- **[P2] Caminho de upsert parcial** não propagava `releaseLease` → agora distingue ownership(500)/transport(503); **retry idempotente do chunk** (mitiga mosaico por erro transitório).
- **Hardening:** `REVOKE TRUNCATE` (não passa por RLS). Viabilidade confirmada via psql-ro: owner das RPCs = `postgres` BYPASSRLS, `sync_state` FORCE RLS off → a RPC bypassa a própria policy.

- **Prova:** PG17 **34/34** — RLS (employee barrado de U/I/D / cirúrgico), idempotência (D8), validação (status inválido + **NULL**), concorrência robusta (0 workers falham, 1t/7f), REVOKE de `authenticated`, e **3 falsificações**.

## Rollback
Reverter o deploy da edge (com a drenagem do rollout). RPCs/policies podem ficar inertes. Sem migration de dados.

## Finding SEPARADO obrigatório (Codex #8) — NÃO fecha neste ticket
Writers de `carteira_assignments.eligible` fora do lease: `aplicar_exclusao_fornecedores()` (roda no cron
nightly, `UPDATE … eligible=false`) e `reverter_exclusao_fornecedor()` (master, `UPDATE … eligible`).
Cenário: rebuild lê `flaggeds` → RPC muda `eligible` → rebuild grava depois com snapshot antigo →
sobrescreve a decisão. **A fecha rebuild × rebuild; NÃO declarar "carteira tem writer único" até coordenar
essas RPCs** (ambas derivam de `cliente_classificacao.excluir_da_carteira`, então convergem no fim — o
risco é a janela transitória). Recomendação de escopo (Claude): **dívida v2 separada**, não expande este
ticket (é pré-existente; A não o piora). Decisão de inclusão = do founder.
