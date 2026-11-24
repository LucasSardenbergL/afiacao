-- Onda B da tela de Clientes, item 8: o desfecho MANUAL do contato (`venda_contato`, gravado pela
-- ficha 360 / Fila do Dia) passa a aparecer na timeline `v_cliente_interacoes`.
--
-- Pré-flight (2026-11-24, psql-ro): `pg_get_viewdef` da PROD = 4 ramos (farmer_calls, route_visits,
-- tarefas, order_messages), 9 colunas, reloptions {security_invoker=true}, sem views dependentes.
-- Este replace repete os 4 ramos VERBATIM, ACRESCENTA o 5º e NÃO muda coluna nenhuma (mesmos nomes,
-- tipos e ordem). `WITH (security_invoker = true)` repetido como está em prod: omitir RESETA a opção e a view passaria
-- a ler como OWNER, furando a RLS das tabelas-base (CLAUDE.md, armadilha do CREATE OR REPLACE VIEW).
--
-- Autorização do ramo novo = a MESMA dos ramos com autor: carteira completa OU autor do registro OU
-- carteira visível. Como a view é security_invoker, a RLS de `venda_contato` (dono ou master) TAMBÉM
-- vale — o efetivo é a interseção (nunca mais largo que a tabela).
--
-- Guarda: aborta se a view de prod não estiver no estado do pré-flight (drift repo×prod).
-- Prova: db/test-v-cliente-interacoes-desfecho.sh (PG17, com falsificação).

BEGIN;

DO $guarda$
DECLARE
  v_cols integer;
  v_opts text[];
BEGIN
  SELECT count(*) INTO v_cols
    FROM pg_attribute
   WHERE attrelid = 'public.v_cliente_interacoes'::regclass AND attnum > 0 AND NOT attisdropped;
  SELECT reloptions INTO v_opts FROM pg_class WHERE oid = 'public.v_cliente_interacoes'::regclass;
  IF v_cols <> 9 THEN
    RAISE EXCEPTION 'GUARDA v_cliente_interacoes: esperava 9 colunas, achei % (drift: refazer o pre-flight)', v_cols;
  END IF;
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY (v_opts)) THEN
    RAISE EXCEPTION 'GUARDA v_cliente_interacoes: reloptions % diferente de {security_invoker=true} (drift)', v_opts;
  END IF;
END
$guarda$;

CREATE OR REPLACE VIEW public.v_cliente_interacoes
WITH (security_invoker = true) AS
 SELECT fc.customer_user_id,
    COALESCE(fc.started_at, fc.created_at) AS at,
        CASE
            WHEN fc.is_whatsapp THEN 'whatsapp'::text
            ELSE 'ligacao'::text
        END AS canal,
        CASE fc.call_type
            WHEN 'reativacao'::farmer_call_type THEN 'Reativação'::text
            WHEN 'cross_sell'::farmer_call_type THEN 'Cross-sell'::text
            WHEN 'up_sell'::farmer_call_type THEN 'Up-sell'::text
            WHEN 'follow_up'::farmer_call_type THEN 'Follow-up'::text
            ELSE 'Contato'::text
        END AS titulo,
    NULLIF(fc.notes, ''::text) AS resumo,
    'farmer_calls'::text AS ref_tabela,
    fc.id AS ref_id,
    fc.farmer_id AS autor_id,
    fc.revenue_generated AS revenue
   FROM farmer_calls fc
  WHERE fc.customer_user_id IS NOT NULL AND (private.pode_ver_carteira_completa(auth.uid()) OR fc.farmer_id = auth.uid() OR private.carteira_visivel_para(fc.customer_user_id, auth.uid()))
UNION ALL
 SELECT rv.customer_user_id,
    COALESCE(rv.check_in_at, rv.visit_date::timestamp with time zone, rv.created_at) AS at,
    'visita'::text AS canal,
    COALESCE(NULLIF(rv.visit_type, ''::text), 'Visita'::text) AS titulo,
    NULLIF(rv.notes, ''::text) AS resumo,
    'route_visits'::text AS ref_tabela,
    rv.id AS ref_id,
    rv.visited_by AS autor_id,
    rv.revenue_generated AS revenue
   FROM route_visits rv
  WHERE rv.customer_user_id IS NOT NULL AND (private.pode_ver_carteira_completa(auth.uid()) OR rv.visited_by = auth.uid() OR private.carteira_visivel_para(rv.customer_user_id, auth.uid()))
UNION ALL
 SELECT t.customer_user_id,
    COALESCE(t.concluida_em, t.created_at) AS at,
    'tarefa'::text AS canal,
    COALESCE(NULLIF(t.categoria, ''::text), 'Tarefa'::text) AS titulo,
    COALESCE(NULLIF(t.nota_conclusao, ''::text), NULLIF(t.descricao, ''::text)) AS resumo,
    'tarefas'::text AS ref_tabela,
    t.id AS ref_id,
    t.assigned_to AS autor_id,
    NULL::numeric AS revenue
   FROM tarefas t
  WHERE t.customer_user_id IS NOT NULL AND (private.pode_ver_carteira_completa(auth.uid()) OR private.carteira_visivel_para(t.customer_user_id, auth.uid()))
UNION ALL
 SELECT o.user_id AS customer_user_id,
    om.created_at AS at,
    'mensagem_pedido'::text AS canal,
        CASE
            WHEN om.is_staff THEN 'Mensagem da equipe'::text
            ELSE 'Mensagem do cliente'::text
        END AS titulo,
    NULLIF(om.message, ''::text) AS resumo,
    'order_messages'::text AS ref_tabela,
    om.id AS ref_id,
    om.sender_id AS autor_id,
    NULL::numeric AS revenue
   FROM order_messages om
     JOIN orders o ON o.id = om.order_id
  WHERE o.user_id IS NOT NULL AND (private.pode_ver_carteira_completa(auth.uid()) OR private.carteira_visivel_para(o.user_id, auth.uid()))
UNION ALL
 -- Onda B: desfecho manual do contato. `atualizado_em` = o último toque do dia (a linha é única por
 -- vendedor × cliente × dia e o último toque vence). `motivo` só existe para 'sem_interesse' (CHECK).
 SELECT vc.comprador_id AS customer_user_id,
    vc.atualizado_em AS at,
    'desfecho'::text AS canal,
        CASE vc.resultado
            WHEN 'vendeu'::text THEN 'Desfecho: vendeu'::text
            WHEN 'vai_pedir'::text THEN 'Desfecho: vai pedir'::text
            WHEN 'sem_interesse'::text THEN 'Desfecho: sem interesse'::text
            WHEN 'nao_atendeu'::text THEN 'Desfecho: não atendeu'::text
            ELSE 'Desfecho do contato'::text
        END AS titulo,
    NULLIF(vc.motivo, ''::text) AS resumo,
    'venda_contato'::text AS ref_tabela,
    vc.id AS ref_id,
    vc.farmer_user_id AS autor_id,
    NULL::numeric AS revenue
   FROM venda_contato vc
  WHERE vc.comprador_id IS NOT NULL AND (private.pode_ver_carteira_completa(auth.uid()) OR vc.farmer_user_id = auth.uid() OR private.carteira_visivel_para(vc.comprador_id, auth.uid()));

-- Postcondição: a opção sobreviveu e o 5º ramo está na definição.
DO $pos$
DECLARE
  v_opts text[];
BEGIN
  SELECT reloptions INTO v_opts FROM pg_class WHERE oid = 'public.v_cliente_interacoes'::regclass;
  IF v_opts IS NULL OR NOT ('security_invoker=true' = ANY (v_opts)) THEN
    RAISE EXCEPTION 'POSCONDICAO: security_invoker perdido';
  END IF;
  IF position('venda_contato' IN pg_get_viewdef('public.v_cliente_interacoes'::regclass)) = 0 THEN
    RAISE EXCEPTION 'POSCONDICAO: ramo venda_contato ausente';
  END IF;
END
$pos$;

COMMIT;
