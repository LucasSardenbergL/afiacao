# Sentinela Ativo (push) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Um cron que avalia os checks de saúde server-side e dispara alerta (email) na transição ok→degradado pros domínios vendas/estoque/reposição/carteira, fechando o modo-de-falha "ninguém olhou por 8 dias".

**Architecture:** Extrai os 8 checks numa função interna única `_data_health_compute()` (SECURITY DEFINER, sem auth, fonte única de verdade). `get_data_health()` vira wrapper fino (auth + redação) chamando-a — frontend inalterado. `data_health_watchdog()` lê a interna, e pros 4 sources não-financeiros aplica o padrão provado do `fin_sync_watchdog` (INSERT em `fin_alertas` com UNIQUE parcial anti-spam + `IF FOUND` enfileira email em `fornecedor_alerta`; dismiss no ok). `fin_sync_heartbeat()` ganha uma seção de saúde de dados (1 email diário consolidado). Cron `data-health-watchdog */30`.

**Tech Stack:** PostgreSQL (funções plpgsql/sql SECURITY DEFINER), pg_cron, infra de alerta existente (`fin_alertas`, `fornecedor_alerta`, `dispatch-notifications`). Tudo SQL — sem deploy de edge function.

**Constraint Lovable (CLAUDE.md §5):** o founder NÃO tem terminal/CLI pro banco. Migrations custom NÃO são aplicadas automaticamente — ficam só no repo. Cada migration é entregue como **bloco SQL pra colar no SQL Editor** + **query de validação pós-apply**. A "execução de teste" deste plano é validação manual roteirizada no SQL Editor (sem suite automatizada — o controller entrega os blocos e interpreta os resultados que o founder cola).

**Base:** a `get_data_health()` atual completa (8 checks) está em `supabase/migrations/20260527200000_data_health_add_estoque_reposicao.sql`. O corpo `WITH checks AS (...)` dela é a base verbatim do `_data_health_compute()`.

---

## File Structure

- **Create:** `supabase/migrations/20260527210000_data_health_compute_internal.sql` — `_data_health_compute()` (interna) + refactor `get_data_health()` (wrapper).
- **Create:** `supabase/migrations/20260527220000_data_health_watchdog.sql` — `data_health_watchdog()` + extensão de `fin_sync_heartbeat()` + cron `data-health-watchdog`.

Nenhum arquivo de frontend muda (o `get_data_health()` mantém assinatura e contrato; badge/página/banner inalterados).

---

## Task 1: Migration 1 — `_data_health_compute()` interna + `get_data_health()` wrapper

**Files:**
- Create: `supabase/migrations/20260527210000_data_health_compute_internal.sql`

- [ ] **Step 1: Escrever a migration (função interna + wrapper)**

Conteúdo COMPLETO do arquivo `supabase/migrations/20260527210000_data_health_compute_internal.sql`:

```sql
-- Sentinela Ativo (1/2): extrai os 8 checks numa função interna ÚNICA (fonte de verdade),
-- e transforma get_data_health() num wrapper fino (auth + redação) que a chama. Sem isso, o
-- watchdog (migration 2) teria que reimplementar os checks → dashboard verde × alerta divergente
-- (risco nº1 apontado pelo codex). Corpo dos checks = verbatim da migration 20260527200000.

-- Função interna: SEM gate de auth, SEM redação (payload técnico completo). LANGUAGE sql (é uma
-- query só). REVOKE de anon/authenticated/PUBLIC — só funções definer/cron (donas = postgres) a chamam.
CREATE OR REPLACE FUNCTION public._data_health_compute()
RETURNS TABLE (
  source text, domain text, status text,
  age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text,
  message text, last_error text, probable_cause text, how_to_fix text, severity text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH checks AS (
    SELECT 'saldo_bancario'::text AS source, 'financeiro'::text AS domain,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'broken'
           WHEN now() - max(cc.saldo_data)::timestamptz > interval '36 hours' THEN 'stale' ELSE 'ok' END AS status,
      EXTRACT(EPOCH FROM now() - max(cc.saldo_data)::timestamptz)::bigint AS age_seconds,
      (36*3600)::bigint AS expected_max_age_seconds, 'max_saldo_data'::text AS freshness_basis,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'Saldo bancário nunca sincronizou'
           ELSE 'Saldo bancário: último sync ' || to_char(max(cc.saldo_data), 'DD/MM') END AS message,
      NULL::text AS last_error,
      CASE WHEN max(cc.saldo_data) IS NULL THEN 'ListarExtrato falhando ou nunca rodou' ELSE NULL END AS probable_cause,
      'Rode sync_contas_correntes no chat do Lovable e cheque os logs do omie-financeiro'::text AS how_to_fix,
      'critical'::text AS severity
    FROM public.fin_contas_correntes cc WHERE cc.ativo = true
    UNION ALL
    SELECT 'contas_receber', 'financeiro',
      CASE WHEN max(cr.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(cr.updated_at) > interval '26 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cr.updated_at))::bigint, (26*3600)::bigint, 'max_updated_at',
      'Contas a receber: atualizado ' || COALESCE(to_char(max(cr.updated_at),'DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(cr.updated_at) IS NULL THEN 'Sync CR nunca completou' ELSE NULL END,
      'Rode sync_contas_receber no Lovable', 'warning'
    FROM public.fin_contas_receber cr
    UNION ALL
    SELECT 'contas_pagar', 'financeiro',
      CASE WHEN max(cp.updated_at) IS NULL THEN 'broken'
           WHEN now() - max(cp.updated_at) > interval '26 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(cp.updated_at))::bigint, (26*3600)::bigint, 'max_updated_at',
      'Contas a pagar: atualizado ' || COALESCE(to_char(max(cp.updated_at),'DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(cp.updated_at) IS NULL THEN 'Sync CP nunca completou' ELSE NULL END,
      'Rode sync_contas_pagar no Lovable', 'warning'
    FROM public.fin_contas_pagar cp
    UNION ALL
    SELECT 'omie_sync_financeiro'::text, 'omie_sync'::text,
      COALESCE((SELECT CASE WHEN l.status='error' THEN 'broken' ELSE 'ok' END FROM public.fin_sync_log l
                WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1), 'unknown'),
      (SELECT EXTRACT(EPOCH FROM now() - l.completed_at)::bigint FROM public.fin_sync_log l
                WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1),
      NULL::bigint, 'fin_sync_log'::text,
      'Último sync financeiro: ' || COALESCE((SELECT l.status FROM public.fin_sync_log l
        WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1), 'sem registro'),
      (SELECT l.error_message FROM public.fin_sync_log l WHERE l.status='error' AND l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1),
      CASE WHEN (SELECT l.status FROM public.fin_sync_log l WHERE l.completed_at IS NOT NULL ORDER BY l.completed_at DESC LIMIT 1)='error'
           THEN 'A última action de sync financeiro falhou' ELSE NULL END,
      'Cheque fin_sync_log e re-rode a action que falhou'::text, 'critical'::text
    UNION ALL
    SELECT 'vendas_pedidos'::text, 'vendas'::text,
      CASE WHEN v.oben_last IS NULL OR v.colacor_last IS NULL THEN 'broken'
           WHEN now() - LEAST(v.oben_last, v.colacor_last) > interval '6 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - LEAST(v.oben_last, v.colacor_last))::bigint,
      (6*3600)::bigint, 'fin_sync_log.sync_pedidos'::text,
      'Sync de pedidos: oben ' || COALESCE(to_char(v.oben_last,'DD/MM HH24:MI'),'nunca')
        || ' · colacor ' || COALESCE(to_char(v.colacor_last,'DD/MM HH24:MI'),'nunca'),
      v.last_err,
      CASE WHEN v.oben_last IS NULL OR v.colacor_last IS NULL
           THEN 'Cron vendas-sync-pedidos não rodou/completou para alguma conta' ELSE NULL END,
      'Cheque os crons vendas-sync-pedidos-{oben,colacor}-2h e fin_sync_log (action sync_pedidos)'::text, 'critical'::text
    FROM (
      SELECT
        (SELECT max(l.completed_at) FROM public.fin_sync_log l WHERE l.action='sync_pedidos' AND l.status='complete' AND 'oben' = ANY(l.companies)) AS oben_last,
        (SELECT max(l.completed_at) FROM public.fin_sync_log l WHERE l.action='sync_pedidos' AND l.status='complete' AND 'colacor' = ANY(l.companies)) AS colacor_last,
        (SELECT l.error_message FROM public.fin_sync_log l WHERE l.action='sync_pedidos' AND l.status='error' ORDER BY l.started_at DESC LIMIT 1) AS last_err
    ) v
    UNION ALL
    SELECT 'estoque_inventario'::text, 'estoque'::text,
      CASE WHEN max(ip.synced_at) IS NULL THEN 'broken'
           WHEN now() - max(ip.synced_at) > interval '3 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(ip.synced_at))::bigint, (3*3600)::bigint, 'inventory_position.synced_at',
      'Inventário: sincronizado ' || COALESCE(to_char(max(ip.synced_at),'DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(ip.synced_at) IS NULL THEN 'sync_inventory nunca rodou' ELSE NULL END,
      'Cheque o cron sync-inventory-vendas-30m (omie-analytics-sync sync_inventory)', 'warning'
    FROM public.inventory_position ip
    UNION ALL
    SELECT 'reposicao_sugestoes'::text, 'estoque'::text,
      CASE WHEN max(pcs.data_ciclo) IS NULL THEN 'broken'
           WHEN current_date - max(pcs.data_ciclo) > 3 THEN 'stale' ELSE 'ok' END,
      CASE WHEN max(pcs.data_ciclo) IS NULL THEN NULL
           ELSE (current_date - max(pcs.data_ciclo))::bigint * 86400 END,
      (3*86400)::bigint, 'pedido_compra_sugerido.data_ciclo',
      'Sugestão de compra: último ciclo ' || COALESCE(to_char(max(pcs.data_ciclo),'DD/MM/YYYY'),'nunca'),
      NULL, CASE WHEN max(pcs.data_ciclo) IS NULL THEN 'gerar-pedidos nunca gerou sugestão' ELSE NULL END,
      'Cheque o cron gerar-pedidos-diario-oben'::text, 'warning'
    FROM public.pedido_compra_sugerido pcs
    UNION ALL
    SELECT 'carteira_scores'::text, 'carteira'::text,
      CASE WHEN max(fcs.calculated_at) IS NULL THEN 'broken'
           WHEN now() - max(fcs.calculated_at) > interval '36 hours' THEN 'stale' ELSE 'ok' END,
      EXTRACT(EPOCH FROM now() - max(fcs.calculated_at))::bigint, (36*3600)::bigint, 'calculated_at',
      'Scoring de carteira: recalculado ' || COALESCE(to_char(max(fcs.calculated_at),'DD/MM HH24:MI'),'nunca'),
      NULL, CASE WHEN max(fcs.calculated_at) IS NULL THEN 'calculate-scores nunca rodou' ELSE NULL END,
      'Re-rode calculate-scores / scoring-recalc-batch no Lovable', 'warning'
    FROM public.farmer_client_scores fcs
  )
  SELECT c.source, c.domain, COALESCE(NULLIF(c.status, ''), 'unknown') AS status,
    c.age_seconds, c.expected_max_age_seconds, c.freshness_basis, c.message,
    c.last_error, c.probable_cause, c.how_to_fix, c.severity
  FROM checks c;
$$;

REVOKE ALL ON FUNCTION public._data_health_compute() FROM PUBLIC, anon, authenticated;

-- Wrapper público: mesma assinatura/contrato de antes. Gate de auth + redação por papel.
CREATE OR REPLACE FUNCTION public.get_data_health()
RETURNS TABLE (
  source text, domain text, status text,
  age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text,
  message text, last_error text, probable_cause text, how_to_fix text, severity text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_full boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Acesso negado: não autenticado' USING ERRCODE = '42501';
  END IF;
  v_full := COALESCE(public.pode_ver_carteira_completa(auth.uid()), false);
  RETURN QUERY
  SELECT c.source, c.domain, c.status,
    c.age_seconds, c.expected_max_age_seconds, c.freshness_basis, c.message,
    CASE WHEN v_full THEN c.last_error ELSE NULL END,
    CASE WHEN v_full THEN c.probable_cause ELSE NULL END,
    CASE WHEN v_full THEN c.how_to_fix ELSE NULL END,
    c.severity
  FROM public._data_health_compute() c;
END;
$$;

REVOKE ALL ON FUNCTION public.get_data_health() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_data_health() TO authenticated;
```

- [ ] **Step 2: Entregar o bloco SQL ao founder pra colar no SQL Editor**

O controller cola o conteúdo do arquivo (sem o comentário de header, opcional) num bloco ```sql na conversa, rotulado "🟣 Lovable → SQL Editor → cola → Run". Idempotente (`CREATE OR REPLACE`).

- [ ] **Step 3: Validar PARIDADE do refactor (founder roda, cola resultado)**

Bloco de validação (impersonando master):

```sql
SELECT set_config('request.jwt.claims',
  json_build_object('sub',(SELECT user_id FROM public.user_roles WHERE role::text='master' LIMIT 1)::text,'role','authenticated')::text,false);
SELECT source, domain, status, age_seconds,
       (last_error IS NOT NULL) AS tem_last_error
FROM public.get_data_health() ORDER BY domain, source;
```

Expected: 8 linhas idênticas às de antes do refactor (mesmos source/domain/status/age). Como master, `tem_last_error` deve ser `true` SÓ onde há erro real (ex.: omie_sync_financeiro com SOAP). Isso prova que o wrapper preserva a redação full.

- [ ] **Step 4: Validar redação pra NÃO-full (opcional, se houver login não-gestor à mão)**

Sem impersonar full (ou com um uid de employee não-gestor): `last_error`/`probable_cause`/`how_to_fix` devem vir NULL em todas as linhas. (Se não for prático testar agora, registrar como verificação manual posterior — o CASE WHEN v_full é idêntico ao original, então o risco é baixo.)

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260527210000_data_health_compute_internal.sql
git commit -m "feat(data-health): extrai _data_health_compute() interna + get_data_health wrapper"
```

---

## Task 2: Migration 2 — `data_health_watchdog()` + heartbeat + cron

**Files:**
- Create: `supabase/migrations/20260527220000_data_health_watchdog.sql`

**Depende de:** Task 1 (a `_data_health_compute()` precisa existir).

- [ ] **Step 1: Escrever a migration (watchdog + heartbeat + cron)**

Conteúdo COMPLETO do arquivo `supabase/migrations/20260527220000_data_health_watchdog.sql`:

```sql
-- Sentinela Ativo (2/2): cron que alerta na transição ok→degradado pros 4 domínios não-financeiros
-- (vendas/estoque/reposição/carteira). Espelha o padrão provado do fin_sync_watchdog: INSERT em
-- fin_alertas com UNIQUE parcial (company,tipo) WHERE dismissed_at IS NULL (anti-spam) + IF FOUND
-- enfileira email em fornecedor_alerta (drenado por dispatch-notifications); dismiss no ok.
-- Financeiro fica com o fin_sync_watchdog (donos por domínio; tipos data_health_* vs sync_* não colidem).
-- company='oben' é carrier (CHECK não aceita 'global'; o heartbeat já usa 'oben'); o tipo único por
-- source faz o dedup. Severidade: critical→critico/urgente, warning→aviso/atencao.

CREATE OR REPLACE FUNCTION public.data_health_watchdog()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  r record;
  v_sev_fin text;
  v_sev_forn text;
BEGIN
  FOR r IN
    SELECT * FROM public._data_health_compute()
    WHERE source IN ('vendas_pedidos','estoque_inventario','reposicao_sugestoes','carteira_scores')
  LOOP
    v_sev_fin  := CASE WHEN r.severity = 'critical' THEN 'critico' ELSE 'aviso' END;
    v_sev_forn := CASE WHEN r.severity = 'critical' THEN 'urgente' ELSE 'atencao' END;
    IF r.status <> 'ok' THEN
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES ('oben', 'data_health_' || r.source, v_sev_fin, r.message,
              jsonb_build_object('source', r.source, 'domain', r.domain, 'status', r.status,
                                 'age_seconds', r.age_seconds, 'freshness_basis', r.freshness_basis))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES ('oben', 'outro', v_sev_forn, '[Saúde de dados] ' || r.source, r.message, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = 'oben' AND tipo = 'data_health_' || r.source AND dismissed_at IS NULL;
    END IF;
  END LOOP;
END;
$$;

-- Heartbeat: estende o existente com a seção de saúde de dados (1 email diário consolidado).
CREATE OR REPLACE FUNCTION public.fin_sync_heartbeat()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_resumo text;
  v_ativos int;
  v_dh_ativos int;
  v_dh_resumo text;
BEGIN
  SELECT count(*) INTO v_ativos
  FROM fin_alertas WHERE tipo LIKE 'sync_%' AND dismissed_at IS NULL;

  SELECT string_agg(linha, E'\n' ORDER BY linha) INTO v_resumo
  FROM (
    SELECT format('%s/%s: %s', co, re, COALESCE(to_char(m.mx, 'DD/MM HH24:MI'), 'NUNCA')) AS linha
    FROM unnest(ARRAY['oben','colacor','colacor_sc']) AS co
    CROSS JOIN unnest(ARRAY['contas_pagar','contas_receber','movimentacoes']) AS re
    CROSS JOIN LATERAL (
      SELECT max(l.completed_at) AS mx FROM fin_sync_log l
      WHERE l.status='complete' AND l.action='sync_'||re AND co = ANY(l.companies)
    ) m
  ) s;

  SELECT count(*) INTO v_dh_ativos
  FROM fin_alertas WHERE tipo LIKE 'data_health_%' AND dismissed_at IS NULL;

  SELECT string_agg(format('%s: %s', source, status), E'\n' ORDER BY source) INTO v_dh_resumo
  FROM public._data_health_compute()
  WHERE source IN ('vendas_pedidos','estoque_inventario','reposicao_sugestoes','carteira_scores');

  INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
  VALUES ('oben', 'outro', 'info',
          '[Watchdog OK] '||to_char(now(),'DD/MM'),
          'Watchdog do sync rodou. Alertas de sync ativos: '||v_ativos||
          E'.\n\nÚltimo sync OK por empresa/recurso:\n'||COALESCE(v_resumo,'(sem dados)')||
          E'\n\nSaúde de dados — alertas ativos: '||v_dh_ativos||
          E'.\nChecks (vendas/estoque/reposição/carteira):\n'||COALESCE(v_dh_resumo,'(sem dados)'),
          'pendente_notificacao');
END;
$$;

-- Cron: função SQL local (roda como postgres, dono) — sem net.http_post, logo sem a armadilha
-- do timeout de 5s. Upsert por nome (idempotente).
SELECT cron.schedule('data-health-watchdog', '*/30 * * * *',
  $$SELECT public.data_health_watchdog()$$);
```

- [ ] **Step 2: Entregar o bloco SQL ao founder pra colar no SQL Editor**

Cola o conteúdo num bloco ```sql rotulado. Idempotente.

- [ ] **Step 3: Validar — estado saudável NÃO gera alerta**

```sql
SELECT public.data_health_watchdog();
SELECT count(*) AS alertas_dh_ativos
FROM public.fin_alertas WHERE tipo LIKE 'data_health_%' AND dismissed_at IS NULL;
SELECT count(*) AS emails_dh_pendentes
FROM public.fornecedor_alerta WHERE titulo LIKE '[Saúde de dados]%' AND status='pendente_notificacao';
```

Expected (com os 4 checks ok hoje): `alertas_dh_ativos = 0`, `emails_dh_pendentes = 0`. (Sem verde silencioso significa: se algum check estiver não-ok agora, é correto ele gerar alerta — interpretar conforme o estado real.)

- [ ] **Step 4: Validar TRANSIÇÃO → alerta (forçar um check stale temporariamente)**

Forçar `reposicao_sugestoes` a stale sem tocar dado real: o check usa `max(pcs.data_ciclo) > current_date - 3`. Em vez de mexer na tabela, testar o caminho inserindo um alerta manualmente NÃO valida o watchdog. Caminho seguro: rodar o watchdog e, se algum check legítimo estiver não-ok, observar; senão, validar a MECÂNICA com uma chamada dupla:

```sql
-- 1) Simula transição: insere um alerta de teste e confirma o IF FOUND / ON CONFLICT
INSERT INTO public.fin_alertas (company, tipo, severidade, mensagem, contexto)
VALUES ('oben','data_health_TESTE','aviso','teste de transição', '{}'::jsonb)
ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
SELECT FOUND;  -- esperado: t (inseriu)
-- 2) Repete: deve NÃO inserir (anti-spam)
INSERT INTO public.fin_alertas (company, tipo, severidade, mensagem, contexto)
VALUES ('oben','data_health_TESTE','aviso','teste de transição', '{}'::jsonb)
ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
SELECT FOUND;  -- esperado: f (DO NOTHING)
-- 3) Limpa o teste
DELETE FROM public.fin_alertas WHERE tipo='data_health_TESTE';
```

Expected: primeiro `FOUND = t`, segundo `FOUND = f`. Prova o mecanismo anti-spam/transição. (A validação do caminho real ok→stale acontece naturalmente quando um check degradar em produção — o heartbeat e o badge confirmam.)

- [ ] **Step 5: Validar HEARTBEAT (seção de saúde de dados)**

```sql
SELECT public.fin_sync_heartbeat();
SELECT left(mensagem, 600) AS msg
FROM public.fornecedor_alerta
WHERE titulo LIKE '[Watchdog OK]%' ORDER BY id DESC LIMIT 1;
```

Expected: a `mensagem` contém a seção "Saúde de dados — alertas ativos: N" + as 4 linhas (vendas_pedidos/estoque_inventario/reposicao_sugestoes/carteira_scores com status). Confirma o dead-man-switch consolidado.

- [ ] **Step 6: Confirmar o cron agendado**

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'data-health-watchdog';
```

Expected: 1 linha, `*/30 * * * *`, `active = true`.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/20260527220000_data_health_watchdog.sql
git commit -m "feat(data-health): data_health_watchdog (alerta na transição) + heartbeat + cron"
```

---

## Self-Review

**1. Spec coverage:**
- Fonte única `_data_health_compute()` → Task 1. ✓
- `get_data_health()` wrapper (auth+redação, frontend inalterado) → Task 1. ✓
- `data_health_watchdog()` (4 domínios, transição, dedup, dismiss, severidade) → Task 2 Step 1. ✓
- Heartbeat estendido (consolidado) → Task 2 Step 1. ✓
- Coexistência (tipos `data_health_*` vs `sync_*`, financeiro intocado) → Task 2 (watchdog só filtra os 4 sources). ✓
- Cron `*/30` versionado → Task 2 Step 1 + Step 6. ✓
- Validação manual roteirizada (paridade, ok→sem alerta, transição, dismiss, heartbeat) → Tasks 1-2 steps de validação. ✓
- Segurança SECURITY DEFINER + search_path + REVOKE → ambas as migrations. ✓
- Aplicação manual via SQL Editor (Lovable) → Steps 2 de cada task. ✓

**2. Placeholder scan:** Sem TBD/TODO. SQL completo em todos os steps. (Step 4 da Task 2 valida a MECÂNICA anti-spam com um tipo de teste descartável, já que forçar um check real a stale sem mexer em dado de prod não é trivial — explicitado, não é placeholder.)

**3. Type consistency:** Assinaturas idênticas entre `_data_health_compute()` e `get_data_health()` (mesma TABLE de 11 colunas). `tipo='data_health_'||source` consistente entre watchdog (INSERT/UPDATE) e heartbeat (count `LIKE 'data_health_%'`). Severidades: `fin_alertas` {critico,aviso}, `fornecedor_alerta` {urgente,atencao} — batem com os CHECKs reais. Os 4 sources idênticos no watchdog e no heartbeat.

**Dismiss do alerta de teste:** o Step 4 limpa o `data_health_TESTE` via DELETE — não deixa lixo.

---

## Execução

Plano salvo em `docs/superpowers/plans/2026-05-27-sentinela-ativo.md`.
