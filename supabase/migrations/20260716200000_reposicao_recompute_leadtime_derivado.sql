-- Recompute derivado do leadtime — fecha o lt_* que morre NULL quando o t4 chega DEPOIS do
-- faturamento, e ANULA o lt_* cujo t1 não é uma data de pedido. Tudo local: zero Omie.
--
-- PROBLEMA (medido em prod 2026-07-16, OBEN): 1103 linhas de sku_leadtime_history com
-- lt_bruto_dias_uteis NULL apesar de purchase_orders_tracking.t4_data_recebimento já
-- preenchido — ~30% do histórico. DUAS causas distintas com o MESMO sintoma:
--
--   BUG A — a fila nunca revisita (775 linhas, abril→julho). A linha nasce no FATURAMENTO,
--   quando t4 ainda é NULL ⇒ lt_bruto = NULL (correto: não fabrica). Dias depois o sync
--   irmão grava t4 no tracking, mas a edge omie-sync-sku-items define "pendente" como "NÃO
--   tem linha em sku_leadtime_history" ⇒ a NFe nunca volta à fila ⇒ o lt_bruto morre NULL.
--
--   BUG B — o backfill (328 linhas, TODAS created_at=2026-04-19). A função
--   reprocessar_sku_items_via_raw_data grava t1 = COALESCE(t1_real, t1_data_pedido) mas
--   calcula os lt_* só `WHEN t1_real IS NOT NULL`. Quando o LATERAL não casa o pedido, o t1
--   GRAVADO é válido e os lt_* ficam NULL assim mesmo. Assinatura: lt_logistica preenchido +
--   lt_faturamento NULL — 328/328 casam. Nenhum fix na FILA alcança este bug.
--
-- POR QUE UM UPDATE DERIVADO E NÃO RE-CONSULTAR A OMIE: os itens já estão completos —
-- quantidade_recebida > 0 em 1103/1103. Só faltam as DATAS, e elas vêm do tracking, não da
-- Omie. Fidelidade provada: (a) s.t4 = p.t4 em 2601/2601 das linhas fechadas; (b) paridade
-- TS×SQL com dado de OURO — dias_uteis_entre(SQL) reproduz os 3 lt_* que a edge (TS) gravou
-- em 230/230 linhas, banco em UTC (o ::date do SQL concorda com o getUTC* do TS).
--
-- EFEITO no que o motor lê (v_sku_leadtime_efetivo, já deduplicada por NFe): 443 → 486 pares
-- (NFe,SKU) com leadtime (+109 recuperados, −66 mentiras removidas); média 9,75 → 10,84 d.u.
--
-- Prova: db/test-recompute-leadtime-derivado.sh (PG17, asserts + falsificação).
-- 2ª opinião: Codex gpt-5.6-sol/xhigh — dele vieram o IS DISTINCT FROM (convergência), o
-- recálculo dos TRÊS lt_*, e o gate por PROVENIÊNCIA (a órfã é categórica, não condicional
-- às datas: há 55 órfãs com t1<>t2 que um gate baseado só em datas deixaria passar).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) O gate: "o t1 desta linha é mesmo uma data de PEDIDO?"
-- ─────────────────────────────────────────────────────────────────────────────
-- Um só conceito decide o recompute E a anulação. Confiável = NÃO provadamente fabricado —
-- prova POSITIVA de fabricação, nunca recusa por ausência (docs/agent/money-path.md §5).
CREATE OR REPLACE FUNCTION public.leadtime_t1_e_data_de_pedido(
  p_hist_t1            timestamptz,  -- sku_leadtime_history.t1_data_pedido (o t1 GRAVADO)
  p_hist_t2            timestamptz,  -- sku_leadtime_history.t2_data_faturamento
  p_tracking_t1        timestamptz,  -- purchase_orders_tracking.t1_data_pedido (o t1 do tracking)
  p_omie_codigo_pedido bigint        -- purchase_orders_tracking.omie_codigo_pedido (<0 = órfã)
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT NOT (
    -- (a) ÓRFÃ = NFe sem pedido de compra casado. NUNCA existe data de pedido: o
    --     "t1_data_pedido" do tracking dela é a data da NFe. Isto é PROVENIÊNCIA, e por
    --     isso é CATEGÓRICO — não depende das datas. Auditado: 55 órfãs têm t1 <> t2 e
    --     escapariam de um gate que só olhasse a coincidência de datas (11 delas já
    --     fechadas mentindo). Achado do Codex 2026-07-16.
    COALESCE(p_omie_codigo_pedido, 0) < 0
    -- (b) FALLBACK PROVADO da edge: ela grava `t1 = pedidoCasado?.t1_data_pedido ??
    --     nfe.t2_data_faturamento`. Quando o t1 gravado É o faturamento E existe um t1 real
    --     DIFERENTE no tracking, o fallback está provado — o item não casou pedido e a data
    --     de pedido dele é desconhecida. Recomputar faria lt_bruto == lt_logistica, ou seja,
    --     o leadtime de COMPRA confundido com o de LOGÍSTICA: mentira que SUBESTIMA e faz
    --     pedir tarde (medido: 2,2 d.u. contra 10,0 das honestas).
    OR (p_hist_t1 = p_hist_t2 AND p_hist_t1 IS DISTINCT FROM p_tracking_t1)
  );
$$;

COMMENT ON FUNCTION public.leadtime_t1_e_data_de_pedido(timestamptz, timestamptz, timestamptz, bigint) IS
  'TRUE quando o t1_data_pedido gravado em sku_leadtime_history é comprovadamente uma data '
  'de PEDIDO (e não o faturamento ou a data de uma NFe órfã). Gate de honestidade do '
  'leadtime: só com TRUE o lt_bruto/lt_faturamento pode existir. Preserva o pedido '
  'legitimamente faturado no mesmo dia (t1=t2=tracking.t1 com pedido real) — recusar esse '
  'seria destruir dado bom por ausência de prova, não por prova de fabricação.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) O recompute derivado
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.recomputar_leadtime_derivado(p_empresa text)
RETURNS TABLE(etapa text, valor bigint)
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_recomputadas bigint := 0;
  v_anuladas     bigint := 0;
  v_sem_t4       bigint := 0;
  v_datas_ruins  bigint := 0;
BEGIN
  -- Fail-closed: empresa vazia varreria a tabela inteira das duas empresas.
  IF p_empresa IS NULL OR btrim(p_empresa) = '' THEN
    RAISE EXCEPTION 'recomputar_leadtime_derivado: p_empresa é obrigatório'
      USING ERRCODE = '22023';
  END IF;

  -- ── (1) ANULA o derivado cujo t1 não é data de pedido ──────────────────────
  -- lt_bruto e lt_faturamento derivam de t1 ⇒ com t1 fabricado, ambos são mentira.
  -- lt_logistica NÃO é tocado: ele deriva de t2 e t4, que são reais mesmo na órfã. Anular
  -- o que ainda é verdade seria destruir dado bom.
  UPDATE public.sku_leadtime_history s
  SET lt_bruto_dias_uteis       = NULL,
      lt_faturamento_dias_uteis = NULL
  FROM public.purchase_orders_tracking p
  WHERE p.id = s.tracking_id
    AND s.empresa::text = p_empresa
    AND NOT public.leadtime_t1_e_data_de_pedido(
          s.t1_data_pedido, s.t2_data_faturamento, p.t1_data_pedido, p.omie_codigo_pedido)
    -- Idempotência: sem isto, a 2ª rodada reescreveria NULL sobre NULL todo dia (bloat +
    -- trigger de updated_at à toa).
    AND (s.lt_bruto_dias_uteis IS NOT NULL OR s.lt_faturamento_dias_uteis IS NOT NULL);
  GET DIAGNOSTICS v_anuladas = ROW_COUNT;

  -- ── (2) RECOMPUTA o derivado das linhas cujo t1 é confiável ────────────────
  -- Convergente por DIVERGÊNCIA, não por `lt_bruto IS NULL`. Motivo (achado do Codex): com
  -- `IS NULL`, uma correção posterior de t1/t2/t4 na fonte NUNCA se propaga — a linha já
  -- tem valor, some da fila e CONGELA o erro. Auditado: 4 linhas do backfill têm t2 ANTES
  -- de t1 e lt_bruto = 0 gravado (o backfill castava ::date antes de comparar; a edge em TS
  -- compara os timestamps e devolveria NULL) — só o IS DISTINCT FROM as alcança.
  --
  -- t4 vem do TRACKING (a fonte), não da linha: é o dado que chega tarde e destrava tudo.
  -- Onde as datas são inconsistentes (t4 < t1), dias_uteis_entre já devolve NULL sozinha —
  -- degradação honesta sem predicado extra. Ausente ≠ zero.
  UPDATE public.sku_leadtime_history s
  SET t4_data_recebimento       = p.t4_data_recebimento,
      lt_bruto_dias_uteis       = public.dias_uteis_entre(s.t1_data_pedido, p.t4_data_recebimento),
      lt_faturamento_dias_uteis = public.dias_uteis_entre(s.t1_data_pedido, s.t2_data_faturamento),
      lt_logistica_dias_uteis   = public.dias_uteis_entre(s.t2_data_faturamento, p.t4_data_recebimento)
  FROM public.purchase_orders_tracking p
  WHERE p.id = s.tracking_id
    AND s.empresa::text = p_empresa
    AND public.leadtime_t1_e_data_de_pedido(
          s.t1_data_pedido, s.t2_data_faturamento, p.t1_data_pedido, p.omie_codigo_pedido)
    AND (
          s.t4_data_recebimento       IS DISTINCT FROM p.t4_data_recebimento
       OR s.lt_bruto_dias_uteis       IS DISTINCT FROM public.dias_uteis_entre(s.t1_data_pedido, p.t4_data_recebimento)
       OR s.lt_faturamento_dias_uteis IS DISTINCT FROM public.dias_uteis_entre(s.t1_data_pedido, s.t2_data_faturamento)
       OR s.lt_logistica_dias_uteis   IS DISTINCT FROM public.dias_uteis_entre(s.t2_data_faturamento, p.t4_data_recebimento)
    );
  GET DIAGNOSTICS v_recomputadas = ROW_COUNT;

  -- ── (3) O que sobrou NULL, e por quê (observabilidade: NULL é decisão, não bug) ──
  SELECT
    count(*) FILTER (WHERE p.t4_data_recebimento IS NULL),
    count(*) FILTER (WHERE p.t4_data_recebimento IS NOT NULL
                       AND p.t4_data_recebimento < s.t1_data_pedido)
  INTO v_sem_t4, v_datas_ruins
  FROM public.sku_leadtime_history s
  JOIN public.purchase_orders_tracking p ON p.id = s.tracking_id
  WHERE s.empresa::text = p_empresa
    AND s.lt_bruto_dias_uteis IS NULL
    AND public.leadtime_t1_e_data_de_pedido(
          s.t1_data_pedido, s.t2_data_faturamento, p.t1_data_pedido, p.omie_codigo_pedido);

  etapa := 'leadtime_recomputado';        valor := v_recomputadas; RETURN NEXT;
  etapa := 'leadtime_anulado_t1_nao_e_pedido'; valor := v_anuladas; RETURN NEXT;
  etapa := 'null_honesto_aguardando_t4';  valor := v_sem_t4;       RETURN NEXT;
  etapa := 'null_honesto_datas_invertidas'; valor := v_datas_ruins; RETURN NEXT;
  RETURN;
END;
$function$;

COMMENT ON FUNCTION public.recomputar_leadtime_derivado(text) IS
  'Recompute LOCAL (zero Omie) dos leadtimes derivados de sku_leadtime_history. Fecha o '
  'lt_* que nasceu NULL porque o t4 só chegou ao tracking dias após o faturamento, e anula '
  'o lt_bruto/lt_faturamento cujo t1 não é data de pedido (órfã ou fallback provado). '
  'Idempotente e convergente (atualiza por divergência: correção posterior de t1/t2/t4 na '
  'fonte se propaga). Chamada no INÍCIO do run de omie-sync-sku-items, antes de qualquer '
  'chamada Omie — assim roda mesmo quando a fila está vazia ou o guard de 50s corta o run.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) Grants — só o service_role (a edge) executa
-- ─────────────────────────────────────────────────────────────────────────────
-- Escreve no money-path ⇒ ninguém do lado do cliente executa. REVOKE FROM PUBLIC NÃO tira
-- anon/authenticated (eles têm grant explícito por default no Supabase) — revogar por NOME
-- (CLAUDE.md §Supabase RLS). SECURITY INVOKER (default): a edge chama com service_role, que
-- já bypassa RLS; DEFINER daria privilégio sem necessidade.
REVOKE ALL ON FUNCTION public.recomputar_leadtime_derivado(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recomputar_leadtime_derivado(text) TO service_role;

-- O gate é uma função PURA de leitura (sem efeito) — authenticated pode avaliá-la para
-- exibir "por que este leadtime está vazio" na UI sem precisar da RPC de escrita.
REVOKE ALL ON FUNCTION public.leadtime_t1_e_data_de_pedido(timestamptz, timestamptz, timestamptz, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leadtime_t1_e_data_de_pedido(timestamptz, timestamptz, timestamptz, bigint) TO authenticated, service_role;
