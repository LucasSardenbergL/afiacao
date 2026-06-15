-- Reposição — alerta "pedido Sayerlack atingiu o mínimo de faturamento (R$3k)" (PR1)
-- ============================================================================
-- Spec: docs/superpowers/specs/2026-06-09-reposicao-intraday-alerta-3k-design.md
--
-- R$3.000 é o MÍNIMO DE FATURAMENTO da Sayerlack: pedido sugerido abaixo disso não fatura.
-- O founder quer 1 e-mail POR PEDIDO sugerido (identidade fornecedor+grupo) que atinja a régua
-- em pendente_aprovacao — várias vezes ao dia, pedidos diferentes. Anti-spam por TRANSIÇÃO
-- (padrão fin_sync_watchdog): UNIQUE parcial WHERE resolvido_em IS NULL + ON CONFLICT DO
-- NOTHING + IF FOUND → enfileira fornecedor_alerta (dispatch-notifications */30 já manda).
-- Re-arma quando o pedido sai de pendente (aprovado/cancelado/expirado) ou cai abaixo da régua.
--
-- SQL puro (sem edge nova). O tick roda por cron */30 E (PR2) ao fim da edge gerar-pedidos-diario.
-- A MESMA config (company_config) alimenta o GATE de disparo <R$3k do PR2 — uma régua, dois usos.
--
-- ⚠️ Migration MANUAL (Lovable): colar no SQL Editor → Run. Ver bloco de validação no fim.

BEGIN;

-- ── A) CHECK de fornecedor_alerta.tipo estendido ─────────────────────────────
-- Lista VIGENTE = 20260605120000 (11 tipos; o schema-snapshot está stale com 7) + o novo.
ALTER TABLE public.fornecedor_alerta DROP CONSTRAINT IF EXISTS fornecedor_alerta_tipo_check;
ALTER TABLE public.fornecedor_alerta ADD CONSTRAINT fornecedor_alerta_tipo_check
  CHECK (tipo IN ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro',
    'mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla',
    'erro_app','outro','param_auto_resumo','reposicao_pedido_minimo'));

-- ── B) Config: a régua e o fornecedor (text key/value, cast na leitura) ──────
INSERT INTO public.company_config (key, value) VALUES
  ('reposicao_alerta_pedido_valor_minimo', '3000'),
  ('reposicao_alerta_pedido_fornecedor_ilike', '%SAYERLACK%')
ON CONFLICT (key) DO NOTHING;

-- ── C) Tabela de estado (1 alerta ativo por empresa+fornecedor+grupo) ────────
-- grupo_codigo NOT NULL DEFAULT '': NULL e '' são a MESMA identidade — UNIQUE parcial com
-- coluna NULL deixaria duplicar (NULL <> NULL). pedido_id é só informativo: a regeneração
-- intra-day apaga/recria os pedidos (id novo), a identidade estável é (fornecedor, grupo).
CREATE TABLE IF NOT EXISTS public.reposicao_alerta_pedido_minimo (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  empresa text NOT NULL,
  fornecedor_nome text NOT NULL,
  grupo_codigo text NOT NULL DEFAULT '',
  pedido_id bigint,
  valor_alertado numeric NOT NULL,
  valor_ultimo numeric NOT NULL,
  alertado_em timestamptz NOT NULL DEFAULT now(),
  resolvido_em timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS reposicao_alerta_pedido_minimo_ativo
  ON public.reposicao_alerta_pedido_minimo (empresa, fornecedor_nome, grupo_codigo)
  WHERE resolvido_em IS NULL;

ALTER TABLE public.reposicao_alerta_pedido_minimo ENABLE ROW LEVEL SECURITY;

-- Staff lê (diagnóstico); escrita SÓ pelo tick (SECURITY DEFINER) / service_role (bypassa RLS).
DROP POLICY IF EXISTS "Staff lê alertas de pedido mínimo" ON public.reposicao_alerta_pedido_minimo;
CREATE POLICY "Staff lê alertas de pedido mínimo" ON public.reposicao_alerta_pedido_minimo
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = (SELECT auth.uid()) AND ur.role IN ('employee','master')
  ));

-- ── D) Tick: detecta transição, enfileira e-mail, resolve/re-arma ────────────
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

  -- 1) NOVOS: pedido pendente ≥ régua do fornecedor configurado, sem alerta ativo → grava
  -- estado + enfileira e-mail (só na transição). Agrupo por (empresa, fornecedor, grupo)
  -- por defesa (a identidade pode ter 2 linhas transitórias: zumbi de ontem + hoje, pré-PR2).
  FOR r IN
    SELECT pcs.empresa, pcs.fornecedor_nome,
           COALESCE(pcs.grupo_codigo, '') AS grupo_codigo,
           MAX(pcs.valor_total) AS valor,
           SUM(COALESCE(pcs.num_skus, 0)) AS num_skus,
           MAX(pcs.id) AS pedido_id
    FROM public.pedido_compra_sugerido pcs
    WHERE pcs.status = 'pendente_aprovacao'
      AND pcs.fornecedor_nome ILIKE v_fornecedor
      AND pcs.valor_total >= v_threshold
    GROUP BY 1, 2, 3
  LOOP
    INSERT INTO public.reposicao_alerta_pedido_minimo
      (empresa, fornecedor_nome, grupo_codigo, pedido_id, valor_alertado, valor_ultimo)
    VALUES (r.empresa, r.fornecedor_nome, r.grupo_codigo, r.pedido_id, r.valor, r.valor)
    ON CONFLICT (empresa, fornecedor_nome, grupo_codigo) WHERE resolvido_em IS NULL
    DO NOTHING;

    IF FOUND THEN
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
    ELSE
      -- Alerta já ativo: só atualiza o último valor visto (3.2k→10k NÃO re-spamma; o valor
      -- vivo está no cockpit).
      UPDATE public.reposicao_alerta_pedido_minimo a
      SET valor_ultimo = r.valor, pedido_id = r.pedido_id
      WHERE a.empresa = r.empresa AND a.fornecedor_nome = r.fornecedor_nome
        AND a.grupo_codigo = r.grupo_codigo AND a.resolvido_em IS NULL;
    END IF;
  END LOOP;

  -- 2) RESOLVE (re-arma): alerta ativo sem pedido pendente ≥ régua correspondente — o founder
  -- aprovou/cancelou, o corte expirou, ou o valor caiu. O próximo pedido do grupo que cruzar a
  -- régua gera e-mail NOVO. (Sem filtro de fornecedor aqui de propósito: se o pattern da config
  -- mudar, alertas órfãos do pattern antigo resolvem sozinhos.)
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

-- Trava de execução: cron SQL local roda como owner; a edge chama via service_role.
-- (Lição §10: REVOKE de PUBLIC não basta — anon/authenticated têm grant explícito no Supabase.)
REVOKE ALL ON FUNCTION public.reposicao_alerta_pedido_minimo_tick() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_alerta_pedido_minimo_tick() TO service_role;

-- ── E) Cron */30 — SQL LOCAL (sem net.http_post → sem armadilha do timeout 5s) ───────────────
SELECT cron.schedule(
  'reposicao-alerta-pedido-minimo',
  '*/30 * * * *',
  $$SELECT public.reposicao_alerta_pedido_minimo_tick()$$
);

COMMIT;

-- Validação (rodar após o COMMIT):
-- SELECT 'ALERTA R$3K OK' AS status,
--   (SELECT count(*) FROM pg_constraint WHERE conname='fornecedor_alerta_tipo_check'
--     AND pg_get_constraintdef(oid) LIKE '%reposicao_pedido_minimo%') AS check_ok,
--   (SELECT count(*) FROM company_config WHERE key LIKE 'reposicao_alerta_pedido%') AS configs_2,
--   (SELECT count(*) FROM pg_tables WHERE tablename='reposicao_alerta_pedido_minimo') AS tabela_1,
--   (SELECT count(*) FROM pg_proc WHERE proname='reposicao_alerta_pedido_minimo_tick') AS tick_1,
--   (SELECT count(*) FROM cron.job WHERE jobname='reposicao-alerta-pedido-minimo') AS cron_1;
