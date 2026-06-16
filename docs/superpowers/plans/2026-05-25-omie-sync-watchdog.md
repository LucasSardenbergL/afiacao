# Watchdog de integridade do sync Omie — Plano de Implementação (iteração 1)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development ou superpowers:executing-plans. Steps usam checkbox (`- [ ]`).
> Entrega de banco SEMPRE via skill `lovable-db-operator` (founder cola no SQL Editor do Lovable; sem terminal). NUNCA dizer "apliquei" — só "preparei pra colar".

**Goal:** Alertar o founder (in-app + email) quando o sync Omie→financeiro para ou falha, antes de virar reclamação, com heartbeat diário como dead-man-switch.

**Architecture:** Dois crons SQL puros (pg_cron) chamando funções `SECURITY DEFINER`. `fin_sync_watchdog_check()` cruza sinais de `fin_sync_log` (frescor + erro) e `fin_sync_cursor` (travado), grava em `fin_alertas` (anti-spam grátis via unique parcial + in-app) e, na transição ok→problema, enfileira email em `fornecedor_alerta` (drenado pelo `dispatch-notifications`). `fin_sync_heartbeat()` manda resumo diário.

**Tech Stack:** Postgres/plpgsql, pg_cron, Supabase (Lovable Cloud). Sem edge function nova, sem secret novo.

**Refinamento vs spec (2026-05-25):** o `net._http_response` saiu da iteração 1 (schema `net` não está no snapshot, e a staleness do `fin_sync_log.completed_at` já cobre o caso do incidente — cron que não roda não grava `complete`). Detecção mais rápida via `net._http_response` = iteração 1.5. Adicionado o sinal `fin_sync_log.status='error'`.

---

## Schemas confirmados (do snapshot/migrations)

- `fin_sync_log(id, action text, companies text[], status text∈{running,complete,error}, error_message, completed_at timestamptz, ...)`. Actions críticos: `sync_contas_pagar`, `sync_contas_receber`, `sync_movimentacoes`.
- `fin_sync_cursor(company text, resource text∈{contas_pagar,contas_receber,movimentacoes}, next_page int, updated_at timestamptz, PK(company,resource))`. `next_page IS NULL` = passada completa.
- `fin_alertas(id uuid, company text∈{oben,colacor,colacor_sc}, tipo text, severidade text∈{info,aviso,critico}, mensagem text NOT NULL, contexto jsonb, criado_em, dismissed_at, ...)`. UNIQUE parcial `fin_alertas_unique_ativo (company,tipo) WHERE dismissed_at IS NULL`.
- `fornecedor_alerta(id bigint, empresa text NOT NULL, tipo text NOT NULL CHECK∈{...,'outro'}, severidade text∈{info,atencao,urgente} default info, titulo text NOT NULL, mensagem text, status text∈{pendente_notificacao,...} default pendente_notificacao, ...)`. Drenada por `processar_alertas_pendentes_notificacao(p_empresa)` → `dispatch-notifications` (Gmail).

---

## File Structure

- Create: `supabase/migrations/<ts>_fin_sync_watchdog.sql` — 2 funções + 2 cron.schedule + grants. (entregue via lovable-db-operator)
- Modify: nenhum arquivo de app (feature é 100% banco).
- Docs: este plano + spec já commitado.

---

## Task 1: Confirmar 2 premissas de runtime (read-only, founder roda no SQL Editor)

A SQL das funções assume: (a) o cron por-entidade grava `fin_sync_log` com a empresa dentro de `companies[]`; (b) o `dispatch-notifications` drena `fornecedor_alerta` para as empresas com a convenção de nome que vamos inserir. Confirmar antes de gravar a função evita alerta que não dispara email.

- [ ] **Step 1: Entregar as queries de confirmação (via lovable-db-operator handoff)**

```sql
-- (a) como o sync loga: amostra recente de fin_sync_log dos actions críticos
SELECT action, companies, status, completed_at
FROM public.fin_sync_log
WHERE action IN ('sync_contas_pagar','sync_contas_receber','sync_movimentacoes')
ORDER BY completed_at DESC NULLS LAST
LIMIT 15;

-- (b) convenção de empresa na fila de email + como o dispatcher itera
SELECT DISTINCT empresa FROM public.fornecedor_alerta;
SELECT command FROM cron.job WHERE command ILIKE '%dispatch-notifications%';
```

- [ ] **Step 2: Interpretar**

- Em (a): confirmar que `<empresa> = ANY(companies)` é verdade pros 3 (`oben`/`colacor`/`colacor_sc`). Se `companies` vier vazio/diferente, ajustar o predicado na Task 2 (ex: usar `results`/`entidades_por_empresa`).
- Em (b): anotar a convenção de `fornecedor_alerta.empresa` (lowercase `oben` vs `OBEN`) e se o cron do dispatcher passa `p_empresa` por empresa ou roda um default. Usar essa convenção exata no `INSERT INTO fornecedor_alerta` da Task 2/3. Se o dispatcher só processa uma empresa fixa, enfileirar com essa empresa e pôr a empresa real no título.

- [ ] **Step 3: Registrar as respostas** no topo da migration (comentário) pra rastreabilidade.

---

## Task 2: Função `fin_sync_watchdog_check()`

**Files:** Create (dentro da migration `supabase/migrations/<ts>_fin_sync_watchdog.sql`).

- [ ] **Step 1: Escrever a função** (ajustar `<EMPRESA_EMAIL>` conforme Task 1.b; default abaixo = mesma string lowercase)

```sql
CREATE OR REPLACE FUNCTION public.fin_sync_watchdog_check()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_companies text[] := ARRAY['oben','colacor','colacor_sc'];
  v_resources text[] := ARRAY['contas_pagar','contas_receber','movimentacoes'];
  v_stale_hours  int := 18;  -- syncs rodam 8h/14h + continuação
  v_error_hours  int := 6;
  v_cursor_hours int := 2;
  c text;
  v_stale text[];
  v_errs  text[];
  v_stuck text[];
  v_msg text;
BEGIN
  FOREACH c IN ARRAY v_companies LOOP
    -- 1) FRESCOR: recursos críticos sem 'complete' dentro da janela
    SELECT array_agg(r ORDER BY r) INTO v_stale
    FROM unnest(v_resources) AS r
    WHERE NOT EXISTS (
      SELECT 1 FROM fin_sync_log l
      WHERE l.status = 'complete' AND l.action = 'sync_'||r
        AND c = ANY(l.companies)
        AND l.completed_at > now() - make_interval(hours => v_stale_hours)
    );
    IF v_stale IS NOT NULL THEN
      v_msg := 'Sync sem conclusão há >'||v_stale_hours||'h: '||array_to_string(v_stale, ', ');
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_stale', 'critico', v_msg,
              jsonb_build_object('recursos', v_stale, 'janela_horas', v_stale_hours))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'urgente', '[Sync parado] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_stale' AND dismissed_at IS NULL;
    END IF;

    -- 2) ERRO EXPLÍCITO: fin_sync_log status='error' recente
    SELECT array_agg(DISTINCT l.action ORDER BY l.action) INTO v_errs
    FROM fin_sync_log l
    WHERE l.status = 'error' AND c = ANY(l.companies)
      AND COALESCE(l.completed_at, l.started_at) > now() - make_interval(hours => v_error_hours)
      AND l.action LIKE 'sync_%';
    IF v_errs IS NOT NULL THEN
      v_msg := 'Sync com erro nas últimas '||v_error_hours||'h: '||array_to_string(v_errs, ', ');
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_error', 'critico', v_msg, jsonb_build_object('actions', v_errs))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'urgente', '[Sync erro] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_error' AND dismissed_at IS NULL;
    END IF;

    -- 3) CURSOR TRAVADO: next_page pendente velho
    SELECT array_agg(resource ORDER BY resource) INTO v_stuck
    FROM fin_sync_cursor
    WHERE company = c AND next_page IS NOT NULL
      AND updated_at < now() - make_interval(hours => v_cursor_hours);
    IF v_stuck IS NOT NULL THEN
      v_msg := 'Cursor de continuação travado há >'||v_cursor_hours||'h: '||array_to_string(v_stuck, ', ');
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_cursor_stuck', 'aviso', v_msg, jsonb_build_object('recursos', v_stuck))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'atencao', '[Sync cursor] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_cursor_stuck' AND dismissed_at IS NULL;
    END IF;
  END LOOP;
END;
$$;
```

- [ ] **Step 2: Validação (read-only, após apply) — confirmar que a função existe e roda sem erro**

```sql
SELECT public.fin_sync_watchdog_check();  -- não deve dar erro
SELECT company, tipo, severidade, mensagem, criado_em
FROM public.fin_alertas WHERE tipo LIKE 'sync_%' AND dismissed_at IS NULL
ORDER BY criado_em DESC;
```
Esperado: executa sem erro; lista 0+ alertas de sync ativos (provavelmente 0 se o sync está saudável agora).

- [ ] **Step 3: Teste de disparo (simular problema)** — baixar o threshold pra forçar um alerta e confirmar o email enfileirado:

```sql
-- Força "stale" setando janela curtíssima numa chamada manual de teste (NÃO commitar):
-- (rode a função com thresholds altos via cópia temporária OU verifique o enqueue)
SELECT id, empresa, tipo, severidade, titulo, status
FROM public.fornecedor_alerta
WHERE tipo='outro' AND titulo LIKE '[Sync%' ORDER BY criado_em DESC LIMIT 5;
```
Esperado: se houver problema real, há linha(s) `pendente_notificacao` → o `dispatch-notifications` enviará no próximo ciclo. (Se o sync está saudável, sem linhas — ok.)

---

## Task 3: Função `fin_sync_heartbeat()` (dead-man-switch)

- [ ] **Step 1: Escrever a função**

```sql
CREATE OR REPLACE FUNCTION public.fin_sync_heartbeat()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_resumo text;
  v_ativos int;
BEGIN
  SELECT count(*) INTO v_ativos
  FROM fin_alertas WHERE tipo LIKE 'sync_%' AND dismissed_at IS NULL;

  SELECT string_agg(linha, E'\n' ORDER BY linha) INTO v_resumo
  FROM (
    SELECT format('%s/%s: último complete %s',
                  c.company, c.resource,
                  COALESCE(to_char(max(l.completed_at), 'DD/MM HH24:MI'), 'NUNCA')) AS linha
    FROM (SELECT unnest(ARRAY['oben','colacor','colacor_sc']) AS company,
                 unnest(ARRAY['contas_pagar','contas_receber','movimentacoes']) AS resource) c
    CROSS JOIN LATERAL (
      SELECT max(completed_at) AS completed_at FROM fin_sync_log l2
      WHERE l2.status='complete' AND l2.action='sync_'||c.resource AND c.company = ANY(l2.companies)
    ) l
    GROUP BY c.company, c.resource
  ) s;

  INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
  VALUES ('oben', 'outro', 'info',
          '[Watchdog OK] '||to_char(now(),'DD/MM'),
          'Watchdog do sync rodou. Alertas de sync ativos: '||v_ativos||E'.\n\nFrescor por empresa/recurso:\n'||COALESCE(v_resumo,'(sem dados)'),
          'pendente_notificacao');
END;
$$;
```

> Nota: o `CROSS JOIN` de `unnest` paralelo gera 3 pares (oben/contas_pagar, colacor/contas_receber, colacor_sc/movimentacoes) — NÃO o produto cartesiano. Se quiser todas as 9 combinações, trocar por `unnest(...) company CROSS JOIN unnest(...) resource`. **Decisão:** queremos as 9 (cada empresa × cada recurso) → usar dois `unnest` separados em CROSS JOIN. Corrigir na escrita final (ver Step 2).

- [ ] **Step 2: Corrigir o resumo pras 9 combinações** (substituir o subselect `c`):

```sql
    FROM (SELECT company, resource
          FROM unnest(ARRAY['oben','colacor','colacor_sc']) AS company
          CROSS JOIN unnest(ARRAY['contas_pagar','contas_receber','movimentacoes']) AS resource) c
```

- [ ] **Step 3: Validação**

```sql
SELECT public.fin_sync_heartbeat();
SELECT titulo, mensagem FROM public.fornecedor_alerta
WHERE titulo LIKE '[Watchdog OK]%' ORDER BY criado_em DESC LIMIT 1;
```
Esperado: 1 linha com o resumo de frescor das 9 combinações.

---

## Task 4: Crons + montar a migration

- [ ] **Step 1: Adicionar os agendamentos ao fim da migration**

```sql
SELECT cron.schedule('fin-sync-watchdog', '*/30 * * * *',
  $$SELECT public.fin_sync_watchdog_check()$$);
SELECT cron.schedule('fin-sync-heartbeat', '0 11 * * 1-5',
  $$SELECT public.fin_sync_heartbeat()$$);
```

- [ ] **Step 2: Validação dos crons**

```sql
SELECT jobname, schedule, active FROM cron.job
WHERE jobname IN ('fin-sync-watchdog','fin-sync-heartbeat');
```
Esperado: 2 linhas, `active = true`.

---

## Task 5: Entrega via lovable-db-operator + apply + validação final

- [ ] **Step 1:** Invocar a skill `lovable-db-operator` com a migration completa (Tasks 2+3+4), gerando: arquivo `supabase/migrations/<ts>_fin_sync_watchdog.sql`, bloco de handoff pro SQL Editor, queries de validação (função existe + crons ativos + `fin_sync_watchdog_check()` roda), nota de PR, e `bun run audit:migrations`.
- [ ] **Step 2:** Founder cola no SQL Editor → Run → cola as validações → confirma ✅.
- [ ] **Step 3:** Após ✅, commitar a migration + artefatos de audit; abrir PR com a nota "migration manual já aplicada + validada".

---

## Self-Review (cobertura do spec)

- Frescor (`fin_sync_log.completed_at`) ✅ Task 2 sinal 1.
- Falha real do cron ✅ coberto por staleness (cron que não roda → sem `complete`) + `status='error'` (Task 2 sinal 2). `net._http_response` adiado p/ 1.5 (registrado no header).
- Cursor travado ✅ Task 2 sinal 3.
- Anti-spam ✅ `ON CONFLICT` na unique parcial + `IF FOUND` só enfileira email na transição.
- In-app ✅ `fin_alertas` (cockpit já renderiza).
- Email ✅ `fornecedor_alerta` → `dispatch-notifications`.
- Heartbeat/dead-man-switch ✅ Task 3 + cron diário.
- SQL puro, sem edge/secret ✅.
- Premissas de runtime (logging por-empresa; convenção de empresa do dispatcher) ✅ confirmadas na Task 1 antes de gravar.
