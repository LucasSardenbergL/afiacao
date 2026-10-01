-- O PREDECESSOR de supabase/migrations/20261001083000_converter_campanha_flat_colunas_reais.sql:
-- o corpo VIVO da prod de public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,
-- date,text,text,text), verbatim do pg_get_functiondef (psql-ro, 2026-10-01), md5(prosrc)
-- 513a87a6e1785991e8aee9a8be9dc090 — a constante da PRE. Quebrado: o INSERT em promocao_item usa 4
-- colunas que a tabela não tem (42703 a qualquer hora). A prova db/test-converter-campanha-flat.sh
-- instala este texto e EXECUTA o defeito antes de aplicar a migration.
CREATE OR REPLACE FUNCTION public.converter_sugestao_em_campanha_flat(p_sugestao_id bigint, p_desconto_perc numeric, p_volume_minimo numeric, p_volume_unidade text, p_data_fim date, p_responsavel_nome text DEFAULT NULL::text, p_canal text DEFAULT 'ligacao'::text, p_observacoes text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sugestao record;
  v_campanha_id bigint;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_sugestao FROM sugestao_negociacao_paralela WHERE id = p_sugestao_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sugestão % não encontrada', p_sugestao_id; END IF;
  INSERT INTO promocao_campanha (
    empresa, fornecedor_nome, nome, tipo_origem, estado,
    data_inicio, data_fim, data_corte_pedido, data_corte_faturamento,
    responsavel_oferta_nome, canal_oferta, data_oferta,
    volume_minimo_condicional, volume_minimo_unidade,
    status_aceite, observacoes_negociacao, permite_pedido_oportunidade
  ) VALUES (
    v_sugestao.empresa, 'RENNER SAYERLACK S/A',
    format('Desconto Flat Condicional - %s', v_sugestao.sku_codigo_omie),
    'desconto_flat_condicional', 'negociando',
    CURRENT_DATE, p_data_fim, p_data_fim,
    (date_trunc('month', p_data_fim) + interval '2 months - 1 day')::date,
    p_responsavel_nome, p_canal, CURRENT_DATE,
    p_volume_minimo, p_volume_unidade,
    'aceita', p_observacoes, false
  ) RETURNING id INTO v_campanha_id;
  INSERT INTO promocao_item (
    campanha_id, sku_codigo_omie, sku_descricao_extraido,
    desconto_base_perc, mapeamento_confianca, mapeamento_origem, ativo
  ) VALUES (
    v_campanha_id, v_sugestao.sku_codigo_omie, v_sugestao.sku_descricao,
    p_desconto_perc, 1.0, 'sugestao_sistema', true
  );
  UPDATE sugestao_negociacao_paralela
  SET status = 'fechada_desconto', campanha_id_gerada = v_campanha_id,
      data_acao = now(), observacoes = p_observacoes, atualizado_em = now()
  WHERE id = p_sugestao_id;
  RETURN v_campanha_id;
END;
$function$;
