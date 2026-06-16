# Security report do baseline (2026-05-24)

Subproduto da montagem do baseline. **Inventário, não correção** — cada item é um follow-up potencial (mexer muda comportamento de produção; decidir caso a caso, como foi feito com as guardas do SLA).

## ✅ Limpo
- **SECURITY DEFINER sem `SET search_path`: 0.** Todas as 40 funções `SECURITY DEFINER` têm `SET search_path` no header. Sem o vetor clássico de search_path hijacking.
- **`OWNER TO` / `CREATE ROLE` / secrets do vault materializados: 0** no dump.

## ⚠️ Para revisar (follow-ups) — itens 1 e 2 RESOLVIDOS em 2026-05-27

### 1. Views sem `security_invoker` (bypassam RLS) — ✅ RESOLVIDO
3 das 37 views NÃO têm `WITH (security_invoker=on)` → rodam com privilégios do owner, ignorando a RLS do usuário chamador:
- `public.score_recalc_pending`
- `public.v_oportunidade_economica_hoje`
- `public.visit_score_recalc_pending`

Pode ser intencional (views auxiliares de batch jobs), mas vale confirmar. Fix (se proceder): `ALTER VIEW ... SET (security_invoker = on)` — mesma natureza do trabalho do PR #233.

**✅ RESOLVIDO (2026-05-27, PR #344 — migration `20260526060000_views_security_invoker_hardening.sql`).** As 3 viraram `security_invoker=on`. Investigado caso-a-caso: `score_recalc_pending`/`visit_score_recalc_pending` são consumidas só por edge functions (service_role bypassa RLS → inalteradas), zero consumidor frontend; `v_oportunidade_economica_hoje` tem cadeia 100% staff-readable (3 sub-views já invoker-on; bases `promocao_*`/`sku_parametros` = "Staff vê") e consumidores staff-gated (badge AppShell `isStaff && !isSalesOnly`, cockpit Reposição) → neutro pra staff, fecha o bypass de não-staff. Aplicado + validado em prod (`reloptions` das 3 com `security_invoker=on`).

### 2. Credencial hardcoded em cron — ✅ RESOLVIDO
O cron `sayerlack-portal-watchdog` embute um **JWT anon** literal nos headers `Authorization`/`apikey` do `net.http_post` (os outros 32 crons usam `(SELECT decrypted_secret FROM vault.decrypted_secrets ...)`). Além de inconsistente, ele usa `current_setting('app.settings.cron_secret', true)` pro `x-cron-secret` em vez do vault. O JWT anon é "público" (vai no bundle do front), mas baked num cron + dump é higiene ruim. Fix: padronizar pro vault como os demais. (No baseline/runbook o cron é recriado por-ambiente com placeholder — não carrega o JWT.)

**✅ RESOLVIDO (2026-05-27, PR #350 — migration `20260526080000_fix_sayerlack_cron_vault.sql`).** Dump real do `cron.job` (2026-05-26) mostrou que o `x-cron-secret` **já vinha do Vault** (a parte do GUC já tinha sido consertada antes); restava só o JWT anon nos headers, que existia pra passar o `verify_jwt` do gateway. Fix em 2 partes: (1) `verify_jwt = false` declarado em `supabase/config.toml` + redeploy no Lovable (a função se gateia via `x-cron-secret` no `authorizeCronOrStaff`, não precisa do JWT no gateway); (2) `cron.schedule` recolado sem `Authorization`/`apikey`. Validado em prod: cron limpo (sem JWT, x-cron-secret do Vault) + `net._http_response` com **200** nos ciclos `*/5`, sem 401.

## A aprofundar — ✅ AUDITADO 2026-05-27 (RLS limpo; grant audit achou+corrigiu 1 IDOR anon)

**Policies `USING (true)` — auditado, sem vulnerabilidade de RLS.** 28 `USING(true)` + 11 `WITH CHECK(true)` no dump:
- Os 11 `WITH CHECK(true)` são **todos** `FOR ALL TO service_role` (redundante — service_role já bypassa RLS) → **zero furo de escrita** pra anon/authenticated.
- 6 SELECT público (anon): catálogo de storefront (`tool_categories`, `default_prices`, `category_mappings`, `omie_servicos`, `training_modules`, `tool_specifications`) — público por design.
- 11 SELECT `authenticated`: referência (`omie_products`, `warehouses`, `tint_*`) que o wizard de pedido (`UnifiedOrder`/`SalesOrderEdit` via `useTintColorSelect`/`useTintPricing`) precisa ler. Consumidores verificados — justificado.

**Decisões (eu + codex consult, 2026-05-27):**
- `default_prices` legível por anon → **DEIXAR** (catálogo público intencional; preço default já observável por UI/orçamento). Não apertar (quebraria storefront pré-login).
- `tint_formula_itens` (proporções de corante = receita/IP) legível por qualquer logado → **decisão de produto (Lucas, 2026-05-27): a receita É segredo a proteger.** Threat model real (concorrente/scraper cria conta de cliente → lê a tabela → reconstrói a base de receitas). Fix = RPC `SECURITY DEFINER` (preço-só pro cliente, breakdown completo pro staff) + restringir o SELECT da tabela a staff. **NÃO feito ainda** (toca o money-path de precificação no wizard de pedido → exige passe próprio com TDD). **Spec pronto pra executar a frio:** [`docs/superpowers/specs/2026-05-27-tint-recipe-hardening-design.md`](superpowers/specs/2026-05-27-tint-recipe-hardening-design.md) (inclui o Passo 0: verificar se a UI já mostra o breakdown ao cliente).

**✅ RODADO (2026-05-27) — ACHOU + CORRIGIU 1 furo real (PR fix `20260527140000`).** A query de EXECUTE por role (o dump é `--no-privileges`, não mostra grants) revelou que **`_carteira_mixgap_for_owner(uuid)`** e **`_carteira_positivacao_for_owner(uuid)`** estavam **executáveis por `anon`**. São internals SECDEF do view-as que usam `p_owner` DIRETO, sem gate (o gate vive nos wrappers `get_meu_*_for`, master-only). A migration de criação (`20260525210000`) fez `REVOKE ... FROM PUBLIC, authenticated` mas **não de `anon`** (no Supabase `anon` tem grant EXPLÍCITO que `FROM PUBLIC` não remove). **IDOR não-autenticado:** um anônimo podia `POST /rest/v1/rpc/_carteira_mixgap_for_owner {"p_owner":"<uuid>"}` e puxar a carteira de qualquer dono. **Fix:** `20260527140000_revoke_carteira_internals_anon.sql` (`REVOKE ... FROM anon, authenticated, PUBLIC`; wrappers seguem OK pois SECDEF executa como owner). Resto do resultado = esperado: os wrappers SECDEF de carteira/financeiro (`*_for`, `get_minha_*`, `fin_*`) têm anon+authenticated por default do Supabase mas **se auto-gateiam** por `auth.uid()`/master no corpo (anon → null → rejeita); triggers/aggregates pgvector são inofensivos.

Query usada (re-rodável p/ re-auditar):

```sql
SELECT n.nspname AS schema, p.proname AS function, p.prosecdef AS security_definer,
       pg_get_function_identity_arguments(p.oid) AS args,
       array_agg(DISTINCT r.rolname ORDER BY r.rolname) AS executable_by
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a ON true
LEFT JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND a.privilege_type = 'EXECUTE'
GROUP BY n.nspname, p.proname, p.prosecdef, p.oid
ORDER BY p.prosecdef DESC, n.nspname, p.proname;
```
Olhar as linhas com `security_definer = true` cujo `executable_by` inclua `anon`/`authenticated` e que façam algo privilegiado (mutação ampla, acesso a dados de outros tenants). As RPCs SECDEF de carteira (`*_for`, `get_minha_*`) já são gated por `auth.uid()`/master no corpo — essas são esperadas.
