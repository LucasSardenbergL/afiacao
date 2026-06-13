# Reposição N3 — auto-aprovação Sayerlack (piloto de veto) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pedido Sayerlack pendente que cruza R$ 3.000 (mínimo de faturamento) e passa no estrato de segurança é aprovado automaticamente pelo tick SQL, com e-mail informativo e janela de veto até o corte de disparo — founder sai do caso comum, fica nas exceções.

**Architecture:** Estende o tick existente `reposicao_alerta_pedido_minimo_tick()` (migration `20260609150000`, cron `*/30` + hook pós-geração) com um braço de auto-aprovação gated por fusível em `company_config`, auto-suspensão por alerta ativo do Sentinela e janela de horário (só aprova com ≥45min até o corte de disparo). Elegibilidade em função SQL separada (`reposicao_pedido_auto_aprovavel`) testável isoladamente; delta computado AO VIVO contra o último disparo real do mesmo (fornecedor, grupo) — a coluna `pedido_anterior_valor` é morta (nunca populada, ver spec §3). Sem cron novo, sem edge nova, sem deploy de edge.

**Tech Stack:** PostgreSQL (plpgsql, migration manual no SQL Editor do Lovable), teste local PostgreSQL 17 (`db/test-*.sh`, harness de `db/verify-snapshot-replay.sh`), React/TypeScript (badge), vitest.

**Spec:** `docs/superpowers/specs/2026-06-10-reposicao-auto-aprovacao-sayerlack-design.md` (aprovada pelo founder 2026-06-10 — decisões §2, elegibilidade §4.2).

**Regras da casa que valem aqui (engenheiro novo: leia antes):**
- Migration NÃO se aplica sozinha — Lovable Cloud exige colar no SQL Editor (CLAUDE.md §5). O PR pode mergear; prod só muda no apply manual.
- Comandos pesados com `heavy` (`heavy bun run test`), nunca `| tail` (engole exit code).
- `bun run test` (vitest) é o canônico; `bun test` é fast-path parcial.
- Timestamp de migration: `20260610150000` confirmado livre na main em 2026-06-10 (último: `20260609160000`). Re-checar com `git ls-tree origin/main supabase/migrations/ --name-only | sort | tail -5` antes do push (multi-sessão).
- Codex challenge adversarial ANTES do apply em prod (cota volta 11/06 ~9h24; money-path = `xhigh` explícito).

---

### Task 1: Migration — configs + log + função de elegibilidade + tick estendido

**Files:**
- Create: `supabase/migrations/20260610150000_reposicao_auto_aprovacao_piloto.sql`

O arquivo completo. O tick é o corpo VERBATIM da `20260609150000` + 4 marcas `[AUTO n/4]` (mesmo estilo das marcas `[INTRADAY]` da `20260609160000`). NÃO mexer em nada fora das marcas.

- [ ] **Step 1: Escrever a migration completa**

```sql
-- Reposição N3 — auto-aprovação Sayerlack com piloto de veto
-- ============================================================================
-- Spec: docs/superpowers/specs/2026-06-10-reposicao-auto-aprovacao-sayerlack-design.md
--
-- Estende o tick do alerta R$3k (20260609150000) com um braço de AUTO-APROVAÇÃO:
-- pedido Sayerlack pendente >= régua que passa no estrato de segurança é aprovado
-- pela máquina (aprovado_por = 'auto:sayerlack-v1') e o e-mail vira INFORMATIVO
-- ("aprovei; pra vetar, cancele até o corte"). Pedido inelegível segue o fluxo
-- atual (e-mail "vá aprovar"). O DISPARO não muda nesta fase: o pedido aprovado
-- espera o cron de corte em lote — essa espera É a janela de veto do piloto.
--
-- Estrato (spec §4.2): ciclo normal · sem split · >= R$3k (mesma régua do alerta/
-- gate) · itens sãos · sem ajuste humano · sem falha recente de auto-aprovado do
-- fornecedor (cooldown) · delta <= 30% vs último disparo REAL do mesmo
-- (fornecedor, grupo) nos últimos 90d — computado AO VIVO (pedido_anterior_valor
-- nunca foi populado pela RPC; classificador do Cockpit é inerte — spec §3).
--
-- Guard-rails: fusível company_config (nasce OFF) · auto-suspensão se o Sentinela
-- tem alerta ATIVO de reposição · janela de horário (>=45min antes do corte; pedido
-- da tarde espera a regeneração da manhã seguinte — zumbis expiram, [INTRADAY 2/4])
-- · claim condicional (corrida com humano: quem chegar primeiro) · log de auditoria.
--
-- ⚠️ Migration MANUAL (Lovable): colar no SQL Editor → Run. Validação no fim.
-- ⚠️ Tick = corpo VERBATIM da 20260609150000 + marcas [AUTO 1/4..4/4].

BEGIN;

-- ── A) Configs do piloto (text key/value, cast com guard na leitura) ─────────
-- ativa nasce 'false': o founder liga com o BLOCO B do rollout, quando quiser.
INSERT INTO public.company_config (key, value) VALUES
  ('reposicao_auto_aprovacao_ativa', 'false'),
  ('reposicao_auto_aprovacao_delta_max', '0.30'),
  ('reposicao_auto_aprovacao_cooldown_falha_horas', '48'),
  ('reposicao_auto_aprovacao_corte_utc', '13:00')
ON CONFLICT (key) DO NOTHING;

-- ── B) Log de auditoria (append-only, SEM FK — snapshot desacoplado) ─────────
CREATE TABLE IF NOT EXISTS public.reposicao_auto_aprovacao_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pedido_id bigint NOT NULL,
  empresa text NOT NULL,
  fornecedor_nome text NOT NULL,
  grupo_codigo text NOT NULL DEFAULT '',
  valor_total numeric NOT NULL,
  valor_anterior numeric,
  delta_pct numeric,
  regua numeric NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reposicao_auto_aprovacao_log_criado_em
  ON public.reposicao_auto_aprovacao_log (criado_em DESC);

ALTER TABLE public.reposicao_auto_aprovacao_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Staff lê log de auto-aprovação" ON public.reposicao_auto_aprovacao_log;
CREATE POLICY "Staff lê log de auto-aprovação" ON public.reposicao_auto_aprovacao_log
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = (SELECT auth.uid()) AND ur.role IN ('employee','master')
  ));
-- Escrita: só o tick (SECURITY DEFINER) / service_role (bypassa RLS). Sem policy de INSERT.

-- ── C) Elegibilidade (função separada = testável isoladamente no PG17) ───────
-- Retorna jsonb {elegivel, motivo?, valor_anterior?, delta_pct?}. O motivo não é
-- consumido pelo tick (pedido inelegível segue o fluxo humano normal) mas é ouro
-- pra teste/debug via SELECT direto.
CREATE OR REPLACE FUNCTION public.reposicao_pedido_auto_aprovavel(
  p_pedido_id bigint,
  p_delta_max numeric,
  p_cooldown_horas numeric
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  p RECORD;
  v_ant RECORD;
  v_delta numeric;
BEGIN
  SELECT * INTO p FROM public.pedido_compra_sugerido WHERE id = p_pedido_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'pedido inexistente');
  END IF;

  IF p.status <> 'pendente_aprovacao' OR p.aprovado_em IS NOT NULL OR p.cancelado_em IS NOT NULL THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'não está pendente');
  END IF;

  IF COALESCE(p.tipo_ciclo, 'normal') <> 'normal' THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'ciclo não-normal (oportunidade/promoção é decisão humana)');
  END IF;

  IF p.split_parent_id IS NOT NULL THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'pedido-filho de split');
  END IF;

  IF COALESCE(p.num_skus, 0) <= 0 THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'sem SKUs');
  END IF;

  -- numeric aceita NaN/Infinity; NaN ordena MAIOR que Infinity → o "< Infinity"
  -- barra os dois (mesmo padrão do CHECK de minimo_forcado_manual).
  IF p.valor_total IS NULL OR NOT (p.valor_total > 0 AND p.valor_total < 'Infinity'::numeric) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'valor_total inválido');
  END IF;

  -- Itens que o guard de disparo (#422/#433) barraria: não aprovar o que vai falhar.
  IF EXISTS (
    SELECT 1 FROM public.pedido_compra_item i
    WHERE i.pedido_id = p.id
      AND (COALESCE(i.preco_unitario, 0) <= 0 OR COALESCE(i.qtde_final, 0) <= 0)
  ) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'item com preço/qtde inválido');
  END IF;

  -- Humano já mexeu → a decisão é dele (trade-off "ajustou → aprova" do #711).
  IF EXISTS (
    SELECT 1 FROM public.pedido_compra_item i
    WHERE i.pedido_id = p.id AND i.ajustado_humano IS TRUE
  ) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'itens ajustados por humano');
  END IF;

  -- Cooldown: auto-aprovado do fornecedor falhou no disparo há pouco (ex.: SKU sem
  -- de-para no portal) → exceção humana resolve antes da automação voltar.
  IF EXISTS (
    SELECT 1 FROM public.pedido_compra_sugerido f
    WHERE f.empresa = p.empresa
      AND f.fornecedor_nome = p.fornecedor_nome
      AND f.aprovado_por LIKE 'auto:%'
      AND f.status = 'falha_envio'
      AND f.atualizado_em > now() - (p_cooldown_horas * interval '1 hour')
  ) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'cooldown: auto-aprovação recente do fornecedor falhou no disparo');
  END IF;

  -- Delta AO VIVO por (empresa, fornecedor, grupo): referência = último pedido com
  -- evidência de compra real, < 90d. Sem referência do GRUPO → primeira compra é
  -- humana (cada disparo manual semeia o grupo). Spec §4.2.7.
  SELECT a.valor_total, a.criado_em INTO v_ant
  FROM public.pedido_compra_sugerido a
  WHERE a.empresa = p.empresa
    AND a.fornecedor_nome = p.fornecedor_nome
    AND COALESCE(a.grupo_codigo, '') = COALESCE(p.grupo_codigo, '')
    AND a.id <> p.id
    AND a.criado_em < p.criado_em
    AND a.criado_em > now() - interval '90 days'
    AND (a.omie_pedido_compra_numero IS NOT NULL OR a.status IN ('disparado', 'concluido_recebido'))
  ORDER BY a.criado_em DESC
  LIMIT 1;

  IF NOT FOUND OR v_ant.valor_total IS NULL
     OR NOT (v_ant.valor_total > 0 AND v_ant.valor_total < 'Infinity'::numeric) THEN
    RETURN jsonb_build_object('elegivel', false, 'motivo', 'sem disparo de referência do grupo em 90d');
  END IF;

  v_delta := abs(p.valor_total - v_ant.valor_total) / v_ant.valor_total;
  IF v_delta > p_delta_max THEN
    RETURN jsonb_build_object('elegivel', false,
      'motivo', 'delta ' || round(v_delta * 100, 1)::text || '% > máx ' || round(p_delta_max * 100)::text || '%',
      'valor_anterior', v_ant.valor_total,
      'delta_pct', round(v_delta * 100, 1));
  END IF;

  RETURN jsonb_build_object('elegivel', true,
    'valor_anterior', v_ant.valor_total,
    'delta_pct', round(v_delta * 100, 1));
END;
$$;

REVOKE ALL ON FUNCTION public.reposicao_pedido_auto_aprovavel(bigint, numeric, numeric) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_pedido_auto_aprovavel(bigint, numeric, numeric) TO service_role;

-- ── D) Tick estendido (corpo VERBATIM da 20260609150000 + marcas [AUTO]) ─────
CREATE OR REPLACE FUNCTION public.reposicao_alerta_pedido_minimo_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_threshold numeric;
  v_fornecedor text;
  r RECORD;
  -- [AUTO 1/4] estado do braço de auto-aprovação
  v_txt text;
  v_auto_on boolean := false;
  v_delta_max numeric;
  v_cooldown numeric;
  v_corte time;
  v_suspenso boolean := false;
  v_dentro_janela boolean := false;
  v_min_agora int;
  v_min_corte int;
  v_elig jsonb;
  v_auto_ok boolean;
BEGIN
  SELECT value::numeric INTO v_threshold
  FROM public.company_config WHERE key = 'reposicao_alerta_pedido_valor_minimo';
  SELECT value INTO v_fornecedor
  FROM public.company_config WHERE key = 'reposicao_alerta_pedido_fornecedor_ilike';

  -- Config ausente/inválida = alerta DESLIGADO (régua comercial, não segurança). Sem alerta
  -- fabricado com régua 0.
  IF v_threshold IS NULL OR v_threshold <= 0
     OR v_fornecedor IS NULL OR btrim(v_fornecedor) = '' THEN
    RETURN;
  END IF;

  -- [AUTO 1/4] configs do braço de auto-aprovação. Config quebrada → braço OFF
  -- (fail-safe: o alerta call-to-action continua; nunca aprova com parâmetro inválido).
  SELECT value INTO v_txt FROM public.company_config WHERE key = 'reposicao_auto_aprovacao_ativa';
  v_auto_on := (v_txt = 'true');
  IF v_auto_on THEN
    SELECT value INTO v_txt FROM public.company_config WHERE key = 'reposicao_auto_aprovacao_delta_max';
    IF v_txt ~ '^[0-9]+(\.[0-9]+)?$' THEN v_delta_max := v_txt::numeric; END IF;
    SELECT value INTO v_txt FROM public.company_config WHERE key = 'reposicao_auto_aprovacao_cooldown_falha_horas';
    IF v_txt ~ '^[0-9]+(\.[0-9]+)?$' THEN v_cooldown := v_txt::numeric; END IF;
    SELECT value INTO v_txt FROM public.company_config WHERE key = 'reposicao_auto_aprovacao_corte_utc';
    IF v_txt ~ '^[0-9]{1,2}:[0-9]{2}$' THEN v_corte := v_txt::time; END IF;
    IF v_delta_max IS NULL OR v_delta_max <= 0 OR v_cooldown IS NULL OR v_corte IS NULL THEN
      v_auto_on := false;
    END IF;
  END IF;

  IF v_auto_on THEN
    -- Auto-suspensão: autonomia NÃO roda com o vigia acusando problema no domínio
    -- (spec §4.5). O tipo 'reposicao_pedido_minimo' (este próprio fluxo) NÃO suspende.
    v_suspenso := EXISTS (
      SELECT 1 FROM public.fin_alertas fa
      WHERE fa.dismissed_at IS NULL
        AND fa.tipo IN ('data_health_reposicao_disparo',
                        'data_health_reposicao_portal_pipeline',
                        'data_health_reposicao_portal_humano',
                        'data_health_reposicao_sugestoes')
    );

    -- Janela de horário: só aprova com >= 45min até o corte de disparo (a espera
    -- até o corte É a janela de veto). Aritmética em minutos UTC — sem wrap de time.
    -- Pedido que cruzar a régua DEPOIS do corte espera a regeneração da manhã
    -- ([INTRADAY 2/4] expira o zumbi e recria) e é avaliado no tick seguinte.
    v_min_agora := EXTRACT(HOUR FROM (now() AT TIME ZONE 'UTC'))::int * 60
                 + EXTRACT(MINUTE FROM (now() AT TIME ZONE 'UTC'))::int;
    v_min_corte := EXTRACT(HOUR FROM v_corte)::int * 60 + EXTRACT(MINUTE FROM v_corte)::int;
    v_dentro_janela := v_min_agora <= (v_min_corte - 45);
  END IF;

  -- 1) NOVOS: pedido pendente ≥ régua do fornecedor configurado, sem alerta ativo → grava
  -- estado + enfileira e-mail (só na transição). Agrupo por (empresa, fornecedor, grupo)
  -- por defesa (a identidade pode ter 2 linhas transitórias: zumbi de ontem + hoje, pré-PR2).
  FOR r IN
    SELECT pcs.empresa, pcs.fornecedor_nome,
           COALESCE(pcs.grupo_codigo, '') AS grupo_codigo,
           MAX(pcs.valor_total) AS valor,
           SUM(COALESCE(pcs.num_skus, 0)) AS num_skus,
           MAX(pcs.id) AS pedido_id,
           COUNT(*) AS qtd_pendentes  -- [AUTO 2/4] >1 = estado anômalo (zumbi) → humano
    FROM public.pedido_compra_sugerido pcs
    WHERE pcs.status = 'pendente_aprovacao'
      AND pcs.fornecedor_nome ILIKE v_fornecedor
      AND pcs.valor_total >= v_threshold
    GROUP BY 1, 2, 3
  LOOP
    -- [AUTO 3/4] tenta a auto-aprovação ANTES de decidir qual e-mail sai. Claim
    -- condicional: corrida com aprovação humana → quem chegar primeiro vence; o
    -- perdedor não loga nem manda e-mail duplicado (FOUND = false).
    v_auto_ok := false;
    IF v_auto_on AND NOT v_suspenso AND v_dentro_janela AND r.qtd_pendentes = 1 THEN
      v_elig := public.reposicao_pedido_auto_aprovavel(r.pedido_id, v_delta_max, v_cooldown);
      IF COALESCE((v_elig->>'elegivel')::boolean, false) THEN
        UPDATE public.pedido_compra_sugerido
        SET aprovado_em = now(),
            aprovado_por = 'auto:sayerlack-v1',
            status = 'aprovado_aguardando_disparo'
        WHERE id = r.pedido_id
          AND status = 'pendente_aprovacao'
          AND aprovado_em IS NULL
          AND cancelado_em IS NULL;
        IF FOUND THEN
          v_auto_ok := true;
          INSERT INTO public.reposicao_auto_aprovacao_log
            (pedido_id, empresa, fornecedor_nome, grupo_codigo, valor_total,
             valor_anterior, delta_pct, regua)
          VALUES
            (r.pedido_id, r.empresa, r.fornecedor_nome, r.grupo_codigo, r.valor,
             (v_elig->>'valor_anterior')::numeric, (v_elig->>'delta_pct')::numeric, v_threshold);
        END IF;
      END IF;
    END IF;

    INSERT INTO public.reposicao_alerta_pedido_minimo
      (empresa, fornecedor_nome, grupo_codigo, pedido_id, valor_alertado, valor_ultimo)
    VALUES (r.empresa, r.fornecedor_nome, r.grupo_codigo, r.pedido_id, r.valor, r.valor)
    ON CONFLICT (empresa, fornecedor_nome, grupo_codigo) WHERE resolvido_em IS NULL
    DO NOTHING;

    IF FOUND THEN
      -- [AUTO 4/4] transição: informativo (máquina aprovou) OU call-to-action (fluxo atual).
      IF v_auto_ok THEN
        INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (
          lower(r.empresa),
          'reposicao_pedido_minimo',
          'atencao',
          '[Compras] Auto-aprovado: pedido ' || r.fornecedor_nome || ' de R$ ' || round(r.valor)::text,
          'O pedido sugerido de ' || r.fornecedor_nome
            || CASE WHEN r.grupo_codigo <> '' THEN ' (grupo ' || r.grupo_codigo || ')' ELSE '' END
            || ' atingiu R$ ' || round(r.valor)::text
            || ' (' || r.num_skus::text || ' SKUs) e foi APROVADO AUTOMATICAMENTE — piloto: delta '
            || COALESCE((v_elig->>'delta_pct')::text, '?') || '% vs último disparo do grupo (R$ '
            || COALESCE(round((v_elig->>'valor_anterior')::numeric)::text, '?')
            || '), dentro do limite. Dispara no próximo corte automático. Para VETAR, cancele em '
            || 'Reposição → Pedidos (https://steu.lovable.app/admin/reposicao/pedidos) antes do corte. '
            || 'Fusível: company_config → reposicao_auto_aprovacao_ativa = false desliga o piloto.',
          'pendente_notificacao'
        );
      ELSE
        -- Transição: 1 e-mail. Link GENÉRICO pra tela (deep-link ?id= morreria na regeneração).
        INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (
          lower(r.empresa),
          'reposicao_pedido_minimo',
          'atencao',
          '[Compras] Pedido ' || r.fornecedor_nome || ' atingiu R$ ' || round(r.valor)::text
            || ' — pronto pra aprovar',
          'O pedido sugerido de ' || r.fornecedor_nome
            || CASE WHEN r.grupo_codigo <> '' THEN ' (grupo ' || r.grupo_codigo || ')' ELSE '' END
            || ' acumulou R$ ' || round(r.valor)::text
            || ' (' || r.num_skus::text || ' SKUs) — acima do mínimo de faturamento (R$ '
            || round(v_threshold)::text || '). Aprovar dispara na hora: '
            || 'Reposição → Pedidos (https://steu.lovable.app/admin/reposicao/pedidos). '
            || 'Quando você aprovar (ou o pedido sair da régua), este aviso re-arma sozinho.',
          'pendente_notificacao'
        );
      END IF;
    ELSE
      IF v_auto_ok THEN
        -- [AUTO 4/4] alerta call-to-action já estava ativo e a máquina aprovou AGORA
        -- (ex.: fusível ligado depois do alerta) → informativo é transição real.
        INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (
          lower(r.empresa),
          'reposicao_pedido_minimo',
          'atencao',
          '[Compras] Auto-aprovado: pedido ' || r.fornecedor_nome || ' de R$ ' || round(r.valor)::text,
          'O pedido sugerido de ' || r.fornecedor_nome
            || CASE WHEN r.grupo_codigo <> '' THEN ' (grupo ' || r.grupo_codigo || ')' ELSE '' END
            || ' (R$ ' || round(r.valor)::text || ', ' || r.num_skus::text
            || ' SKUs) foi APROVADO AUTOMATICAMENTE — piloto: delta '
            || COALESCE((v_elig->>'delta_pct')::text, '?') || '% vs último disparo do grupo (R$ '
            || COALESCE(round((v_elig->>'valor_anterior')::numeric)::text, '?')
            || '). Dispara no próximo corte automático. Para VETAR, cancele em '
            || 'Reposição → Pedidos (https://steu.lovable.app/admin/reposicao/pedidos) antes do corte. '
            || 'Fusível: company_config → reposicao_auto_aprovacao_ativa = false desliga o piloto.',
          'pendente_notificacao'
        );
      ELSE
        -- Alerta já ativo: só atualiza o último valor visto (3.2k→10k NÃO re-spamma; o valor
        -- vivo está no cockpit).
        UPDATE public.reposicao_alerta_pedido_minimo a
        SET valor_ultimo = r.valor, pedido_id = r.pedido_id
        WHERE a.empresa = r.empresa AND a.fornecedor_nome = r.fornecedor_nome
          AND a.grupo_codigo = r.grupo_codigo AND a.resolvido_em IS NULL;
      END IF;
    END IF;
  END LOOP;

  -- 2) RESOLVE (re-arma): alerta ativo sem pedido pendente ≥ régua correspondente — o founder
  -- aprovou/cancelou, o corte expirou, ou o valor caiu. O próximo pedido do grupo que cruzar a
  -- régua gera e-mail NOVO. (Sem filtro de fornecedor aqui de propósito: se o pattern da config
  -- mudar, alertas órfãos do pattern antigo resolvem sozinhos.)
  -- [AUTO] nota: pedido auto-aprovado sai de pendente NESTA execução → o estado da identidade
  -- resolve aqui embaixo no mesmo tick (vida curta, consistente; o informativo já saiu acima).
  UPDATE public.reposicao_alerta_pedido_minimo a
  SET resolvido_em = now()
  WHERE a.resolvido_em IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.pedido_compra_sugerido pcs
      WHERE pcs.empresa = a.empresa
        AND pcs.fornecedor_nome = a.fornecedor_nome
        AND COALESCE(pcs.grupo_codigo, '') = a.grupo_codigo
        AND pcs.status = 'pendente_aprovacao'
        AND pcs.valor_total >= v_threshold
    );
END;
$$;

-- Trava de execução (mesma da 20260609150000 — recriar função NÃO preserva grants implícitos
-- de versões antigas, mas re-declarar é idempotente e auto-documenta).
REVOKE ALL ON FUNCTION public.reposicao_alerta_pedido_minimo_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_alerta_pedido_minimo_tick() TO service_role;

COMMIT;

-- Validação (rodar após o COMMIT):
-- SELECT 'AUTO-APROVACAO PILOTO OK' AS status,
--   (SELECT count(*) FROM company_config WHERE key LIKE 'reposicao_auto_aprovacao%') AS configs_4,
--   (SELECT count(*) FROM pg_tables WHERE tablename='reposicao_auto_aprovacao_log') AS tabela_1,
--   (SELECT count(*) FROM pg_proc WHERE proname='reposicao_pedido_auto_aprovavel') AS elegibilidade_1,
--   (SELECT count(*) FROM pg_proc WHERE proname='reposicao_alerta_pedido_minimo_tick') AS tick_1,
--   (SELECT CASE WHEN prosrc LIKE '%AUTO 3/4%' THEN 1 ELSE 0 END
--      FROM pg_proc WHERE proname='reposicao_alerta_pedido_minimo_tick') AS tick_tem_braco_auto,
--   (SELECT value FROM company_config WHERE key='reposicao_auto_aprovacao_ativa') AS fusivel_off;
```

- [ ] **Step 2: Conferir o verbatim contra a fonte**

Run: `diff <(sed -n '71,152p' supabase/migrations/20260609150000_reposicao_alerta_pedido_minimo.sql) <(grep -v 'AUTO' supabase/migrations/20260610150000_reposicao_auto_aprovacao_piloto.sql | sed -n '/^DECLARE/,/^END;/p')` — não precisa bater 1:1 (o braço novo entremeia), mas leia o diff e confirme que NENHUMA linha do tick original sumiu ou mudou fora das marcas `[AUTO]`. Checklist manual: SELECT das 2 configs originais ✓ guard de config ✓ loop SELECT (+ só `qtd_pendentes`) ✓ INSERT estado ✓ e-mail call-to-action byte-idêntico ✓ UPDATE valor_ultimo ✓ passo 2 RESOLVE ✓.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260610150000_reposicao_auto_aprovacao_piloto.sql
git commit -m "feat(reposicao): migration auto-aprovação Sayerlack — piloto de veto (fusível OFF)"
```

---

### Task 2: Teste PG17 — 15 cenários

**Files:**
- Create: `db/test-auto-aprovacao-piloto.sh` (base: `db/test-alerta-pedido-minimo.sh`)

- [ ] **Step 1: Escrever o script completo**

```bash
#!/usr/bin/env bash
# Teste PG17 da auto-aprovação Sayerlack (piloto de veto) — migration 20260610150000.
# Aplica snapshot + 20260609150000 (alerta, base verbatim) + 20260610150000 e valida
# 15 asserts: aprova elegível (log + e-mail INFORMATIVO, não call-to-action), fusível
# OFF, delta>max, sem referência do grupo, referência stale >90d, item inválido,
# ajustado_humano, cooldown de falha, suspensão por alerta do Sentinela, ciclo
# não-normal, fora da janela de horário, idempotência, corrida com humano, delta por
# GRUPO (não por fornecedor), zumbi duplo (qtd_pendentes>1).
# Base: db/verify-snapshot-replay.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5437
DATA="$(mktemp -d /tmp/pgtest-autoaprov.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-autoaprov.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres autoaprov_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d autoaprov_verify "$@"; }

RR="$(mktemp /tmp/snap-autoaprov.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ stub cron.schedule…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_jobname;
  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(jobid),0)+1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active)
    VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;
SQL

echo "→ migrations: 20260609150000 (alerta) + 20260610150000 (auto-aprovação)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260609150000_reposicao_alerta_pedido_minimo.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260610150000_reposicao_auto_aprovacao_piloto.sql" >/dev/null

echo "→ cenários + asserts…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE d int; v numeric; pid bigint; ref_id bigint; s text;
BEGIN
  -- ── setup: fusível ON, janela aberta (corte 23:59), referência de disparo do grupo G1 ──
  UPDATE company_config SET value = 'true'  WHERE key = 'reposicao_auto_aprovacao_ativa';
  UPDATE company_config SET value = '23:59' WHERE key = 'reposicao_auto_aprovacao_corte_utc';

  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo, criado_em, omie_pedido_compra_numero)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE-2,8000,10,'disparado','normal', now()-interval '2 days','1234')
  RETURNING id INTO ref_id;

  -- ── B1: elegível → auto-aprova + log + e-mail INFORMATIVO (não call-to-action) ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,8400,10,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha)
  VALUES (pid,'111','SKU A',5,5,800,4000), (pid,'222','SKU B',4,4,1100,4400);

  PERFORM public.reposicao_alerta_pedido_minimo_tick();

  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'B1 FALHOU: status=%, esperado aprovado_aguardando_disparo', s; END IF;
  SELECT aprovado_por INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'auto:sayerlack-v1' THEN RAISE EXCEPTION 'B1 FALHOU: aprovado_por=%', s; END IF;
  SELECT count(*) INTO d FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF d <> 1 THEN RAISE EXCEPTION 'B1 FALHOU: % linhas de log, esperado 1', d; END IF;
  SELECT delta_pct INTO v FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF v <> 5.0 THEN RAISE EXCEPTION 'B1 FALHOU: delta_pct=%, esperado 5.0 (8400 vs 8000)', v; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%Auto-aprovado%';
  IF d <> 1 THEN RAISE EXCEPTION 'B1 FALHOU: % e-mails informativos, esperado 1', d; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%pronto pra aprovar%';
  IF d <> 0 THEN RAISE EXCEPTION 'B1 FALHOU: call-to-action saiu junto do informativo'; END IF;
  RAISE NOTICE 'OK B1 — elegível auto-aprova: status + aprovado_por + log(delta 5%%) + informativo único';

  -- ── B2: idempotência — tick de novo não duplica nada ──
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM reposicao_auto_aprovacao_log;
  IF d <> 1 THEN RAISE EXCEPTION 'B2 FALHOU: % logs, esperado 1', d; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo';
  IF d <> 1 THEN RAISE EXCEPTION 'B2 FALHOU: % e-mails, esperado 1', d; END IF;
  RAISE NOTICE 'OK B2 — idempotência: tick repetido é no-op';

  -- ── B3: fusível OFF → NÃO aprova; e-mail call-to-action sai (fluxo atual) ──
  UPDATE company_config SET value = 'false' WHERE key = 'reposicao_auto_aprovacao_ativa';
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,8200,8,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B3 FALHOU: fusível OFF aprovou (status=%)', s; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%pronto pra aprovar%';
  IF d <> 1 THEN RAISE EXCEPTION 'B3 FALHOU: % call-to-action, esperado 1', d; END IF;
  UPDATE company_config SET value = 'true' WHERE key = 'reposicao_auto_aprovacao_ativa';
  RAISE NOTICE 'OK B3 — fusível OFF: comportamento atual intacto';

  -- ── B4: alerta já ativo + fusível religado → auto-aprova e manda informativo ──
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status, aprovado_por INTO s, v FROM (SELECT status, 0::numeric FROM pedido_compra_sugerido WHERE id = pid) t(status, v);
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'aprovado_aguardando_disparo' THEN RAISE EXCEPTION 'B4 FALHOU: status=%', s; END IF;
  SELECT count(*) INTO d FROM fornecedor_alerta WHERE tipo='reposicao_pedido_minimo' AND titulo LIKE '%Auto-aprovado%';
  IF d <> 2 THEN RAISE EXCEPTION 'B4 FALHOU: % informativos, esperado 2', d; END IF;
  RAISE NOTICE 'OK B4 — alerta ativo + fusível religado: aprova e informa (ramo NOT FOUND)';

  -- ── B5: delta > máx → não aprova ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,12000,9,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B5 FALHOU: delta 50%% aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B5 — delta 50%% > máx 30%%: fica humano';

  -- ── B6: grupo SEM referência de disparo → não aprova (primeira compra é humana) ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G9',CURRENT_DATE,8000,5,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B6 FALHOU: grupo sem referência aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B6 — delta por GRUPO: G9 sem disparo prévio fica humano (referência do G1 não vale)';

  -- ── B7: referência stale (>90d) → não aprova ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo, criado_em, omie_pedido_compra_numero)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G8',CURRENT_DATE-100,8000,5,'disparado','normal', now()-interval '100 days','999');
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G8',CURRENT_DATE,8000,5,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B7 FALHOU: referência de 100d valeu'; END IF;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B7 — referência stale (>90d) não vale';

  -- ── B8: item inválido (preço 0) → não aprova ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,8100,2,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha)
  VALUES (pid,'333','SKU C',5,5,0,0);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B8 FALHOU: item preço-0 aprovou'; END IF;
  DELETE FROM pedido_compra_item WHERE pedido_id = pid;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B8 — item com preço 0 fica humano (guard de disparo barraria)';

  -- ── B9: ajustado_humano → não aprova ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,8050,2,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  INSERT INTO pedido_compra_item (pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final, preco_unitario, valor_linha, ajustado_humano)
  VALUES (pid,'444','SKU D',5,5,1610,8050,true);
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B9 FALHOU: pedido ajustado por humano aprovou'; END IF;
  DELETE FROM pedido_compra_item WHERE pedido_id = pid;
  UPDATE pedido_compra_sugerido SET status='cancelado', cancelado_em=now() WHERE id = pid;
  RAISE NOTICE 'OK B9 — ajuste humano = decisão humana';

  -- ── B10: cooldown de falha — auto-aprovado recente do fornecedor em falha_envio ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo, aprovado_em, aprovado_por)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G7',CURRENT_DATE-1,5000,3,'falha_envio','normal', now()-interval '12 hours','auto:sayerlack-v1');
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE,8150,4,'pendente_aprovacao','normal')
  RETURNING id INTO pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B10 FALHOU: cooldown de falha não segurou'; END IF;
  UPDATE pedido_compra_sugerido SET atualizado_em = now() - interval '3 days'
  WHERE fornecedor_nome='RENNER SAYERLACK S/A' AND status='falha_envio';
  RAISE NOTICE 'OK B10 — falha recente de auto-aprovado suspende o fornecedor 48h';

  -- ── B11: alerta ativo do Sentinela (reposição) → suspende ──
  INSERT INTO fin_alertas (company, tipo, severidade, titulo, mensagem)
  VALUES ('oben','data_health_reposicao_disparo','critico','teste','vigia acusando');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B11 FALHOU: aprovou com o vigia acusando'; END IF;
  UPDATE fin_alertas SET dismissed_at = now() WHERE tipo='data_health_reposicao_disparo';
  RAISE NOTICE 'OK B11 — autonomia não roda com alerta ativo de reposição';

  -- ── B12: fora da janela de horário (corte já passou) → não aprova ──
  UPDATE company_config SET value = '00:01' WHERE key = 'reposicao_auto_aprovacao_corte_utc';
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B12 FALHOU: aprovou fora da janela'; END IF;
  UPDATE company_config SET value = '23:59' WHERE key = 'reposicao_auto_aprovacao_corte_utc';
  RAISE NOTICE 'OK B12 — fora da janela (corte passou) espera o dia seguinte';

  -- ── B13: tipo_ciclo não-normal → não aprova ──
  UPDATE pedido_compra_sugerido SET tipo_ciclo = 'oportunidade_promo' WHERE id = pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT status INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'pendente_aprovacao' THEN RAISE EXCEPTION 'B13 FALHOU: ciclo oportunidade aprovou'; END IF;
  UPDATE pedido_compra_sugerido SET tipo_ciclo = 'normal' WHERE id = pid;
  RAISE NOTICE 'OK B13 — oportunidade/promoção é decisão humana';

  -- ── B14: zumbi duplo (2 pendentes da mesma identidade) → não aprova ──
  INSERT INTO pedido_compra_sugerido (empresa, fornecedor_nome, grupo_codigo, data_ciclo, valor_total, num_skus, status, tipo_ciclo)
  VALUES ('OBEN','RENNER SAYERLACK S/A','G1',CURRENT_DATE-1,7900,4,'pendente_aprovacao','normal');
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT count(*) INTO d FROM pedido_compra_sugerido
  WHERE fornecedor_nome='RENNER SAYERLACK S/A' AND grupo_codigo='G1'
    AND status='aprovado_aguardando_disparo' AND aprovado_por='auto:sayerlack-v1'
    AND id IN (pid, (SELECT max(id) FROM pedido_compra_sugerido WHERE grupo_codigo='G1' AND status like 'pendente%'));
  IF d <> 0 THEN RAISE EXCEPTION 'B14 FALHOU: aprovou com identidade duplicada (zumbi)'; END IF;
  DELETE FROM pedido_compra_sugerido WHERE grupo_codigo='G1' AND status='pendente_aprovacao' AND data_ciclo=CURRENT_DATE-1;
  RAISE NOTICE 'OK B14 — identidade com 2 pendentes (zumbi) = estado anômalo, fica humano';

  -- ── B15: corrida com humano — pedido já aprovado entre avaliar e o claim ──
  -- Simulação: aprovação humana ANTES do tick; o claim (WHERE status=pendente) não toca.
  UPDATE pedido_compra_sugerido SET aprovado_em=now(), aprovado_por='founder@colacor', status='aprovado_aguardando_disparo'
  WHERE id = pid;
  PERFORM public.reposicao_alerta_pedido_minimo_tick();
  SELECT aprovado_por INTO s FROM pedido_compra_sugerido WHERE id = pid;
  IF s <> 'founder@colacor' THEN RAISE EXCEPTION 'B15 FALHOU: máquina sobrescreveu aprovação humana (%)', s; END IF;
  SELECT count(*) INTO d FROM reposicao_auto_aprovacao_log WHERE pedido_id = pid;
  IF d <> 0 THEN RAISE EXCEPTION 'B15 FALHOU: logou aprovação que não fez'; END IF;
  RAISE NOTICE 'OK B15 — claim condicional: humano primeiro vence, sem log fantasma';

  RAISE NOTICE '✅ TODOS OS 15 ASSERTS DA AUTO-APROVAÇÃO PASSARAM';
END $$;
SQL

echo "✅ test-auto-aprovacao-piloto: OK"
```

- [ ] **Step 2: Tornar executável e rodar**

Run: `chmod +x db/test-auto-aprovacao-piloto.sh && heavy ./db/test-auto-aprovacao-piloto.sh > /tmp/autoaprov-test.log 2>&1; echo "exit=$?"; tail -25 /tmp/autoaprov-test.log`
Expected: `exit=0` e `✅ TODOS OS 15 ASSERTS DA AUTO-APROVAÇÃO PASSARAM`.

⚠️ Esperado na primeira rodada: erros de coluna/constraint do snapshot stale (ex.: `fin_alertas.company` CHECK, defaults de `pedido_compra_item`). Ajustar os INSERTs do teste (NUNCA a migration) até o harness passar — exceto se o erro revelar bug real da migration; aí conserta a migration e re-roda. Iterar até `exit=0`.

- [ ] **Step 3: Commit**

```bash
git add db/test-auto-aprovacao-piloto.sh
git commit -m "test(reposicao): PG17 — 15 cenários da auto-aprovação Sayerlack"
```

---

### Task 3: Badge "auto" no front (TDD)

**Files:**
- Modify: `src/components/reposicao/pedidos/badges.tsx` (novo `AutoBadge` + render no `StatusComMotivo`)
- Test: `src/components/reposicao/pedidos/__tests__/auto-badge.test.tsx`

A lista usa `select('*')` → `aprovado_por` já chega; `PedidoSugerido` já tem o campo (`types.ts:40`). Zero mudança de query.

- [ ] **Step 1: Escrever o teste que falha**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AutoBadge, StatusComMotivo } from '../badges';
import type { PedidoSugerido } from '../types';

const base = {
  id: 1, empresa: 'OBEN', fornecedor_nome: 'RENNER SAYERLACK S/A', grupo_codigo: 'G1',
  data_ciclo: '2026-06-10', valor_total: 8400, num_skus: 10,
  status: 'aprovado_aguardando_disparo', aprovado_em: '2026-06-10T10:00:00Z',
  aprovado_por: 'auto:sayerlack-v1', cancelado_em: null, mensagem_bloqueio: null,
  resposta_canal: null, status_envio_portal: null, portal_protocolo: null,
  portal_erro: null, split_parent_id: null, split_lote: null, split_total: null,
} as unknown as PedidoSugerido;

describe('AutoBadge', () => {
  it('mostra "auto" quando aprovado_por começa com auto:', () => {
    render(<AutoBadge pedido={base} />);
    expect(screen.getByText('auto')).toBeInTheDocument();
  });

  it('não renderiza pra aprovação humana', () => {
    const humano = { ...base, aprovado_por: 'founder@colacor' } as PedidoSugerido;
    const { container } = render(<AutoBadge pedido={humano} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('não renderiza quando aprovado_por é null', () => {
    const semAprovacao = { ...base, aprovado_por: null } as PedidoSugerido;
    const { container } = render(<AutoBadge pedido={semAprovacao} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('StatusComMotivo inclui o badge auto', () => {
    render(<StatusComMotivo pedido={base} />);
    expect(screen.getByText('auto')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `heavy bun run test -- auto-badge > /tmp/autobadge.log 2>&1; echo "exit=$?"; tail -15 /tmp/autobadge.log`
Expected: `exit=1` — `AutoBadge` não existe (`does not provide an export`).

- [ ] **Step 3: Implementar**

Em `badges.tsx`, adicionar após `StatusBadge` (e incluir `<AutoBadge pedido={pedido} />` dentro do `<div>` do `StatusComMotivo`, logo após `<StatusBadge status={pedido.status} />`):

```tsx
// Piloto N3: marca pedido aprovado pela MÁQUINA (tick de auto-aprovação Sayerlack,
// aprovado_por = 'auto:<estrato>'). Visibilidade de qual compra foi decidida sem humano.
export function AutoBadge({ pedido }: { pedido: PedidoSugerido }) {
  if (!pedido.aprovado_por?.startsWith('auto:')) return null;
  return (
    <Badge
      variant="outline"
      className="bg-status-info-bg text-status-info border-status-info/30 ml-1"
      title={`Aprovado automaticamente (${pedido.aprovado_por})`}
    >
      auto
    </Badge>
  );
}
```

- [ ] **Step 4: Rodar e ver passar + gates**

Run: `heavy bun run test -- auto-badge > /tmp/autobadge.log 2>&1; echo "exit=$?"; tail -8 /tmp/autobadge.log`
Expected: `exit=0`, 4 passed.
Run: `heavy bun run typecheck > /tmp/tc.log 2>&1; echo "exit=$?"` → `exit=0`.
Run: `bun lint > /tmp/lint.log 2>&1; echo "exit=$?"` → `exit=0` (errors-only é o gate).

- [ ] **Step 5: Commit**

```bash
git add src/components/reposicao/pedidos/badges.tsx src/components/reposicao/pedidos/__tests__/auto-badge.test.tsx
git commit -m "feat(reposicao): badge 'auto' em pedido aprovado pela máquina"
```

---

### Task 4: Audit de migrations + suíte completa + PR

- [ ] **Step 1: Regenerar o audit (regra da casa pra toda migration nova)**

Run: `bun run audit:migrations` — regenera `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql`.

- [ ] **Step 2: Suíte completa**

Run: `heavy bun run test > /tmp/suite.log 2>&1; echo "exit=$?"; tail -5 /tmp/suite.log`
Expected: `exit=0`, todos passando (baseline atual ~2975).

- [ ] **Step 3: Re-checar colisão de timestamp e push**

```bash
git fetch origin main --quiet
git ls-tree origin/main supabase/migrations/ --name-only | grep 20260610 || echo "20260610150000 livre"
git add docs/migrations-audit.md scripts/audit-custom-migrations.sql
git commit -m "chore: regenera audit de migrations (20260610150000)"
git push -u origin HEAD
```

Se aparecer outra `20260610*` na main: renomear a migration pra um timestamp maior livre (atualizar TAMBÉM a referência no teste .sh e re-rodar Task 2 Step 2).

- [ ] **Step 4: Abrir o PR (auto-merge; o apply em prod é manual e fica gated no Codex)**

```bash
gh pr create --title "feat(reposicao): N3 — auto-aprovação Sayerlack com piloto de veto" --body "$(cat <<'EOF'
Primeira função do OS a cruzar N2→N3 (escada de autonomia, sessão Prosus 2026-06-10).
Spec: docs/superpowers/specs/2026-06-10-reposicao-auto-aprovacao-sayerlack-design.md

- Tick do alerta R$3k estendido (verbatim + 4 marcas [AUTO]): pedido Sayerlack pendente
  ≥ régua e elegível (delta ≤30% vs último disparo do MESMO GRUPO <90d, itens sãos, sem
  ajuste humano, cooldown de falha, ciclo normal) → aprovado_por='auto:sayerlack-v1' +
  log de auditoria + e-mail INFORMATIVO com janela de veto até o corte de disparo.
- Fusível reposicao_auto_aprovacao_ativa (nasce OFF) + auto-suspensão por alerta ativo
  do Sentinela + janela de horário (≥45min antes do corte).
- PG17: db/test-auto-aprovacao-piloto.sh (15 asserts). Badge "auto" na lista.

**ATENÇÃO: migration manual necessária** — `20260610150000_reposicao_auto_aprovacao_piloto.sql`
(SQL no chat da sessão; BLOCO A = migration com fusível OFF; BLOCO B separado liga o piloto).
⚠️ Apply em prod SÓ depois do Codex challenge adversarial (cota volta 11/06).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
gh pr merge --squash --auto
```

---

### Task 5: Gate Codex + rollout pack (NÃO aplicar em prod antes)

- [ ] **Step 1: Codex challenge adversarial (11/06, cota de volta ~9h24; money-path → xhigh explícito)**

```bash
timeout 1200 codex exec "Challenge adversarial desta migration money-path (auto-aprovação de COMPRA sem humano). Tente quebrar: corrida tick×humano×cron, double-spend (aprovar 2× / e-mail 2×), bypass do fusível/suspensão/janela de horário, delta contra referência errada (grupo vs fornecedor, stale, NaN/Infinity em numeric), interação com a regeneração intraday (limpeza apaga pendentes; zumbis), claim do portal e gate <R\$3k no disparo, RLS/grants do log e das funções (anon/authenticated), e o ramo NOT FOUND do estado anti-spam (e-mail suprimido ou duplicado?). Arquivos: supabase/migrations/20260610150000_reposicao_auto_aprovacao_piloto.sql (novo), supabase/migrations/20260609150000_reposicao_alerta_pedido_minimo.sql (base verbatim), docs/superpowers/specs/2026-06-10-reposicao-auto-aprovacao-sayerlack-design.md (spec). Liste achados P1/P2/P3 com cenário concreto de exploração." -C "$(git rev-parse --show-toplevel)" -s read-only -c 'model_reasoning_effort="xhigh"' < /dev/null
```

(`< /dev/null` obrigatório — `codex exec` pendura esperando stdin sem ele.) Incorporar P1s na migration + re-rodar Task 2 Step 2 antes de qualquer apply.

- [ ] **Step 2: Pré-flight do corte (founder cola no SQL Editor, read-only)**

```sql
SELECT jobname, schedule, active FROM cron.job WHERE jobname ILIKE '%disparar%';
```

Se o schedule do corte NÃO for `0 13 * * *` (13:00 UTC): ajustar a config no BLOCO B (`reposicao_auto_aprovacao_corte_utc` = hora real do cron em UTC). A janela de veto do piloto = tempo entre a auto-aprovação e esse corte.

- [ ] **Step 3: Entregar os blocos de rollout na conversa (padrão §5 do CLAUDE.md)**

BLOCO A = a migration inteira (fusível nasce OFF — aplicar é seguro, nada muda no comportamento).
Validação do BLOCO A = o SELECT comentado no fim da migration (espera `configs_4=4, tabela_1=1, elegibilidade_1=1, tick_1=1, tick_tem_braco_auto=1, fusivel_off=false`).

BLOCO B (founder liga o piloto quando quiser):

```sql
UPDATE public.company_config SET value = 'true'
WHERE key = 'reposicao_auto_aprovacao_ativa';
SELECT 'PILOTO LIGADO' AS status, value FROM public.company_config
WHERE key = 'reposicao_auto_aprovacao_ativa';
```

Query semanal de veto (founder cola toda segunda durante as 3 semanas):

```sql
SELECT date_trunc('week', l.criado_em)::date AS semana,
  count(*) AS auto_aprovados,
  count(*) FILTER (WHERE p.cancelado_em IS NOT NULL) AS vetados,
  count(*) FILTER (WHERE p.status = 'falha_envio') AS falhas_disparo,
  round(100.0 * count(*) FILTER (WHERE p.cancelado_em IS NOT NULL) / NULLIF(count(*),0), 1) AS veto_pct
FROM public.reposicao_auto_aprovacao_log l
LEFT JOIN public.pedido_compra_sugerido p ON p.id = l.pedido_id
GROUP BY 1 ORDER BY 1 DESC;
```

Contrato (spec §4.7): veto <10% por 3 semanas → fase 2 (janela ~2h); veto >25% numa semana OU 1 compra errada → BLOCO B reverso (`value='false'`) + post-mortem.

- [ ] **Step 4: Atualizar `docs/roadmap-sessao.md`** (status da entrega + pendências do founder) e commitar.

---

## Self-review (executado na escrita)

- **Spec coverage:** §4.1 mecânica → Task 1 [AUTO 1-4]; §4.2 elegibilidade (10 critérios) → função + B5-B14; §4.3 claim/disparo → Task 1 + B15 + pré-flight; §4.4 e-mails (3 ramos + cuidado do resolve) → Task 1 [AUTO 4/4] (informativo sai ANTES do passo 2 resolver) + B1/B3/B4; §4.5 fusível/suspensão → B3/B11; §4.6 log/métrica → tabela + query de veto; §4.7 critérios → contrato no rollout; §4.8 badge → Task 3; §7 rollout → Tasks 4-5. Não-objetivos (§5) respeitados: zero mudança em RPC de geração, disparo, edge, classificador do Cockpit.
- **Sem placeholders:** todo código completo (migration, teste, badge, comandos).
- **Consistência de tipos/nomes:** `reposicao_pedido_auto_aprovavel(bigint, numeric, numeric)` igual em migration/teste; `auto:sayerlack-v1` igual em migration/teste/badge-title; configs com os mesmos nomes em migration/teste/BLOCO B.
