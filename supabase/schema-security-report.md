# Security report do baseline (2026-05-24)

Subproduto da montagem do baseline. **Inventário, não correção** — cada item é um follow-up potencial (mexer muda comportamento de produção; decidir caso a caso, como foi feito com as guardas do SLA).

## ✅ Limpo
- **SECURITY DEFINER sem `SET search_path`: 0.** Todas as 40 funções `SECURITY DEFINER` têm `SET search_path` no header. Sem o vetor clássico de search_path hijacking.
- **`OWNER TO` / `CREATE ROLE` / secrets do vault materializados: 0** no dump.

## ⚠️ Para revisar (follow-ups)

### 1. Views sem `security_invoker` (bypassam RLS)
3 das 37 views NÃO têm `WITH (security_invoker=on)` → rodam com privilégios do owner, ignorando a RLS do usuário chamador:
- `public.score_recalc_pending`
- `public.v_oportunidade_economica_hoje`
- `public.visit_score_recalc_pending`

Pode ser intencional (views auxiliares de batch jobs), mas vale confirmar. Fix (se proceder): `ALTER VIEW ... SET (security_invoker = on)` — mesma natureza do trabalho do PR #233.

### 2. Credencial hardcoded em cron
O cron `sayerlack-portal-watchdog` embute um **JWT anon** literal nos headers `Authorization`/`apikey` do `net.http_post` (os outros 32 crons usam `(SELECT decrypted_secret FROM vault.decrypted_secrets ...)`). Além de inconsistente, ele usa `current_setting('app.settings.cron_secret', true)` pro `x-cron-secret` em vez do vault. O JWT anon é "público" (vai no bundle do front), mas baked num cron + dump é higiene ruim. Fix: padronizar pro vault como os demais. (No baseline/runbook o cron é recriado por-ambiente com placeholder — não carrega o JWT.)

## A aprofundar (não escaneado nesta passada)
- Policies permissivas (`USING (true)`) e grants `EXECUTE` pra `PUBLIC` — auditoria mais profunda fica como follow-up se desejado.
