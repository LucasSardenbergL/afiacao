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

## A aprofundar (não escaneado nesta passada)
- Policies permissivas (`USING (true)`) e grants `EXECUTE` pra `PUBLIC` — auditoria mais profunda fica como follow-up se desejado.
