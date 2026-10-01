-- 20261001083000_converter_campanha_flat_colunas_reais.sql
-- ============================================================
-- converter_sugestao_em_campanha_flat volta a funcionar: o item da campanha nas colunas REAIS de
-- promocao_item, com o código Sayerlack vindo do diálogo, e o hoje de SP nas datas.
-- ============================================================
-- O defeito (medido via psql-ro em 2026-10-01; issue #2668). A RPC do botão "Registrar desconto
-- fechado" da Negociação Paralela (handleConverterConfirm em
-- src/components/reposicao/negociacaoParalela/useNegociacaoParalela.ts) nunca funcionou na prod:
--   · o INSERT em promocao_item usava sku_descricao_extraido, desconto_base_perc,
--     mapeamento_confianca e mapeamento_origem — colunas que a tabela NÃO tem (pg_attribute) →
--     42703 a qualquer hora, e a transação inteira (campanha incluída) voltava;
--   · mesmo com as colunas certas, faltava sku_codigo_fornecedor (NOT NULL, sem default), e o
--     sku_codigo_omie da sugestão é text enquanto o do item é bigint (sem cast de atribuição);
--   · data_inicio e data_oferta eram CURRENT_DATE: das 21:00 às 23:59 BRT a sessão (UTC) já está
--     no dia seguinte, e com data_fim = hoje o CHECK ck_periodo_coerente recusava a campanha.
-- Evidência de uso: 0 campanhas desconto_flat_condicional; 0 sugestões fechada_desconto.
--
-- O conserto, no mapeamento que o resto do app usa (edge promocao-extrair-via-vision e
-- expandir_promocao_item): sku_codigo_fornecedor = o código Sayerlack, que é a identidade do item
-- na campanha — decisão do founder em 2026-10-01: o diálogo ganha o campo, pré-preenchido com o
-- código que aparece no fim da descrição do SKU (o mesmo texto que resolver_sku_por_codigo_fornecedor
-- procura) e editável; descricao_produto_fornecedor = a descrição do SKU; sku_codigo_omie = o SKU da
-- sugestão (bigint); mapeamento_qualidade = 'manual_confirmado' e confirmado = true (quem converte
-- confirmou SKU e código no diálogo); o volume continua na campanha (volume_minimo_condicional +
-- unidade), não no item. As datas usam o dia de SP. Guardas novas, com mensagem para o toast:
-- código vazio, data fim no passado, SKU não numérico e sugestão já convertida (com a linha da
-- sugestão travada por FOR UPDATE: dois cliques não criam duas campanhas). O corte de faturamento
-- passa a truncar o mês sobre timestamp SEM fuso — o mesmo resultado, sem depender da sessão.
--
-- A assinatura MUDA (p_sku_codigo_fornecedor, obrigatório, depois de p_data_fim): é DROP + CREATE.
-- Manter o overload antigo deixaria a versão quebrada no ar; e DROP + CREATE RESETA o ACL, então o
-- fecho PORTA_GATE abaixo reemite a porta nomeando as roles (PUBLIC e anon fechados; authenticated
-- e service_role abertos — o mesmo ACL que a função antiga tinha na prod). Ordem de deploy: esta
-- migration e depois o Publish do front, que manda o parâmetro novo. Até o Publish, o front velho
-- chama a assinatura antiga e recebe "função não encontrada" — que é o mesmo botão quebrado de hoje.
--
-- Prova: db/test-converter-campanha-flat.sh (PG17, relógio controlado cruzando 21:00 BRT sob
-- TimeZone=UTC e America/Sao_Paulo, com --falsificar). Predecessor verbatim da prod:
-- db/fixtures/converter-campanha-flat-predecessora-prod-20261001.sql.

-- Trava antes da PRE: um ALTER sem efeito pega o lock da linha de pg_proc, e um CREATE OR REPLACE
-- concorrente espera esta transação — a PRE lê o corpo que de fato vai ser trocado.
DO $trava$
BEGIN
  IF to_regprocedure('public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.converter_sugestao_em_campanha_flat(bigint, numeric, numeric, text, date, text, text, text) VOLATILE;
  END IF;
  IF to_regprocedure('public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.converter_sugestao_em_campanha_flat(bigint, numeric, numeric, text, date, text, text, text, text) VOLATILE;
  END IF;
END
$trava$;

-- Pré-condição: a assinatura antiga, se existe, tem de ser o PREDECESSOR revisado (o da prod em
-- 2026-10-01, md5 EXATO do prosrc); a nova, se já existe, tem de ser ESTE (re-aplicar é seguro).
-- Qualquer outro corpo é mudança concorrente que o DROP/REPLACE apagaria em silêncio — aborta.
DO $pre$
DECLARE
  v_antigo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                     WHERE p.oid = to_regprocedure('public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text)'));
  v_novo   text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                     WHERE p.oid = to_regprocedure('public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text,text)'));
BEGIN
  IF v_antigo IS NOT NULL AND v_antigo <> '513a87a6e1785991e8aee9a8be9dc090' THEN
    RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text) (md5 %) não é o predecessor revisado — outra mudança chegou antes; reconcilie antes de aplicar', v_antigo;
  END IF;
  IF v_novo IS NOT NULL AND v_novo <> '557f962e0355b034097be8cf88c27a1a' THEN
    RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text,text) (md5 %) não é o desta migration — outra mudança chegou antes; reconcilie antes de aplicar', v_novo;
  END IF;
END
$pre$;

DROP FUNCTION IF EXISTS public.converter_sugestao_em_campanha_flat(bigint, numeric, numeric, text, date, text, text, text);

CREATE OR REPLACE FUNCTION public.converter_sugestao_em_campanha_flat(p_sugestao_id bigint, p_desconto_perc numeric, p_volume_minimo numeric, p_volume_unidade text, p_data_fim date, p_sku_codigo_fornecedor text, p_responsavel_nome text DEFAULT NULL::text, p_canal text DEFAULT 'ligacao'::text, p_observacoes text DEFAULT NULL::text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_sugestao record;
  v_campanha_id bigint;
  -- o dia de SÃO PAULO: o instante da transação levado à data de SP (a sessão da prod é UTC)
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_codigo text := nullif(btrim(p_sku_codigo_fornecedor), '');
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  IF v_codigo IS NULL THEN
    RAISE EXCEPTION 'Informe o código Sayerlack do produto' USING ERRCODE = '22023';
  END IF;
  IF p_data_fim IS NULL OR p_data_fim < v_hoje THEN
    RAISE EXCEPTION 'A data fim (%) não pode ser anterior a hoje (%)', p_data_fim, v_hoje USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_sugestao FROM sugestao_negociacao_paralela WHERE id = p_sugestao_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sugestão % não encontrada', p_sugestao_id; END IF;
  IF v_sugestao.campanha_id_gerada IS NOT NULL THEN
    RAISE EXCEPTION 'Sugestão % já foi convertida na campanha %', p_sugestao_id, v_sugestao.campanha_id_gerada;
  END IF;
  IF v_sugestao.sku_codigo_omie !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'O SKU % da sugestão não é um código Omie numérico', v_sugestao.sku_codigo_omie USING ERRCODE = '22023';
  END IF;
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
    v_hoje, p_data_fim, p_data_fim,
    (date_trunc('month', p_data_fim::timestamp) + interval '2 months - 1 day')::date,
    p_responsavel_nome, p_canal, v_hoje,
    p_volume_minimo, p_volume_unidade,
    'aceita', p_observacoes, false
  ) RETURNING id INTO v_campanha_id;
  INSERT INTO promocao_item (
    campanha_id, sku_codigo_fornecedor, descricao_produto_fornecedor, sku_codigo_omie,
    mapeamento_qualidade, desconto_perc, confirmado, ativo, observacoes
  ) VALUES (
    v_campanha_id, v_codigo, v_sugestao.sku_descricao, v_sugestao.sku_codigo_omie::bigint,
    'manual_confirmado', p_desconto_perc, true, true,
    format('Convertido da sugestão de negociação paralela #%s', p_sugestao_id)
  );
  UPDATE sugestao_negociacao_paralela
  SET status = 'fechada_desconto', campanha_id_gerada = v_campanha_id,
      data_acao = now(), observacoes = p_observacoes, atualizado_em = now()
  WHERE id = p_sugestao_id;
  RETURN v_campanha_id;
END;
$function$;

-- Fecho PORTA_GATE: o DROP + CREATE nasce com o default ACL (no Supabase, EXECUTE direto a anon) —
-- REVOKE nomeando PUBLIC e anon; a porta do staff pelo PostgREST é authenticated (o gate é o corpo).
REVOKE EXECUTE ON FUNCTION public.converter_sugestao_em_campanha_flat(bigint, numeric, numeric, text, date, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.converter_sugestao_em_campanha_flat(bigint, numeric, numeric, text, date, text, text, text, text) TO authenticated, service_role;

-- Pós-condição: a assinatura antiga SAIU, a nova é ESTE corpo (md5 exato), não lê o relógio da
-- sessão, mantém os atributos da antiga (volátil, SECURITY DEFINER, search_path=public, dono
-- postgres) e a porta PORTA_GATE.
DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text,text)');
  v_src text;
BEGIN
  IF to_regprocedure('public.converter_sugestao_em_campanha_flat(bigint,numeric,numeric,text,date,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'POS1 FALHOU: a assinatura antiga (8 argumentos, quebrada) continua no ar';
  END IF;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POS2 FALHOU: a assinatura nova (9 argumentos) não existe — o botão quebraria';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  IF md5(v_src) <> '557f962e0355b034097be8cf88c27a1a' THEN
    RAISE EXCEPTION 'POS3 FALHOU: o corpo instalado (md5 %) não é o desta migration', md5(v_src);
  END IF;
  IF v_src ~* '\mcurrent_date\M|\mlocaltimestamp\M' OR position('America/Sao_Paulo' IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS4 FALHOU: o corpo ainda lê o relógio da sessão, ou perdeu o fuso de SP';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = v_oid AND p.provolatile = 'v' AND p.prosecdef
                    AND array_to_string(p.proconfig, ';') = 'search_path=public'
                    AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres') THEN
    RAISE EXCEPTION 'POS5 FALHOU: mudou de atributo — esperado volátil, SECURITY DEFINER, search_path=public, dono postgres';
  END IF;
  IF pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS6 FALHOU: ACL — tem de ser fechada para PUBLIC/anon e aberta para authenticated e service_role';
  END IF;
  RAISE NOTICE 'POS OK: converter na assinatura nova, corpo, atributos e porta conferidos';
END
$post$;
