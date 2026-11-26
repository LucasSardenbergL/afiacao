-- ============================================================
-- Crédito-IA 6b (pós-deploy): a prontidão do enforcement deixa de listar o item 6b (a edge
-- omie-vendas-sync já chama o gate efetivo — #4213 + #4217, publicada e atestada ANTES deste apply)
-- e ganha dois pré-requisitos que o 6b deixou explícitos:
--   · m_front_trata_credito_fila_e_retomada_do_envio — amarelo/vermelho do v2 saem como ERRO (nunca
--     `blocked` novo); antes de ligar, o front precisa tratar a espera na fila e a retomada (Codex P1).
--   · n_gate_v2_volta_a_fail_closed_antes_de_ligar — opção (b) do founder (2026-11-26, "Deixar
--     seguir"): sem veredito da RPC o envio SEGUE. Com o flag ligado isso deixaria passar 🔴/🟡 sem
--     reserva (Codex Q1) → a edge tem de voltar a segurar antes de qualquer empresa ligar.
-- Corpo = pg_get_functiondef da PROD (psql-ro, 2026-11-26), com SÓ a lista v_prereq trocada.
-- CREATE OR REPLACE preserva o ACL (authenticated, service_role, claude_ro).
-- Reversão: reaplicar a função da 20261125230000.
-- ============================================================

CREATE OR REPLACE FUNCTION public.credito_enforcement_prontidao(p_company text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_prereq text[] := ARRAY[
    'a_lock_no_escritor_do_mapa_de_clientes',
    'c_carga_dos_pvs_abertos_e_transferencia_reserva_titulo_no_efetivo',
    'd_retomada_vincula_pv_a_revisao_despachada',
    'e_despacho_serializado_por_revisao',
    'f_tint_atp_antes_da_reserva_e_troca_de_parcela',
    'g_exposicao_do_grupo_cobre_empresas_desligadas_e_pvs_nascidos_no_omie',
    'h_ensaio_real_de_push_e_retomada_na_versao_publicada',
    'i_recusa_encerra_a_revisao_no_nucleo',
    'j_backtest_e_prova_2_sessoes_registrados',
    'k_nucleo_efetivo_herda_da_sombra_sync_titulo_do_pv_e_transferencia',
    'l_primeira_leva_identificada_cobertura_do_sync_e_reconciliacao',
    'm_front_trata_credito_fila_e_retomada_do_envio',
    'n_gate_v2_volta_a_fail_closed_antes_de_ligar'];
  v_cond jsonb := '[]'::jsonb;
  v_n_lim integer;
  v_n_pend integer;
  v_prim timestamptz;
  v_dias integer;
  v_erros integer;
  v_ult timestamptz;
  v_push integer;
  v_cat integer;
  v_sem_prazo integer;
  v_ok boolean;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT COALESCE(public.pode_ver_carteira_completa(auth.uid()), false) THEN
    RAISE EXCEPTION 'credito_enforcement_prontidao: só gestor/master' USING ERRCODE = '42501';
  END IF;
  IF p_company IS NULL OR p_company NOT IN ('oben','colacor','colacor_sc') THEN
    RAISE EXCEPTION 'credito_enforcement_prontidao: empresa inválida' USING ERRCODE = '22023';
  END IF;

  -- 1) 1ª leva: ≥ 1 limite vigente e nenhuma proposta esperando o Lucas (a REVISÃO da leva é o
  --    pré-requisito j/h — esta query só mostra que não há fila de proposta parada)
  SELECT count(*) INTO v_n_lim FROM public.credito_limite;
  SELECT count(*) INTO v_n_pend FROM public.credito_limite_proposta WHERE status = 'pendente';
  v_cond := v_cond || jsonb_build_object('chave', 'primeira_leva', 'ok', v_n_lim >= 1 AND v_n_pend = 0,
    'valor', jsonb_build_object('limites_vigentes', v_n_lim, 'propostas_pendentes', v_n_pend),
    'criterio', '≥ 1 limite vigente e 0 propostas pendentes');

  -- 2) 2+ semanas de sombra COM denominador (dias com decisão)
  SELECT min(d.avaliado_em),
         count(DISTINCT (d.avaliado_em AT TIME ZONE 'America/Sao_Paulo')::date)
           FILTER (WHERE (d.avaliado_em AT TIME ZONE 'America/Sao_Paulo')::date > v_hoje - 14)
    INTO v_prim, v_dias
    FROM public.credito_sombra_decisao d
   WHERE d.company = p_company AND NOT d.carga_inicial;
  v_cond := v_cond || jsonb_build_object('chave', 'sombra_14d',
    'ok', v_prim IS NOT NULL AND v_prim <= now() - interval '14 days' AND COALESCE(v_dias, 0) >= 10,
    'valor', jsonb_build_object('primeira_sombra', v_prim, 'dias_com_sombra_ult_14', COALESCE(v_dias, 0)),
    'criterio', '1ª decisão de sombra há ≥ 14 d e sombra em ≥ 10 dos últimos 14 dias');

  -- 3) o lote da sombra RODA (última execução < 1 h) e sem erro em 3 d. Ledger do PR 5;
  --    ausente ou ilegível ≠ ok (cron parado também mostraria "0 erros").
  BEGIN
    SELECT count(*) INTO v_erros FROM public.credito_sombra_tentativa t
     WHERE t.company = p_company AND t.resultado = 'erro' AND t.criada_em > now() - interval '3 days';
    SELECT max(l.terminado_em) INTO v_ult FROM public.credito_sombra_lote l;
  EXCEPTION WHEN OTHERS THEN
    v_erros := NULL; v_ult := NULL;
  END;
  v_cond := v_cond || jsonb_build_object('chave', 'sombra_rodando_sem_erro',
    'ok', COALESCE(v_erros = 0 AND v_ult > now() - interval '1 hour', false),
    'valor', jsonb_build_object('erros_3d', v_erros, 'ultimo_lote_fim', v_ult),
    'criterio', 'ledger da sombra legível, último lote há < 1 h e 0 erros em 3 dias');

  -- 4) o aprovador é alcançável pelo alerta: ≥ 1 assinatura de push
  SELECT count(*) INTO v_push
    FROM public.push_subscriptions p JOIN public.credito_aprovador a ON a.user_id = p.user_id;
  v_cond := v_cond || jsonb_build_object('chave', 'aprovador_alcancavel', 'ok', v_push >= 1,
    'valor', jsonb_build_object('assinaturas_push', v_push),
    'criterio', 'o aprovador ativou o push em ≥ 1 aparelho');

  -- 5) prazo legível: ≥ 1 parcela resolvível e nenhuma revisão recente da conta com prazo NULL
  -- pelo RESOLVEDOR real (descrição ilegível e override revogado não contam)
  SELECT count(*) INTO v_cat
    FROM (SELECT c.codigo FROM public.omie_condicao_pagamento_catalogo c WHERE lower(c.empresa) = p_company
          UNION SELECT o.codigo_parcela FROM public.credito_prazo_override o WHERE o.company = p_company) k
   WHERE (public.credito_prazo_resolver(k.codigo, p_company) ->> 'prazo_dias') IS NOT NULL;
  SELECT count(*) INTO v_sem_prazo FROM public.credito_operacao_revisao r
   WHERE r.company = p_company AND r.prazo_dias IS NULL AND r.criada_em > now() - interval '30 days';
  v_cond := v_cond || jsonb_build_object('chave', 'catalogo_prazo', 'ok', v_cat >= 1 AND v_sem_prazo = 0,
    'valor', jsonb_build_object('parcelas_resolviveis', v_cat, 'revisoes_30d_sem_prazo', v_sem_prazo),
    'criterio', '≥ 1 parcela no catálogo/override e 0 revisões de 30 d com prazo ilegível');

  -- 6) pré-requisitos sem query
  v_cond := v_cond || jsonb_build_object('chave', 'prereq_codigo', 'ok', cardinality(v_prereq) = 0,
    'valor', jsonb_build_object('pendentes', to_jsonb(v_prereq)),
    'criterio', 'todos os pré-requisitos de código e ensaio entregues');

  -- ok só com TRUE explícito (NULL some no bool_and — Codex diff)
  SELECT bool_and(COALESCE((c ->> 'ok')::boolean, false)) INTO v_ok FROM jsonb_array_elements(v_cond) c;
  RETURN jsonb_build_object('company', p_company, 'pronto', COALESCE(v_ok, false),
                            'medido_em', now(), 'condicoes', v_cond);
END;
$function$;

-- Postcondição: 6b fora, m e n dentro; prontidão segue recusando; ACL intacto.
DO $pos$
DECLARE v_p jsonb; v_pend jsonb;
BEGIN
  v_p := public.credito_enforcement_prontidao('oben');
  SELECT c -> 'valor' -> 'pendentes' INTO v_pend FROM jsonb_array_elements(v_p -> 'condicoes') c
   WHERE c ->> 'chave' = 'prereq_codigo';
  IF v_pend IS NULL THEN RAISE EXCEPTION 'POS FALHOU: prereq_codigo sumiu da prontidão'; END IF;
  IF v_pend ? '6b_edge_omie_vendas_sync_chama_o_gate_efetivo' THEN
    RAISE EXCEPTION 'POS FALHOU: o item 6b continua pendente';
  END IF;
  IF NOT (v_pend ? 'm_front_trata_credito_fila_e_retomada_do_envio' AND v_pend ? 'n_gate_v2_volta_a_fail_closed_antes_de_ligar') THEN
    RAISE EXCEPTION 'POS FALHOU: faltam os pré-requisitos m/n: %', v_pend;
  END IF;
  IF jsonb_array_length(v_pend) <> 13 THEN
    RAISE EXCEPTION 'POS FALHOU: esperava 13 pré-requisitos pendentes, veio %', jsonb_array_length(v_pend);
  END IF;
  IF (v_p ->> 'pronto')::boolean IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'POS FALHOU: prontidão deixou de recusar';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.credito_enforcement_prontidao(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.credito_enforcement_prontidao(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: ACL da prontidão mudou';
  END IF;
  RAISE NOTICE 'POS OK: prontidão sem o 6b, com m (front da fila) e n (fail-closed antes de ligar)';
END
$pos$;
