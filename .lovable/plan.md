## Diagnóstico — Cron jobs vs. funções protegidas (Onda 1)

### 1) Inventário de cron jobs ativos (`cron.job`)

22 jobs encontrados. Os relevantes para esta auditoria:

| jobid | jobname | schedule | função alvo |
|---|---|---|---|
| 14 | `omie-cron-diario-oben` | `0 7 * * *` | **omie-cron-diario** |
| 20 | `disparar-pedidos-aprovados-oben` | `0 13 * * *` | **disparar-pedidos-aprovados** |
| 21 | `gerar-pedidos-diario-oben` | `15 9 * * *` | **gerar-pedidos-diario** |
| — | (nenhum) | — | **enviar-pedido-portal-sayerlack** |

Os demais 19 jobs invocam outras funções (omie-analytics-sync, calculate-scores, omie-sync-estoque/metadados/status-produtos, process-recurring-orders, sync-reprocess, monthly-report, dispatch-notifications, algorithm-a-audit, omie-sync) ou rodam SQL puro — **não fazem parte deste escopo**.

### 2) Estado atual dos headers nos 3 jobs afetados

| jobid | jobname | Authorization | `x-cron-secret` | Status pós-Onda 1 |
|---|---|---|---|---|
| 14 | `omie-cron-diario-oben` | **ausente** | ausente | ❌ vai retornar 401 |
| 20 | `disparar-pedidos-aprovados-oben` | Bearer **ANON_KEY** | ausente | ❌ vai retornar 401 (anon não é staff nem service-role) |
| 21 | `gerar-pedidos-diario-oben` | Bearer **ANON_KEY** | ausente | ❌ vai retornar 401 |

`enviar-pedido-portal-sayerlack` **não está agendada via pg_cron** — é disparada manualmente pelo app (botão `DispararAgoraButton`) usando JWT do usuário staff, então o `authorizeCronOrStaff` já aceita esse fluxo. Nada a fazer aqui via cron.

### 3) Pré-requisito: expor `CRON_SECRET` ao Postgres

O secret `CRON_SECRET` foi criado em **Edge Function Secrets** (vault do GoTrue/Functions), que **não é o mesmo `vault` lido por `vault.decrypted_secrets`** dentro do Postgres. Você tem duas opções — **escolha uma** antes de aplicar o script abaixo:

**Opção A (recomendada, sem duplicar segredo):** colar o valor literal direto no `headers` do `cron.schedule`. Simples e auditável. O script abaixo usa um placeholder `'<<COLE_O_CRON_SECRET_AQUI>>'`.

**Opção B (via vault do Postgres):** inserir o segredo também no `vault` do Postgres e ler com `vault.decrypted_secrets`:
```sql
SELECT vault.create_secret('<<COLE_O_CRON_SECRET_AQUI>>', 'CRON_SECRET');
-- depois, dentro do command do cron:
-- (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
```
Se for usar Opção B, troque a string literal nos `headers` pelo subquery acima.

### 4) Script SQL pronto (Opção A) — execute manualmente

```sql
-- =========================================================
-- ONDA 1 — Reagendamento dos cron jobs com x-cron-secret
-- Substitua <<COLE_O_CRON_SECRET_AQUI>> pelo valor real do
-- secret CRON_SECRET (mesmo configurado em Edge Functions).
-- =========================================================

-- 14) omie-cron-diario-oben (07:00 diário)
SELECT cron.unschedule('omie-cron-diario-oben');
SELECT cron.schedule(
  'omie-cron-diario-oben',
  '0 7 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-cron-diario',
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'x-cron-secret',  '<<COLE_O_CRON_SECRET_AQUI>>'
    ),
    body    := '{"empresa":"OBEN"}'::jsonb,
    timeout_milliseconds := 150000
  ) AS request_id;
  $$
);

-- 20) disparar-pedidos-aprovados-oben (13:00 diário)
SELECT cron.unschedule('disparar-pedidos-aprovados-oben');
SELECT cron.schedule(
  'disparar-pedidos-aprovados-oben',
  '0 13 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/disparar-pedidos-aprovados',
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'x-cron-secret',  '<<COLE_O_CRON_SECRET_AQUI>>'
    ),
    body    := '{"empresa":"OBEN"}'::jsonb,
    timeout_milliseconds := 150000
  ) AS request_id;
  $$
);

-- 21) gerar-pedidos-diario-oben (09:15 diário)
SELECT cron.unschedule('gerar-pedidos-diario-oben');
SELECT cron.schedule(
  'gerar-pedidos-diario-oben',
  '15 9 * * *',
  $$
  SELECT net.http_post(
    url     := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/gerar-pedidos-diario',
    headers := jsonb_build_object(
      'Content-Type',   'application/json',
      'x-cron-secret',  '<<COLE_O_CRON_SECRET_AQUI>>'
    ),
    body    := '{"empresa":"OBEN"}'::jsonb,
    timeout_milliseconds := 150000
  ) AS request_id;
  $$
);

-- Validação
SELECT jobname, schedule, command
FROM cron.job
WHERE jobname IN (
  'omie-cron-diario-oben',
  'disparar-pedidos-aprovados-oben',
  'gerar-pedidos-diario-oben'
)
ORDER BY jobname;
```

### 5) Variante Opção B (vault no Postgres)

Se preferir não colar o segredo em texto claro no `command`:

```sql
-- 1x apenas (cria o secret no vault do Postgres)
SELECT vault.create_secret('<<COLE_O_CRON_SECRET_AQUI>>', 'CRON_SECRET');
```

E em cada `cron.schedule`, troque o header por:
```sql
'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')
```

### 6) Observações

- Nenhuma alteração em `enviar-pedido-portal-sayerlack` é necessária via cron — não há job agendado.
- Após aplicar, o próximo disparo natural valida tudo. Para testar imediatamente: `SELECT cron.schedule('test-once', '* * * * *', $$ ... $$);` apontando para uma das URLs e depois `cron.unschedule('test-once')`.
- Os outros jobs (process-recurring-orders, monthly-report, calculate-scores, etc.) **continuam usando ANON_KEY**, o que segue funcionando porque essas funções não foram endurecidas nesta onda. Eles entrarão em ondas futuras.
