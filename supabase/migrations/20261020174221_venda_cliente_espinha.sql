-- ============================================================================================
-- Venda por cliente — Task 1: ESPINHA (sugestão com identidade, contato e desfecho automático)
-- Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md §6, §7 Fase 0, §8
-- Plano: docs/superpowers/plans/2026-10-20-venda-por-cliente.md, Task 1
-- Prova PG17: db/test-venda-espinha.sh (os dois locales + --falsificar)
--
-- Incidente que justifica o sensor (CLAUDE.md, máquina meta): 17.316 recomendações e 955 planos
-- táticos em prod com 0 desfechos. Toda sugestão que a farmer VÊ passa a ter identidade, e um job
-- casa sugestão × pedido do Omie: virou_pedido | nao_virou | nao_medivel (ausente ≠ zero).
--
-- Caminho de apply: `bun run db:aplicar` — a transação é do EXECUTOR, por isso este arquivo NÃO
-- leva BEGIN/COMMIT (o executor recusa). Idempotente: re-aplicar não duplica nem reseta onda ligada.
--
-- Decisões que o plano deixou ao construtor (registradas no PR):
--  • `vendas_sync_heartbeat` (nome do plano) NÃO existe em prod. O sinal real do sync de pedidos de
--    venda é `fin_sync_log` (action='sync_pedidos', status='complete', companies={<conta>}; cron
--    2/2h com date_from = hoje_SP − 5) + `vendas_sync_cursor` (janelas de backfill completas).
--    Um dia x está COBERTO se um sync completo começou em [x+1, x+5] (SP) ou uma janela de backfill
--    completa contém x e terminou depois de x. Dia descoberto que nenhum sync futuro ainda pode
--    cobrir (x+5 < hoje) → nao_medivel/sync_atrasado. Descoberto mas ainda cobrível → a linha fica
--    ABERTA (desfecho NULL) e é reavaliada amanhã — nunca vira nao_virou por falta de dado.
--  • Janela é semiaberta: [dia_referencia, dia_referencia + janela) — 14 dias = d..d+13. Assim a
--    linha fecha quando dia_referencia + janela ≤ hoje e o último dia da janela já terminou.
--  • Pedido casado PROVA a venda mesmo com sync incompleto (evidência positiva): virou_pedido.
--  • Preço líquido = (quantity × unit_price − desconto_valor) / quantity. desconto_valor NULL é
--    "não apurado" (≠ 0): se o bruto já fica abaixo do alvo × 0,99 o preço não bateu; senão o
--    desfecho é nao_medivel/desconto_nao_apurado. valor_realizado = soma líquida dos itens casados,
--    NULL se algum deles tiver desconto não apurado (nunca o bruto fingindo de líquido).
--  • Comprador é resolvido alias → canônico nos DOIS lados (sugestão, pedido e carteira: 1.633
--    linhas de carteira_assignments estão no id do alias em prod, medido 2026-10-20).
--  • Desliga o cron do plano tático (spec §5): custo de LLM sem consumidor, 955 planos/0 desfechos.
--    Recriável pelo comando guardado em supabase/cron-jobs-snapshot.tsv.
-- ============================================================================================

-- ── 1. Configuração (liga/desliga das ondas, teto, janelas) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.venda_config (
  chave         text PRIMARY KEY,
  valor         jsonb NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.venda_config (chave, valor) VALUES
  ('onda_recompra',        'false'::jsonb),
  ('onda_complemento',     'false'::jsonb),
  ('onda_preco',           'false'::jsonb),
  ('teto_maiores_atrasos', '10'::jsonb),
  ('janela_dias',          '{"recompra":14,"complemento":30,"preco":30}'::jsonb)
ON CONFLICT (chave) DO NOTHING;

-- ── 2. A sugestão com identidade ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.venda_sugestao (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo                text NOT NULL CHECK (tipo IN ('recompra','complemento','preco')),
  fase                text NOT NULL CHECK (fase IN ('historico','sombra','ativa')),
  dia_referencia      date NOT NULL,
  gerada_em           timestamptz NOT NULL DEFAULT now(),
  farmer_user_id      uuid NOT NULL,
  comprador_id        uuid NOT NULL,
  empresa             text NOT NULL CHECK (empresa IN ('oben','colacor','colacor_sc')),
  omie_codigo_produto bigint,
  familia             text,
  qtd_ref             numeric CHECK (qtd_ref IS NULL OR qtd_ref > 0),
  valor_ref           numeric CHECK (valor_ref IS NULL OR valor_ref > 0),   -- ausente = NULL, nunca 0
  preco_alvo          numeric CHECK (preco_alvo IS NULL OR preco_alvo > 0),
  motivo_entrada      text NOT NULL,
  mostrada_em         timestamptz,
  desfecho            text CHECK (desfecho IN ('virou_pedido','nao_virou','nao_medivel')),
  desfecho_motivo     text,
  sales_order_id      uuid,
  valor_realizado     numeric,
  avaliado_em         timestamptz,
  CONSTRAINT venda_sugestao_alvo_ck CHECK (
    (tipo IN ('recompra','preco') AND omie_codigo_produto IS NOT NULL)
    OR (tipo = 'complemento' AND familia IS NOT NULL)),
  CONSTRAINT venda_sugestao_preco_alvo_ck CHECK ((tipo = 'preco') = (preco_alvo IS NOT NULL)),
  CONSTRAINT venda_sugestao_avaliado_ck CHECK ((desfecho IS NULL) = (avaliado_em IS NULL)),
  CONSTRAINT venda_sugestao_virou_ck CHECK (desfecho IS DISTINCT FROM 'virou_pedido' OR sales_order_id IS NOT NULL),
  CONSTRAINT venda_sugestao_medivel_ck CHECK (desfecho IS DISTINCT FROM 'nao_medivel' OR desfecho_motivo IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS venda_sugestao_chave_uq ON public.venda_sugestao
  (dia_referencia, farmer_user_id, comprador_id, tipo, empresa, COALESCE(omie_codigo_produto, 0), COALESCE(familia, ''), fase);
CREATE INDEX IF NOT EXISTS idx_venda_sugestao_farmer_dia_ativa ON public.venda_sugestao (farmer_user_id, dia_referencia)
  WHERE fase = 'ativa';
CREATE INDEX IF NOT EXISTS idx_venda_sugestao_aberta ON public.venda_sugestao (dia_referencia)
  WHERE desfecho IS NULL;

-- ── 3. Desfecho manual da ligação (1 escritor: venda_registrar_contato) ──────────────────────
CREATE TABLE IF NOT EXISTS public.venda_contato (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_user_id uuid NOT NULL,
  comprador_id   uuid NOT NULL,
  dia            date NOT NULL,
  resultado      text NOT NULL CHECK (resultado IN ('vendeu','vai_pedir','sem_interesse','nao_atendeu')),
  motivo         text CHECK (motivo IS NULL OR resultado = 'sem_interesse'),
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT venda_contato_dia_uq UNIQUE (farmer_user_id, comprador_id, dia)
);

-- ── 4. RLS + privilégios de tabela (ninguém escreve direto; só RPC SECURITY DEFINER) ─────────
ALTER TABLE public.venda_config   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venda_sugestao ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venda_contato  ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.venda_config, public.venda_sugestao, public.venda_contato FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.venda_config, public.venda_sugestao, public.venda_contato TO authenticated;
GRANT ALL ON public.venda_config, public.venda_sugestao, public.venda_contato TO service_role;

DROP POLICY IF EXISTS venda_config_select_staff ON public.venda_config;
CREATE POLICY venda_config_select_staff ON public.venda_config FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'employee'::public.app_role) OR public.has_role(auth.uid(), 'master'::public.app_role));

-- Farmer lê só as SUAS linhas ATIVAS (historico/sombra são linha de base, invisíveis a ela); master lê tudo.
DROP POLICY IF EXISTS venda_sugestao_select ON public.venda_sugestao;
CREATE POLICY venda_sugestao_select ON public.venda_sugestao FOR SELECT TO authenticated
  USING ((farmer_user_id = auth.uid() AND fase = 'ativa') OR public.has_role(auth.uid(), 'master'::public.app_role));

DROP POLICY IF EXISTS venda_contato_select ON public.venda_contato;
CREATE POLICY venda_contato_select ON public.venda_contato FOR SELECT TO authenticated
  USING (farmer_user_id = auth.uid() OR public.has_role(auth.uid(), 'master'::public.app_role));

-- ── 5. Cobertura do sync de vendas num dia (prova POSITIVA; sem prova = descoberto) ──────────
CREATE OR REPLACE FUNCTION private.venda_sync_dia_coberto(p_empresa text, p_dia date)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  -- Sync incremental (cron vendas-sync-pedidos-<conta>-2h): date_from = hoje_SP − 5, então uma
  -- rodada completa que COMEÇOU no dia y (SP) cobre os pedidos de y−5..y. Para o dia x estar
  -- inteiro no banco, a rodada tem de começar DEPOIS de x terminar: y ∈ [x+1, x+5].
  SELECT EXISTS (
           SELECT 1 FROM public.fin_sync_log l
            WHERE l.action = 'sync_pedidos'
              AND l.status = 'complete'
              AND l.companies = ARRAY[p_empresa]::text[]
              AND l.started_at >= ((p_dia + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')
              AND l.started_at <  ((p_dia + 6)::timestamp AT TIME ZONE 'America/Sao_Paulo'))
      OR EXISTS (
           SELECT 1 FROM public.vendas_sync_cursor c
            WHERE c.account = p_empresa
              AND c.completed_at IS NOT NULL
              AND c.falhou_em IS NULL
              AND p_dia BETWEEN c.date_from AND c.date_to
              AND c.completed_at >= ((p_dia + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo'));
$$;
REVOKE ALL ON FUNCTION private.venda_sync_dia_coberto(text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.venda_sync_dia_coberto(text, date) TO service_role;

-- ── 6. Job de desfecho (cron 09:30 UTC, depois de um ciclo de sync) ─────────────────────────
CREATE OR REPLACE FUNCTION public.venda_fechar_desfechos(p_hoje date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date))
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_janela jsonb;
  v_n      integer;
BEGIN
  IF p_hoje IS NULL THEN
    RAISE EXCEPTION 'venda_fechar_desfechos: p_hoje NULL' USING ERRCODE = '22023';
  END IF;

  SELECT valor INTO v_janela FROM public.venda_config WHERE chave = 'janela_dias';
  IF jsonb_typeof(v_janela -> 'recompra') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_janela -> 'complemento') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v_janela -> 'preco') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'venda_fechar_desfechos: venda_config.janela_dias ausente ou incompleta' USING ERRCODE = '22023';
  END IF;

  -- Um fechamento por vez (cron + chamada manual da reconstrução histórica).
  PERFORM pg_advisory_xact_lock(hashtext('venda_fechar_desfechos'));

  WITH jan(tipo, dias) AS (
    VALUES ('recompra',    (v_janela ->> 'recompra')::int),
           ('complemento', (v_janela ->> 'complemento')::int),
           ('preco',       (v_janela ->> 'preco')::int)
  ),
  alvo AS (
    SELECT s.id, s.tipo, s.empresa,
           COALESCE(ca.canonical_user_id, s.comprador_id) AS comprador,
           s.omie_codigo_produto, s.familia, s.preco_alvo,
           s.dia_referencia AS de,
           s.dia_referencia + j.dias AS ate                  -- exclusivo
      FROM public.venda_sugestao s
      JOIN jan j ON j.tipo = s.tipo
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = s.comprador_id AND ca.status = 'active'
     WHERE s.desfecho IS NULL
       AND s.dia_referencia + j.dias <= p_hoje
  ),
  pedido AS (
    -- Universo de venda de src/lib/farmer/universo-pedidos.ts (denylist; NULL não passa).
    SELECT so.id, so.account,
           COALESCE(ca.canonical_user_id, so.customer_user_id) AS comprador,
           COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS data_pedido
      FROM public.sales_orders so
      LEFT JOIN public.customer_canonical_alias ca
             ON ca.alias_user_id = so.customer_user_id AND ca.status = 'active'
     WHERE so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
  ),
  item AS (
    SELECT a.id AS sug_id, a.tipo, a.preco_alvo, p.id AS so_id, p.data_pedido,
           oi.quantity * oi.unit_price - oi.desconto_valor                          AS valor_liq,
           (oi.quantity * oi.unit_price - oi.desconto_valor) / NULLIF(oi.quantity, 0) AS preco_liq,
           oi.unit_price                                                           AS preco_bruto
      FROM alvo a
      JOIN pedido p
        ON p.comprador = a.comprador
       AND p.account = a.empresa
       AND p.data_pedido >= a.de
       AND p.data_pedido <  a.ate
      JOIN public.order_items oi ON oi.sales_order_id = p.id
     WHERE (a.tipo IN ('recompra','preco') AND oi.omie_codigo_produto = a.omie_codigo_produto)
        OR (a.tipo = 'complemento' AND EXISTS (
              SELECT 1 FROM public.omie_products op
               WHERE op.omie_codigo_produto = oi.omie_codigo_produto
                 AND op.account = p.account
                 AND op.familia = a.familia))
  ),
  item_q AS (
    SELECT i.*,
           CASE WHEN i.tipo <> 'preco'                       THEN true
                WHEN i.preco_liq IS NOT NULL                 THEN i.preco_liq >= i.preco_alvo * 0.99
                WHEN i.preco_bruto < i.preco_alvo * 0.99     THEN false   -- desconto só abaixa
                ELSE NULL                                                -- desconto não apurado
           END AS qualifica
      FROM item i
  ),
  agg AS (
    SELECT sug_id,
           (array_agg(so_id ORDER BY data_pedido, so_id) FILTER (WHERE qualifica))[1] AS so_id,
           CASE WHEN bool_and(valor_liq IS NOT NULL) FILTER (WHERE qualifica)
                THEN sum(valor_liq) FILTER (WHERE qualifica) END                     AS valor,
           bool_or(qualifica IS NULL)                                                AS indeterminado
      FROM item_q
     GROUP BY sug_id
  ),
  faixa AS (
    SELECT empresa, min(de) AS de, max(ate) AS ate FROM alvo GROUP BY empresa
  ),
  descoberto AS (
    SELECT f.empresa, g.d::date AS dia
      FROM faixa f
      CROSS JOIN LATERAL generate_series(f.de, f.ate - 1, interval '1 day') AS g(d)
     WHERE NOT private.venda_sync_dia_coberto(f.empresa, g.d::date)
  ),
  decisao AS (
    SELECT a.id, g.so_id, g.valor,
           CASE
             WHEN g.so_id IS NOT NULL THEN 'virou_pedido'
             WHEN g.indeterminado     THEN 'nao_medivel'
             WHEN EXISTS (SELECT 1 FROM descoberto x
                           WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate
                             AND x.dia + 5 < p_hoje)           THEN 'nao_medivel'
             WHEN EXISTS (SELECT 1 FROM descoberto x
                           WHERE x.empresa = a.empresa AND x.dia >= a.de AND x.dia < a.ate)
                                                               THEN NULL   -- ainda cobrível: reavalia amanhã
             ELSE 'nao_virou'
           END AS desfecho,
           CASE
             WHEN g.so_id IS NOT NULL THEN NULL
             WHEN g.indeterminado     THEN 'desconto_nao_apurado'
             ELSE 'sync_atrasado'
           END AS motivo
      FROM alvo a
      LEFT JOIN agg g ON g.sug_id = a.id
  )
  UPDATE public.venda_sugestao s
     SET desfecho        = d.desfecho,
         desfecho_motivo = CASE WHEN d.desfecho = 'nao_medivel' THEN d.motivo END,
         sales_order_id  = d.so_id,
         valor_realizado = CASE WHEN d.desfecho = 'virou_pedido' THEN d.valor END,
         avaliado_em     = now()
    FROM decisao d
   WHERE d.id = s.id
     AND d.desfecho IS NOT NULL
     AND s.desfecho IS NULL;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.venda_fechar_desfechos(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venda_fechar_desfechos(date) TO service_role;

-- ── 7. RPCs da farmer ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.venda_minhas_sugestoes(p_dia date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo')::date))
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'venda_minhas_sugestoes: sem sessao' USING ERRCODE = '42501';
  END IF;
  IF p_dia IS NULL THEN
    RAISE EXCEPTION 'venda_minhas_sugestoes: p_dia NULL' USING ERRCODE = '22023';
  END IF;

  WITH s AS (
    SELECT s.*, op.descricao
      FROM public.venda_sugestao s
      LEFT JOIN LATERAL (
        SELECT o.descricao FROM public.omie_products o
         WHERE o.omie_codigo_produto = s.omie_codigo_produto AND o.account = s.empresa
         LIMIT 1) op ON true
     WHERE s.fase = 'ativa'
       AND s.farmer_user_id = v_uid
       AND s.dia_referencia = p_dia
  ),
  c AS (
    SELECT s.comprador_id,
           min(s.motivo_entrada) AS motivo_entrada,
           -- ausente ≠ zero: total só quando TODAS as sugestões têm valor de referência.
           CASE WHEN bool_and(s.valor_ref IS NOT NULL) THEN sum(s.valor_ref) END AS valor_ref_total,
           jsonb_agg(jsonb_build_object(
             'id', s.id, 'tipo', s.tipo, 'empresa', s.empresa,
             'omie_codigo_produto', s.omie_codigo_produto, 'descricao', s.descricao,
             'familia', s.familia, 'qtd_ref', s.qtd_ref, 'valor_ref', s.valor_ref,
             'preco_alvo', s.preco_alvo)
             ORDER BY s.tipo, s.valor_ref DESC NULLS LAST, s.omie_codigo_produto, s.familia) AS sugestoes
      FROM s
     GROUP BY s.comprador_id
  )
  SELECT jsonb_build_object(
           'dia', p_dia,
           'compradores', COALESCE(jsonb_agg(jsonb_build_object(
               'comprador_id', c.comprador_id,
               'nome', pr.nome,
               'telefone', pr.telefone,
               'motivo_entrada', c.motivo_entrada,
               'valor_ref_total', c.valor_ref_total,
               'sugestoes', c.sugestoes)
             ORDER BY c.valor_ref_total DESC NULLS LAST, c.comprador_id), '[]'::jsonb))
    INTO v_out
    FROM c
    LEFT JOIN LATERAL (
      SELECT COALESCE(p.name, p.razao_social) AS nome, p.phone AS telefone
        FROM public.profiles p WHERE p.user_id = c.comprador_id
       ORDER BY p.created_at LIMIT 1) pr ON true;

  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION public.venda_minhas_sugestoes(date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_minhas_sugestoes(date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.venda_marcar_mostrada(p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_n   integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'venda_marcar_mostrada: sem sessao' USING ERRCODE = '42501';
  END IF;
  IF p_ids IS NULL OR cardinality(p_ids) = 0 THEN
    RETURN 0;
  END IF;
  IF cardinality(p_ids) > 500 THEN
    RAISE EXCEPTION 'venda_marcar_mostrada: mais de 500 ids' USING ERRCODE = '22023';
  END IF;

  -- Primeira exibição vence; só linhas ATIVAS da própria farmer (na lente "Ver como" o uid é o
  -- do master, que não é dono de nada — não fabrica "mostrada").
  UPDATE public.venda_sugestao
     SET mostrada_em = now()
   WHERE id = ANY (p_ids)
     AND farmer_user_id = v_uid
     AND fase = 'ativa'
     AND mostrada_em IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION public.venda_marcar_mostrada(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_marcar_mostrada(uuid[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.venda_registrar_contato(p_comprador uuid, p_resultado text, p_motivo text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_comprador uuid;
  v_motivo    text := NULLIF(btrim(p_motivo), '');
  v_dia       date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_id        uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'venda_registrar_contato: sem sessao' USING ERRCODE = '42501';
  END IF;
  IF p_comprador IS NULL THEN
    RAISE EXCEPTION 'venda_registrar_contato: comprador NULL' USING ERRCODE = '22023';
  END IF;
  IF p_resultado IS NULL OR p_resultado NOT IN ('vendeu','vai_pedir','sem_interesse','nao_atendeu') THEN
    RAISE EXCEPTION 'venda_registrar_contato: resultado invalido' USING ERRCODE = '22023';
  END IF;
  IF v_motivo IS NOT NULL AND p_resultado <> 'sem_interesse' THEN
    RAISE EXCEPTION 'venda_registrar_contato: motivo so com sem_interesse' USING ERRCODE = '22023';
  END IF;
  IF length(v_motivo) > 500 THEN
    RAISE EXCEPTION 'venda_registrar_contato: motivo longo demais' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(
           (SELECT ca.canonical_user_id FROM public.customer_canonical_alias ca
             WHERE ca.alias_user_id = p_comprador AND ca.status = 'active'),
           p_comprador)
    INTO v_comprador;

  -- Carteira do CHAMADOR (auth.uid() fixo), alias resolvido dos dois lados.
  IF NOT EXISTS (
       SELECT 1
         FROM public.carteira_assignments c
         LEFT JOIN public.customer_canonical_alias ca
                ON ca.alias_user_id = c.customer_user_id AND ca.status = 'active'
        WHERE c.owner_user_id = v_uid
          AND COALESCE(ca.canonical_user_id, c.customer_user_id) = v_comprador) THEN
    RAISE EXCEPTION 'venda_registrar_contato: comprador fora da carteira' USING ERRCODE = '42501';
  END IF;

  -- Último toque do dia vence.
  INSERT INTO public.venda_contato (farmer_user_id, comprador_id, dia, resultado, motivo)
  VALUES (v_uid, v_comprador, v_dia, p_resultado, v_motivo)
  ON CONFLICT (farmer_user_id, comprador_id, dia)
  DO UPDATE SET resultado = EXCLUDED.resultado, motivo = EXCLUDED.motivo, atualizado_em = now()
  RETURNING id INTO v_id;

  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.venda_registrar_contato(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_registrar_contato(uuid, text, text) TO authenticated, service_role;

-- ── 8. Crons: desfecho 09:30 UTC; plano tático desligado ─────────────────────────────────────
SELECT cron.schedule('venda-fechar-desfechos', '30 9 * * *', 'SELECT public.venda_fechar_desfechos();');

SELECT cron.unschedule('tactical-plans-batch-nightly')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tactical-plans-batch-nightly');

-- ── 9. Postcondição: aborta o apply se qualquer peça não pegou ───────────────────────────────
DO $post$
DECLARE
  f text;
  t text;
BEGIN
  -- A1 tabelas com RLS ligada
  FOREACH t IN ARRAY ARRAY['venda_config','venda_sugestao','venda_contato'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = 'public' AND c.relname = t AND c.relkind = 'r' AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'A1 FALHOU: public.% ausente ou sem RLS', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || t, 'DELETE') THEN
      RAISE EXCEPTION 'A1 FALHOU: public.% com privilegio de escrita para authenticated ou leitura para anon', t;
    END IF;
  END LOOP;

  -- A2 chave única da sugestão (o gerador da Task 4 depende dela para não duplicar)
  IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
                  WHERE c.relname = 'venda_sugestao_chave_uq' AND i.indisunique AND i.indisvalid) THEN
    RAISE EXCEPTION 'A2 FALHOU: venda_sugestao_chave_uq ausente ou invalido';
  END IF;

  -- A3 ACL das funções: RPCs da farmer abertas só a authenticated; o job e o helper, a ninguém.
  FOREACH f IN ARRAY ARRAY['public.venda_minhas_sugestoes(date)','public.venda_marcar_mostrada(uuid[])',
                           'public.venda_registrar_contato(uuid,text,text)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'A3 FALHOU: ACL de % (anon/PUBLIC sem, authenticated com)', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.venda_fechar_desfechos(date)','private.venda_sync_dia_coberto(text,date)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'A3 FALHOU: % executavel por anon/PUBLIC/authenticated', f;
    END IF;
  END LOOP;

  -- A4 SECURITY DEFINER com search_path fixo nas 4 funções públicas
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('venda_minhas_sugestoes','venda_marcar_mostrada','venda_registrar_contato','venda_fechar_desfechos')
         AND p.prosecdef
         AND p.proconfig @> ARRAY['search_path=public, pg_temp']) <> 4 THEN
    RAISE EXCEPTION 'A4 FALHOU: funcoes venda_* sem SECURITY DEFINER/search_path fixo (ou sobrecarga extra)';
  END IF;

  -- A5 configuração semeada (valor não é conferido: re-apply não pode resetar onda já ligada)
  IF (SELECT count(*) FROM public.venda_config
       WHERE (chave IN ('onda_recompra','onda_complemento','onda_preco') AND jsonb_typeof(valor) = 'boolean')
          OR (chave = 'teto_maiores_atrasos' AND jsonb_typeof(valor) = 'number')
          OR (chave = 'janela_dias' AND jsonb_typeof(valor -> 'recompra') = 'number'
              AND jsonb_typeof(valor -> 'complemento') = 'number' AND jsonb_typeof(valor -> 'preco') = 'number')) <> 5 THEN
    RAISE EXCEPTION 'A5 FALHOU: venda_config sem as 5 chaves com o tipo certo';
  END IF;

  -- A6 crons
  IF (SELECT count(*) FROM cron.job
       WHERE jobname = 'venda-fechar-desfechos' AND schedule = '30 9 * * *'
         AND command = 'SELECT public.venda_fechar_desfechos();' AND active) <> 1 THEN
    RAISE EXCEPTION 'A6 FALHOU: cron venda-fechar-desfechos ausente, duplicado ou divergente';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tactical-plans-batch-nightly') THEN
    RAISE EXCEPTION 'A6 FALHOU: cron tactical-plans-batch-nightly ainda agendado';
  END IF;

  RAISE NOTICE 'venda_cliente_espinha OK: 3 tabelas com RLS, 5 funcoes com ACL, 5 configs, cron 09:30, plano tatico desligado';
END
$post$;
