-- ============================================================
-- Crédito-IA PR 6a (follow-up 2): a view credito_fila_v deixa de ler a coluna FECHADA
-- sales_orders.vendedor_user_id.
--
-- Incidente (2026-11-26 ~11h, build 9efe21ae, master 414a9727…): toda tela fazia
-- GET /rest/v1/credito_fila_v?select=item_id&origem=eq.efetivo&status=eq.aberta (contador do menu)
-- e recebia 403. Causa: a view é security_invoker=on, e o `authenticated` tem SELECT em
-- sales_orders só POR COLUNA — vendedor_user_id está fechada de propósito (#d7a15546d: o vendedor
-- se lê pela RPC). Um SELECT que toca uma coluna sem grant falha a view INTEIRA com 42501.
-- A prova PG17 da 20261125230000 deu SELECT na tabela toda e não viu.
--
-- Correção: a coluna vira NULL::uuid (mesmo nome e tipo ⇒ CREATE OR REPLACE vale e preserva o ACL;
-- o front só declara o campo no tipo, não o lê). Resto do corpo IDÊNTICO ao da 20261125230000
-- (pré-flight: md5(pg_get_viewdef) da prod = 18d4ea7126101ace96e77649cc2d366e = o do repo aplicado no PG17).
-- WITH (security_invoker = on) repetido (omitir reseta → lê como owner e bypassa RLS).
-- Postcondição pega a CLASSE: toda coluna de tabela que a view lê tem SELECT para authenticated.
-- Prova: db/test-credito-fila.sh (E11 + F18, com o grant por coluna da prod reproduzido).
-- Reversão: reaplicar o CREATE OR REPLACE VIEW da 20261125230000 (volta o 403).
-- ============================================================

CREATE OR REPLACE VIEW public.credito_fila_v
WITH (security_invoker = on) AS
WITH sombra AS (
  -- A ÚLTIMA avaliação de sombra por pedido×empresa (qualquer faixa), pela view do PR 5 — que também
  -- tira o PV cuja versão corrente ficou ilegível. Só depois o filtro: amarelo de ontem não ressuscita
  -- se hoje deu verde, vermelho, pendência cadastral ou versão nova sem avaliação.
  SELECT d.* FROM public.credito_sombra_pv_atual d
   WHERE d.avaliado_em > now() - interval '14 days'
),
efetivo AS (
  -- UMA regra de vigência para view, contador, alerta, IA e ação (Codex diff P1): a solicitação é
  -- acionável só se a revisão dela é a de maior seq REGISTRADA, a última decisão efetiva é amarela
  -- DESSA revisão, o pedido segue vivo e o flag da empresa está ligado. Retry do mesmo amarelo
  -- (D2 reusando S) continua acionável e com o relógio de S.
  SELECT s.*, d.id AS decisao_original, ld.id AS ld_id, ld.revisao AS ld_revisao, ld.faixa AS ld_faixa,
         ld.limite_brl AS ld_limite, ld.prazo_max_dias AS ld_prazo_max,
         ld.exposicao_titulos_brl AS ld_tit, ld.exposicao_reservas_brl AS ld_res,
         rv.id AS rv_id, so.id AS so_id, so.deleted_at AS so_deleted, so.status AS so_status,
         so.customer_user_id, so.omie_numero_pedido, NULL::uuid AS vendedor_user_id, so.created_by,
         COALESCE(e.ligado, false) AS flag_ligado
    FROM public.credito_solicitacao s
    JOIN public.credito_decisao_pedido d ON d.id = s.decisao_id
    LEFT JOIN LATERAL (
      SELECT d2.* FROM public.credito_decisao_pedido d2
       WHERE d2.sales_order_id = s.sales_order_id AND d2.company = s.company AND d2.modo = 'efetivo'
       ORDER BY d2.created_at DESC, d2.id DESC LIMIT 1) ld ON true
    LEFT JOIN LATERAL (
      SELECT r.id FROM public.credito_operacao_revisao r
       WHERE r.sales_order_id = s.sales_order_id AND r.company = s.company
       ORDER BY r.seq DESC LIMIT 1) rv ON true
    LEFT JOIN public.sales_orders so ON so.id = s.sales_order_id
    LEFT JOIN public.credito_enforcement e ON e.company = s.company
   WHERE s.status = 'aberta' OR s.decidida_em > now() - interval '48 hours'
)
SELECT 'efetivo'::text AS origem, f.id AS item_id, f.id AS solicitacao_id,
       COALESCE(f.ld_id, f.decisao_original) AS decisao_id,
       f.sales_order_id, f.company, f.revisao, f.valor_brl, f.prazo_dias, f.motivo,
       COALESCE(f.ld_faixa, 'amarelo') AS faixa,
       f.ld_limite AS limite_brl, f.ld_prazo_max AS prazo_max_dias,
       f.ld_tit AS exposicao_titulos_brl, f.ld_res AS exposicao_reservas_brl,
       CASE WHEN f.status <> 'aberta' THEN f.status
            WHEN f.so_id IS NULL OR f.so_deleted IS NOT NULL OR f.so_status = 'cancelado' THEN 'superada'
            WHEN f.rv_id::text IS DISTINCT FROM f.revisao THEN 'superada'
            WHEN f.ld_revisao IS DISTINCT FROM f.revisao OR f.ld_faixa IS DISTINCT FROM 'amarelo' THEN 'superada'
            WHEN NOT f.flag_ligado THEN 'congelada'
            ELSE 'aberta' END AS status,
       f.created_at AS criado_em, f.decidida_em,
       f.customer_user_id, f.omie_numero_pedido, f.so_status AS pedido_status, f.vendedor_user_id,
       CASE WHEN f.created_by IS NOT NULL THEN 'app' ELSE 'omie' END AS origem_pedido,
       r.status AS recomendacao_status, r.recomendacao, r.prazo_sugerido_dias,
       r.confianca AS recomendacao_confianca, r.codigos AS recomendacao_codigos
  FROM efetivo f
  LEFT JOIN public.credito_fila_recomendacao r ON r.decisao_id = COALESCE(f.ld_id, f.decisao_original)
UNION ALL
SELECT 'sombra', d.id, NULL::uuid, d.id,
       d.sales_order_id, d.company, d.versao, d.valor_brl, d.prazo_dias, d.motivo, d.faixa,
       d.limite_brl, d.prazo_max_dias, d.exposicao_titulos_brl, d.exposicao_reservas_brl,
       'simulada', d.avaliado_em, NULL::timestamptz,
       so.customer_user_id, so.omie_numero_pedido, so.status, NULL::uuid AS vendedor_user_id,
       d.origem,
       r.status, r.recomendacao, r.prazo_sugerido_dias, r.confianca, r.codigos
  FROM sombra d
  JOIN public.sales_orders so ON so.id = d.sales_order_id
  LEFT JOIN public.credito_fila_recomendacao r ON r.decisao_id = d.id
 WHERE d.faixa = 'amarelo'
   AND d.motivo NOT IN ('sem_grupo','grupo_conflito','piso_indeterminado','grupo_mudou','sync_defasado')
   AND so.deleted_at IS NULL AND COALESCE(so.status, '') <> 'cancelado';

-- Postcondição.
DO $pos$
DECLARE v_faltam text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.credito_fila_v'::regclass
                  AND 'security_invoker=on' = ANY (reloptions)) THEN
    RAISE EXCEPTION 'POS FALHOU: credito_fila_v perdeu security_invoker=on';
  END IF;
  -- Toda coluna de tabela/view que as regras da view referenciam precisa ser legível pelo authenticated.
  SELECT string_agg(DISTINCT d.refobjid::regclass || '.' || a.attname, ', ') INTO v_faltam
    FROM pg_rewrite r
    JOIN pg_depend d ON d.classid = 'pg_rewrite'::regclass AND d.objid = r.oid
                    AND d.refclassid = 'pg_class'::regclass AND d.refobjsubid > 0
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
   WHERE r.ev_class = 'public.credito_fila_v'::regclass
     AND d.refobjid <> 'public.credito_fila_v'::regclass
     AND NOT has_column_privilege('authenticated', d.refobjid, a.attname, 'SELECT');
  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'POS FALHOU: authenticated sem SELECT em coluna lida pela view: %', v_faltam;
  END IF;
  IF has_table_privilege('anon', 'public.credito_fila_v', 'SELECT') THEN
    RAISE EXCEPTION 'POS FALHOU: anon lê credito_fila_v';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.credito_fila_v', 'SELECT') THEN
    RAISE EXCEPTION 'POS FALHOU: authenticated perdeu SELECT na view';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro')
     AND NOT has_table_privilege('claude_ro', 'public.credito_fila_v', 'SELECT') THEN
    RAISE EXCEPTION 'POS FALHOU: claude_ro perdeu SELECT na view';
  END IF;
  RAISE NOTICE 'POS OK: credito_fila_v sem coluna fechada — legível pelo authenticated com grant por coluna';
END
$pos$;
