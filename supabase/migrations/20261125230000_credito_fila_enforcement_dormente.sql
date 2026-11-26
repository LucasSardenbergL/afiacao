-- ============================================================
-- Crédito-IA — PR 6a: fila /credito/fila, recomendação IA, alerta > 2 h e enforcement DORMENTE.
-- Spec: docs/superpowers/specs/2026-11-20-credito-ia-design.md §5.5/§5.7/§9.10/§10.
-- Plano: docs/superpowers/plans/2026-11-25-credito-ia-pr6-fila.md (Codex desenho incorporado).
--
-- DEPENDE DO PR 5 (20261125200000_credito_gate_v2_sombra.sql): a aba Sombra lê credito_sombra_decisao.
-- A postcondição aborta se o PR 5 não estiver aplicado.
--
-- Só objetos NOVOS + 1 troca de ACL: a autorização da fila passa a ter UM caminho
-- (credito_decidir_fila), que confere se o item ainda é o atual. Não toca o núcleo
-- private.credito_avaliar_reservar nem venda_gate_credito_grupo (o PR 5 é dono deles).
--
-- Invariantes:
--  * Flag DESLIGADO nas 3 empresas. Desligado → credito_gate_v2_efetivo devolve
--    {resultado:'desligado'} e NÃO escreve nada. Linha ausente = desligado. A decisão de pular é
--    da RPC (lê o flag FOR SHARE na própria transação), nunca de um leitor separado na edge.
--  * Revisão superada/ausente/divergente → resultado EXPLÍCITO (revisao_superada/…): a edge nunca
--    pode tratar isso como "gate indisponível" e despachar o conteúdo velho (Codex P0).
--  * 1 escritor do flag: credito_definir_enforcement (aprovador = cap + allowlist = o Lucas).
--    Ligar exige prontidão §9.10; DESLIGAR nunca depende dela (kill switch) e cancela as
--    solicitações abertas da empresa.
--  * Alerta > 2 h só para solicitação EFETIVA, atual e com o flag ligado; estado verdadeiro:
--    'sem_canal' (sem segredo/assinatura → nada enfileirado, tenta de novo) ≠ 'enfileirado'.
--    'enfileirado' é enqueue no pg_net, NÃO entrega: a entrega real é ensaio antes de ligar.
--  * Recomendação: entrada projetada campo a campo ANTES da chamada (números/flags/enums da
--    própria decisão — nunca nome, observação, texto livre ou o jsonb da ficha); claim atômico
--    antes da chamada externa; 'ok' e 'esgotada' são finais.
--
-- Prova PG17: db/test-credito-fila.sh (asserts + falsificação, C e pt_BR.UTF-8).
-- Reversão: cron.unschedule dos 2 jobs + DROP dos objetos novos + GRANT EXECUTE de volta em
-- credito_autorizar_solicitacao para authenticated (sem dado de negócio até ligar).
-- ============================================================

-- ── 1. Tabelas ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.credito_enforcement (
  company text PRIMARY KEY CHECK (company IN ('oben','colacor','colacor_sc')),
  ligado boolean NOT NULL DEFAULT false,
  versao integer NOT NULL DEFAULT 0 CHECK (versao >= 0),
  alterado_por uuid,
  alterado_em timestamptz,
  motivo text,
  CHECK ((versao = 0) = (alterado_em IS NULL))
);

CREATE TABLE IF NOT EXISTS public.credito_enforcement_log (
  id uuid PRIMARY KEY,
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  ligado_antes boolean NOT NULL,
  ligado_depois boolean NOT NULL,
  versao integer NOT NULL CHECK (versao >= 1),
  motivo text NOT NULL CHECK (length(btrim(motivo)) >= 3),
  por uuid NOT NULL,
  prontidao jsonb NOT NULL,
  solicitacoes_canceladas integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Recomendação por decisão. Ciclo: em_andamento → ok | erro → (em_andamento …) → esgotada.
CREATE TABLE IF NOT EXISTS public.credito_fila_recomendacao (
  decisao_id uuid PRIMARY KEY,   -- credito_decisao_pedido.id (efetivo) ou credito_sombra_decisao.id (PR 5)
  origem text NOT NULL CHECK (origem IN ('efetivo','sombra')),
  status text NOT NULL CHECK (status IN ('em_andamento','ok','erro','esgotada')),
  reivindicada_em timestamptz NOT NULL DEFAULT now(),   -- orçamento GLOBAL de chamadas pagas
  claim_id uuid,
  claim_expira_em timestamptz,
  recomendacao text CHECK (recomendacao IN ('aprovar','recusar','sem_recomendacao')),
  prazo_sugerido_dias integer CHECK (prazo_sugerido_dias IS NULL OR prazo_sugerido_dias BETWEEN 0 AND 365),
  confianca numeric CHECK (confianca IS NULL OR confianca BETWEEN 0 AND 1),
  codigos text[] NOT NULL DEFAULT '{}' CHECK (codigos <@ ARRAY[
    'dentro_historico','estouro_pequeno','estouro_grande','prazo_acima_historico','prazo_desconhecido',
    'risco_alto','sem_historico','exposicao_alta','pagador_pontual','atraso_recente',
    'limite_desatualizado','sem_limite','limite_mudou']::text[]),
  modelo text,
  versao_prompt text,
  entrada jsonb NOT NULL,
  erro text,
  tentativas integer NOT NULL DEFAULT 1 CHECK (tentativas BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'em_andamento') = (claim_id IS NOT NULL AND claim_expira_em IS NOT NULL)),
  CHECK ((status = 'ok') = (recomendacao IS NOT NULL)),
  CHECK (status NOT IN ('erro','esgotada') OR erro IS NOT NULL),
  -- coerência: aprovar/recusar exigem confiança; prazo sugerido é informativo (o aprovador NÃO troca o
  -- prazo na fila: autorizar libera o prazo da revisão — Codex diff P1)
  CHECK (recomendacao IS DISTINCT FROM 'aprovar' OR confianca IS NOT NULL),
  CHECK (recomendacao IS DISTINCT FROM 'recusar' OR confianca IS NOT NULL),
  CHECK (recomendacao IS DISTINCT FROM 'sem_recomendacao' OR (prazo_sugerido_dias IS NULL AND confianca IS NULL))
);

-- 1 linha por solicitação (dedupe lógico). 'sem_canal' é reavaliado a cada tick; 'enfileirado' é final.
CREATE TABLE IF NOT EXISTS public.credito_fila_alerta (
  solicitacao_id uuid PRIMARY KEY REFERENCES public.credito_solicitacao(id),
  status text NOT NULL CHECK (status IN ('sem_canal','enfileirado')),
  destinatarios uuid[] NOT NULL,
  motivo_sem_canal text,
  tentativas integer NOT NULL DEFAULT 1 CHECK (tentativas >= 1),
  ultima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  enfileirado_em timestamptz,
  CHECK ((status = 'enfileirado') = (enfileirado_em IS NOT NULL)),
  CHECK ((status = 'sem_canal') = (motivo_sem_canal IS NOT NULL)),
  CHECK (status = 'sem_canal' OR cardinality(destinatarios) >= 1)
);

-- ── 2. RLS, grants e guardas (molde do PR 2) ───────────────────────────────────────────────
DO $rls$
DECLARE
  t text;
  r record;
BEGIN
  FOREACH t IN ARRAY ARRAY['credito_enforcement','credito_enforcement_log',
                           'credito_fila_recomendacao','credito_fila_alerta'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon', t);
    -- fecho por ALLOWLIST: o default ACL dá INSERT também a sandbox_exec* (builder do Lovable)
    FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
               FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
              WHERE c.oid = ('public.' || t)::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.%I FROM %s', t, r.papel);
      IF r.papel NOT IN ('authenticated', 'service_role', 'claude_ro') THEN
        EXECUTE format('REVOKE SELECT ON public.%I FROM %s', t, r.papel);
      END IF;
    END LOOP;
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_gestor', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
                   'USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))))',
                   t || '_select_gestor', t);
    EXECUTE format('DROP TRIGGER IF EXISTS credito_guarda_truncate ON public.%I', t);
    EXECUTE format('CREATE TRIGGER credito_guarda_truncate BEFORE TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION public.credito_guarda_escrita(''id'')', t);
  END LOOP;

  FOR r IN SELECT * FROM (VALUES
      ('credito_enforcement',       'company',        'ligado,versao,alterado_por,alterado_em,motivo', NULL),
      ('credito_enforcement_log',   'id',             NULL, NULL),
      ('credito_fila_recomendacao', 'decisao_id',
         'status,claim_id,claim_expira_em,reivindicada_em,recomendacao,prazo_sugerido_dias,confianca,codigos,modelo,versao_prompt,entrada,erro,tentativas,atualizado_em',
         NULL),
      ('credito_fila_alerta',       'solicitacao_id',
         'status,destinatarios,motivo_sem_canal,tentativas,ultima_tentativa_em,enfileirado_em', 'sem_canal')
    ) v(tabela, chave, mutaveis, aberto) LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS credito_guarda_linha ON public.%I', r.tabela);
    EXECUTE format('CREATE TRIGGER credito_guarda_linha BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.credito_guarda_escrita(%s)',
                   r.tabela,
                   concat_ws(', ', quote_literal(r.chave), quote_literal(r.mutaveis), quote_literal(r.aberto)));
  END LOOP;
END
$rls$;

-- Recomendação final (ok/esgotada) não muda — a guarda genérica só aceita 1 status aberto.
CREATE OR REPLACE FUNCTION public.credito_recomendacao_final_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status IN ('ok','esgotada') THEN
    RAISE EXCEPTION 'credito_fila_recomendacao: recomendação final (%) não muda', OLD.status USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.credito_recomendacao_final_imutavel() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS credito_recomendacao_final ON public.credito_fila_recomendacao;
CREATE TRIGGER credito_recomendacao_final BEFORE UPDATE ON public.credito_fila_recomendacao
  FOR EACH ROW EXECUTE FUNCTION public.credito_recomendacao_final_imutavel();

-- Semente: as 3 empresas DESLIGADAS. Idempotente; nunca mexe em linha existente.
DO $seed$
DECLARE
  c text;
BEGIN
  FOREACH c IN ARRAY ARRAY['oben','colacor','colacor_sc'] LOOP
    PERFORM public.credito_portao(c);
    INSERT INTO public.credito_enforcement (company) VALUES (c) ON CONFLICT (company) DO NOTHING;
  END LOOP;
  PERFORM public.credito_portao(NULL);
END
$seed$;

-- ── 3. Prontidão §9.10 (o critério de ligar, como query) ───────────────────────────────────
-- Pré-requisitos que nenhuma query prova (código não entregue, ensaio humano): quem entregar
-- um deles faz CREATE OR REPLACE desta função tirando o item — no diff, revisável.
CREATE OR REPLACE FUNCTION public.credito_enforcement_prontidao(p_company text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
    '6b_edge_omie_vendas_sync_chama_o_gate_efetivo'];
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
$$;

-- ── 4. Único escritor do flag ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.credito_definir_enforcement(p_company text, p_ligar boolean, p_motivo text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_e public.credito_enforcement%ROWTYPE;
  v_pront jsonb;
  v_log uuid := gen_random_uuid();
  v_canc integer := 0;
  v_s record;
BEGIN
  IF NOT (COALESCE(private.cap_credito_escrever(v_uid), false)
          AND EXISTS (SELECT 1 FROM public.credito_aprovador a WHERE a.user_id = v_uid)) THEN
    RAISE EXCEPTION 'credito_definir_enforcement: só o aprovador de crédito liga/desliga' USING ERRCODE = '42501';
  END IF;
  IF p_ligar IS NULL OR p_motivo IS NULL OR length(btrim(p_motivo)) < 3 THEN
    RAISE EXCEPTION 'credito_definir_enforcement: decisão e motivo obrigatórios' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_e FROM public.credito_enforcement WHERE company = p_company FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credito_definir_enforcement: empresa inválida' USING ERRCODE = '22023';
  END IF;
  IF v_e.ligado = p_ligar THEN
    RAISE EXCEPTION 'credito_definir_enforcement: já está %', CASE WHEN p_ligar THEN 'ligado' ELSE 'desligado' END
      USING ERRCODE = 'P0001';
  END IF;

  IF p_ligar THEN
    v_pront := public.credito_enforcement_prontidao(p_company);
    IF NOT COALESCE((v_pront ->> 'pronto')::boolean, false) THEN
      RAISE EXCEPTION 'credito_definir_enforcement: prontidão §9.10 não cumprida (%)',
        (SELECT string_agg(c ->> 'chave', ', ') FROM jsonb_array_elements(v_pront -> 'condicoes') c
          WHERE NOT (c ->> 'ok')::boolean)
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    -- kill switch: a foto da prontidão é só registro — erro nela nunca impede desligar
    BEGIN
      v_pront := public.credito_enforcement_prontidao(p_company);
    EXCEPTION WHEN OTHERS THEN
      v_pront := jsonb_build_object('erro', SQLERRM, 'sqlstate', SQLSTATE);
    END;
    -- desligado, o pedido volta ao caminho do PR 1: solicitação aberta deixa de ter sentido
    FOR v_s IN SELECT s.id FROM public.credito_solicitacao s
                WHERE s.company = p_company AND s.status = 'aberta' FOR UPDATE LOOP
      PERFORM public.credito_portao(v_s.id::text);
      UPDATE public.credito_solicitacao SET status = 'cancelada', decidida_em = now()
       WHERE id = v_s.id AND status = 'aberta';
      v_canc := v_canc + 1;
    END LOOP;
  END IF;

  PERFORM public.credito_portao(p_company);
  UPDATE public.credito_enforcement
     SET ligado = p_ligar, versao = v_e.versao + 1, alterado_por = v_uid, alterado_em = now(), motivo = p_motivo
   WHERE company = p_company;
  PERFORM public.credito_portao(v_log::text);
  INSERT INTO public.credito_enforcement_log (id, company, ligado_antes, ligado_depois, versao, motivo, por,
                                              prontidao, solicitacoes_canceladas)
  VALUES (v_log, p_company, v_e.ligado, p_ligar, v_e.versao + 1, p_motivo, v_uid, v_pront, v_canc);
  PERFORM public.credito_portao(NULL);
  RETURN jsonb_build_object('company', p_company, 'ligado', p_ligar, 'versao', v_e.versao + 1,
                            'log_id', v_log, 'solicitacoes_canceladas', v_canc);
END;
$$;

-- ── 5. Gate efetivo (DORMENTE: só a edge 6b chama; só morde com o flag ligado) ─────────────
-- resultado ∈ desligado | avaliado | pedido_inexistente | revisao_inexistente | revisao_superada | conta_divergente.
-- Só 'avaliado' traz faixa. As outras NÃO são "gate indisponível": a edge segura e revalida.
CREATE OR REPLACE FUNCTION public.credito_gate_v2_efetivo(p_sales_order_id uuid, p_company text, p_revisao uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ligado boolean;
  v_conta text;
  v_r public.credito_operacao_revisao%ROWTYPE;
  v_max integer;
  v_res jsonb;
  v_s record;
BEGIN
  IF p_sales_order_id IS NULL OR p_company IS NULL THEN
    RAISE EXCEPTION 'credito_gate_v2_efetivo: pedido e empresa obrigatórios' USING ERRCODE = '22023';
  END IF;
  -- a conta é a do PEDIDO (autoritativa): a declarada nunca escolhe o flag (Codex diff P0)
  SELECT so.account INTO v_conta FROM public.sales_orders so WHERE so.id = p_sales_order_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'pedido_inexistente', 'ligado', NULL, 'company', p_company);
  END IF;
  -- FOR SHARE: um "desligar" concorrente espera esta avaliação terminar (e vice-versa).
  SELECT e.ligado INTO v_ligado FROM public.credito_enforcement e WHERE e.company = v_conta FOR SHARE;
  IF NOT COALESCE(v_ligado, false) THEN
    RETURN jsonb_build_object('resultado', 'desligado', 'ligado', false, 'company', v_conta);
  END IF;
  IF v_conta IS DISTINCT FROM p_company THEN
    RETURN jsonb_build_object('resultado', 'conta_divergente', 'ligado', true, 'company', p_company,
                              'conta_pedido', v_conta);
  END IF;
  IF p_revisao IS NULL THEN
    RETURN jsonb_build_object('resultado', 'revisao_inexistente', 'ligado', true, 'company', p_company);
  END IF;

  -- mesmo lock do registrador de revisão (PR 3): nenhuma r2 nasce entre a leitura e a avaliação
  PERFORM pg_advisory_xact_lock(hashtextextended('credito_revisao:' || p_sales_order_id::text || ':' || p_company, 0));
  SELECT * INTO v_r FROM public.credito_operacao_revisao r
   WHERE r.id = p_revisao AND r.sales_order_id = p_sales_order_id AND r.company = p_company;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('resultado', 'revisao_inexistente', 'ligado', true, 'company', p_company);
  END IF;
  SELECT max(r.seq) INTO v_max FROM public.credito_operacao_revisao r
   WHERE r.sales_order_id = p_sales_order_id AND r.company = p_company;
  IF v_r.seq <> v_max THEN
    RETURN jsonb_build_object('resultado', 'revisao_superada', 'ligado', true, 'company', p_company,
                              'revisao_seq', v_r.seq, 'vigente_seq', v_max);
  END IF;

  v_res := private.credito_avaliar_reservar(p_sales_order_id, p_company, v_r.omie_codigo_cliente,
                                            v_r.id::text, v_r.valor_brl, v_r.prazo_dias, 'efetivo', v_r.criada_por);

  -- a fila mostra só a pendência ATUAL: solicitação aberta de outra revisão (ou desta, se o
  -- veredito agora não é amarelo) fica superada.
  FOR v_s IN SELECT s.id FROM public.credito_solicitacao s
              WHERE s.sales_order_id = p_sales_order_id AND s.company = p_company AND s.status = 'aberta'
                AND s.id IS DISTINCT FROM NULLIF(v_res ->> 'solicitacao_id', '')::uuid
              FOR UPDATE LOOP
    PERFORM public.credito_portao(v_s.id::text);
    UPDATE public.credito_solicitacao SET status = 'cancelada', decidida_em = now()
     WHERE id = v_s.id AND status = 'aberta';
  END LOOP;
  PERFORM public.credito_portao(NULL);

  RETURN v_res || jsonb_build_object('resultado', 'avaliado', 'ligado', true, 'revisao_seq', v_r.seq);
END;
$$;

-- ── 6. Fila (efetivo = solicitação ATUAL; sombra = ÚLTIMA avaliação, depois filtrada) ──────
CREATE OR REPLACE VIEW public.credito_fila_v
WITH (security_invoker = on) AS
WITH sombra AS (
  -- 1º a ÚLTIMA avaliação de sombra por pedido×empresa (qualquer faixa); só depois o filtro:
  -- amarelo de ontem não ressuscita se hoje deu verde, vermelho ou pendência cadastral.
  SELECT DISTINCT ON (d.sales_order_id, d.company) d.*
    FROM public.credito_sombra_decisao d
   WHERE d.avaliado_em > now() - interval '14 days'
   ORDER BY d.sales_order_id, d.company, d.avaliado_em DESC, d.id DESC
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
         so.customer_user_id, so.omie_numero_pedido, so.vendedor_user_id, so.created_by,
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
       so.customer_user_id, so.omie_numero_pedido, so.status, so.vendedor_user_id,
       d.origem,
       r.status, r.recomendacao, r.prazo_sugerido_dias, r.confianca, r.codigos
  FROM sombra d
  JOIN public.sales_orders so ON so.id = d.sales_order_id
  LEFT JOIN public.credito_fila_recomendacao r ON r.decisao_id = d.id
 WHERE d.faixa = 'amarelo'
   AND d.motivo NOT IN ('sem_grupo','grupo_conflito','piso_indeterminado','grupo_mudou','sync_defasado')
   AND so.deleted_at IS NULL AND COALESCE(so.status, '') <> 'cancelado';

REVOKE ALL ON public.credito_fila_v FROM PUBLIC, anon;
DO $acl_view$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT a.grantee::regrole::text AS papel
             FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
            WHERE c.oid = 'public.credito_fila_v'::regclass AND a.grantee <> 0 AND a.grantee <> c.relowner LOOP
    EXECUTE format('REVOKE ALL ON public.credito_fila_v FROM %s', r.papel);
  END LOOP;
END
$acl_view$;
GRANT SELECT ON public.credito_fila_v TO authenticated, service_role;

-- ── 7. Decidir item da fila (o ÚNICO caminho de autorização) ───────────────────────────────
CREATE OR REPLACE FUNCTION public.credito_decidir_fila(
  p_solicitacao_id uuid,
  p_autorizar boolean,
  p_motivo text,
  p_validade_horas integer DEFAULT 24
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_s public.credito_solicitacao%ROWTYPE;
  v_estado text;
  v_ligado boolean;
BEGIN
  IF NOT public.credito_sou_aprovador() THEN
    RAISE EXCEPTION 'credito_decidir_fila: só o aprovador de crédito decide' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_s FROM public.credito_solicitacao WHERE id = p_solicitacao_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'credito_decidir_fila: solicitação inexistente' USING ERRCODE = 'P0002';
  END IF;
  SELECT e.ligado INTO v_ligado FROM public.credito_enforcement e WHERE e.company = v_s.company FOR SHARE;
  IF NOT COALESCE(v_ligado, false) THEN
    RAISE EXCEPTION 'credito_decidir_fila: enforcement desligado nesta empresa (item congelado)' USING ERRCODE = 'P0001';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('credito_revisao:' || v_s.sales_order_id::text || ':' || v_s.company, 0));
  SELECT f.status INTO v_estado FROM public.credito_fila_v f
   WHERE f.origem = 'efetivo' AND f.solicitacao_id = p_solicitacao_id;
  IF v_estado IS DISTINCT FROM 'aberta' THEN
    RAISE EXCEPTION 'credito_decidir_fila: item não é mais acionável (%)', COALESCE(v_estado, 'fora da fila')
      USING ERRCODE = 'P0001';
  END IF;
  RETURN public.credito_autorizar_solicitacao(p_solicitacao_id, p_autorizar, p_motivo, p_validade_horas);
END;
$$;

-- ── 8. Recomendação: entrada projetada (antes da chamada), claim e único escritor ──────────
-- Só números/flags/enums DA DECISÃO. O risco do limite entra só se for a MESMA versão que a
-- decisão viu (senão 'limite_mudou' e nada do limite novo).
CREATE OR REPLACE FUNCTION private.credito_fila_entrada_ia(p_decisao_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH d AS (
    SELECT x.company, x.modo, x.faixa, x.motivo, x.valor_brl, x.prazo_dias, x.limite_brl, x.prazo_max_dias,
           x.exposicao_titulos_brl, x.exposicao_reservas_brl, x.limite_versao, x.grupo_user_id, x.piso,
           x.created_at AS em
      FROM public.credito_decisao_pedido x WHERE x.id = p_decisao_id
    UNION ALL
    SELECT y.company, 'sombra', y.faixa, y.motivo, y.valor_brl, y.prazo_dias, y.limite_brl, y.prazo_max_dias,
           y.exposicao_titulos_brl, y.exposicao_reservas_brl, y.limite_versao, y.grupo_user_id, y.piso,
           y.avaliado_em
      FROM public.credito_sombra_decisao y WHERE y.id = p_decisao_id
  )
  SELECT jsonb_strip_nulls(jsonb_build_object(
      'company', d.company, 'modo', d.modo, 'faixa', d.faixa, 'motivo', d.motivo,
      'valor_brl', d.valor_brl, 'prazo_dias', d.prazo_dias,
      'limite_brl', d.limite_brl, 'prazo_max_dias', d.prazo_max_dias,
      'exposicao_titulos_brl', d.exposicao_titulos_brl, 'exposicao_reservas_brl', d.exposicao_reservas_brl,
      'uso_limite_pos_pedido', CASE WHEN d.limite_brl > 0 AND d.exposicao_titulos_brl IS NOT NULL
                                    AND d.exposicao_reservas_brl IS NOT NULL
                               THEN round((d.exposicao_titulos_brl + d.exposicao_reservas_brl + d.valor_brl)
                                          / d.limite_brl, 4) END,
      'risco', CASE WHEN l.versao = d.limite_versao THEN l.risco END,
      'limite_mudou', CASE WHEN d.limite_versao IS NOT NULL THEN l.versao IS DISTINCT FROM d.limite_versao END,
      'limite_idade_dias', CASE WHEN l.versao = d.limite_versao
                                THEN floor(extract(epoch FROM d.em - l.ficha_calculada_em) / 86400)::integer END,
      'piso_bloqueado', CASE WHEN jsonb_typeof(d.piso -> 'bloqueado') = 'boolean'
                             THEN (d.piso ->> 'bloqueado')::boolean END,
      'piso_titulos_vencidos', CASE WHEN jsonb_typeof(d.piso -> 'titulos') = 'number'
                                    THEN (d.piso ->> 'titulos')::numeric END,
      'piso_vencido_brl', CASE WHEN jsonb_typeof(d.piso -> 'vencido') = 'number'
                               THEN (d.piso ->> 'vencido')::numeric END))
  FROM d
  LEFT JOIN public.credito_limite l ON l.grupo_user_id = d.grupo_user_id
  LIMIT 1;
$$;

-- defesa em profundidade: string só em chave de enum, e só [a-z_]; objeto/array recusado
CREATE OR REPLACE FUNCTION private.credito_entrada_so_escalares(p jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p IS NOT NULL AND jsonb_typeof(p) = 'object'
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_each(p) e
        WHERE jsonb_typeof(e.value) IN ('object','array')
           OR (jsonb_typeof(e.value) = 'string'
               AND (e.key NOT IN ('company','modo','faixa','motivo','risco')
                    OR (e.value #>> '{}') !~ '^[a-z0-9_]{1,40}$')));
$$;

-- Reivindica até p_max itens ANTES da chamada externa (efetivo antes de sombra). Claim vencido
-- (worker morreu) volta a ser reivindicável; esgotado nunca volta.
CREATE OR REPLACE FUNCTION public.credito_fila_reivindicar_recomendacao(p_max integer DEFAULT 20)
RETURNS TABLE (decisao_id uuid, claim_id uuid, entrada jsonb)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_i record;
  v_ent jsonb;
  v_claim uuid;
  v_ant public.credito_fila_recomendacao%ROWTYPE;
  v_n integer := 0;
  v_max integer;
BEGIN
  -- 1 reivindicação por vez no banco inteiro: o orçamento é global, não por invocação (Codex diff P1)
  PERFORM pg_advisory_xact_lock(hashtextextended('credito_recomendacao:orcamento', 0));
  SELECT 5 - count(*) INTO v_max FROM public.credito_fila_recomendacao r
   WHERE r.reivindicada_em > now() - interval '10 minutes';
  v_max := least(greatest(v_max, 0), greatest(1, least(COALESCE(p_max, 5), 5)));
  IF v_max = 0 THEN
    RETURN;
  END IF;
  FOR v_i IN
    SELECT f.decisao_id AS id, f.origem
      FROM public.credito_fila_v f
      LEFT JOIN public.credito_fila_recomendacao r ON r.decisao_id = f.decisao_id
     WHERE f.status IN ('aberta','simulada')
       AND (r.decisao_id IS NULL OR r.status = 'erro'
            OR (r.status = 'em_andamento' AND r.claim_expira_em < now()))
     ORDER BY (f.origem = 'efetivo') DESC, f.criado_em
  LOOP
    EXIT WHEN v_n >= v_max;
    -- serializa por decisão; outro worker que ganhou o item faz este pular
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(hashtextextended('credito_recomendacao:' || v_i.id::text, 0));
    SELECT * INTO v_ant FROM public.credito_fila_recomendacao r WHERE r.decisao_id = v_i.id;
    CONTINUE WHEN FOUND AND NOT (v_ant.status = 'erro'
                                 OR (v_ant.status = 'em_andamento' AND v_ant.claim_expira_em < now()));
    -- toda retomada (erro OU claim vencido — a IA pode ter cobrado) conta tentativa; 3 → esgotada
    IF v_ant.decisao_id IS NOT NULL AND v_ant.tentativas >= 3 THEN
      PERFORM public.credito_portao(v_i.id::text);
      UPDATE public.credito_fila_recomendacao
         SET status = 'esgotada', claim_id = NULL, claim_expira_em = NULL,
             erro = COALESCE(v_ant.erro, 'claim vencido sem resposta'), atualizado_em = now()
       WHERE decisao_id = v_i.id;
      PERFORM public.credito_portao(NULL);
      CONTINUE;
    END IF;
    v_ent := private.credito_fila_entrada_ia(v_i.id);
    CONTINUE WHEN NOT private.credito_entrada_so_escalares(v_ent);
    v_claim := gen_random_uuid();
    PERFORM public.credito_portao(v_i.id::text);
    IF v_ant.decisao_id IS NULL THEN
      INSERT INTO public.credito_fila_recomendacao (decisao_id, origem, status, claim_id, claim_expira_em, entrada)
      VALUES (v_i.id, v_i.origem, 'em_andamento', v_claim, now() + interval '5 minutes', v_ent);
    ELSE
      UPDATE public.credito_fila_recomendacao
         SET status = 'em_andamento', claim_id = v_claim, claim_expira_em = now() + interval '5 minutes',
             reivindicada_em = now(), entrada = v_ent, erro = NULL, atualizado_em = now(),
             tentativas = v_ant.tentativas + 1
       WHERE decisao_id = v_i.id;
    END IF;
    PERFORM public.credito_portao(NULL);
    decisao_id := v_i.id; claim_id := v_claim; entrada := v_ent;
    v_n := v_n + 1;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- Único escritor do resultado. Resposta de claim velho (atrasada) é descartada.
-- p_erro preenchido = falha técnica (timeout/429/5xx/saída inválida): retentável até 3.
-- 'sem_recomendacao' sem erro = abstenção válida, FINAL.
CREATE OR REPLACE FUNCTION public.credito_registrar_recomendacao(
  p_decisao_id uuid,
  p_claim_id uuid,
  p_recomendacao text,
  p_prazo_sugerido_dias integer,
  p_confianca numeric,
  p_codigos text[],
  p_modelo text,
  p_versao_prompt text,
  p_erro text DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_ant public.credito_fila_recomendacao%ROWTYPE;
  v_status text;
BEGIN
  IF p_decisao_id IS NULL OR p_claim_id IS NULL THEN
    RAISE EXCEPTION 'credito_registrar_recomendacao: decisão e claim obrigatórios' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('credito_recomendacao:' || p_decisao_id::text, 0));
  SELECT * INTO v_ant FROM public.credito_fila_recomendacao WHERE decisao_id = p_decisao_id;
  IF NOT FOUND OR v_ant.status <> 'em_andamento' OR v_ant.claim_id IS DISTINCT FROM p_claim_id THEN
    RETURN 'descartada';   -- claim de outro worker, vencido e retomado, ou já final
  END IF;

  IF p_erro IS NOT NULL THEN
    v_status := CASE WHEN v_ant.tentativas >= 3 THEN 'esgotada' ELSE 'erro' END;
  ELSE
    v_status := 'ok';
  END IF;

  PERFORM public.credito_portao(p_decisao_id::text);
  UPDATE public.credito_fila_recomendacao
     SET status = v_status, claim_id = NULL, claim_expira_em = NULL,
         recomendacao = CASE WHEN v_status = 'ok' THEN p_recomendacao END,
         prazo_sugerido_dias = CASE WHEN v_status = 'ok' AND p_recomendacao IN ('aprovar','recusar') THEN p_prazo_sugerido_dias END,
         confianca = CASE WHEN v_status = 'ok' AND p_recomendacao IN ('aprovar','recusar') THEN p_confianca END,
         codigos = CASE WHEN v_status = 'ok' THEN COALESCE(p_codigos, '{}') ELSE '{}' END,
         modelo = p_modelo, versao_prompt = p_versao_prompt,
         erro = CASE WHEN v_status = 'ok' THEN NULL ELSE left(p_erro, 500) END,
         atualizado_em = now()
   WHERE decisao_id = p_decisao_id AND status = 'em_andamento' AND claim_id = p_claim_id;
  PERFORM public.credito_portao(NULL);
  RETURN v_status;
END;
$$;

-- ── 9. Alerta > 2 h (pg_cron 15 min = "1º tick após completar 2 h"; só efetivo atual) ──────
CREATE OR REPLACE FUNCTION private.credito_fila_alertar()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dest uuid[];
  v_canal text;
  v_s record;
  v_ant public.credito_fila_alerta%ROWTYPE;
  v_n integer := 0;
BEGIN
  -- destinatário resolvido no servidor: a allowlist de aprovador (1 linha: o Lucas)
  SELECT array_agg(a.user_id ORDER BY a.user_id) INTO v_dest FROM public.credito_aprovador a;

  -- canal: sem segredo ou sem assinatura, _push_enviar volta em silêncio — então medimos antes
  v_canal := CASE
    WHEN v_dest IS NULL THEN 'sem_aprovador'
    WHEN NOT EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET'
                      AND COALESCE(decrypted_secret, '') <> '') THEN 'sem_cron_secret'
    WHEN NOT EXISTS (SELECT 1 FROM public.push_subscriptions p WHERE p.user_id = ANY (v_dest)) THEN 'sem_assinatura_push'
  END;

  FOR v_s IN
    SELECT f.solicitacao_id AS id, f.company, f.valor_brl
      FROM public.credito_fila_v f
     WHERE f.origem = 'efetivo' AND f.status = 'aberta' AND f.criado_em <= now() - interval '2 hours'
       AND NOT EXISTS (SELECT 1 FROM public.credito_fila_alerta x
                        WHERE x.solicitacao_id = f.solicitacao_id AND x.status = 'enfileirado')
     ORDER BY f.criado_em
     LIMIT 50
  LOOP
    BEGIN
      -- reconfere SOB LOCK: ainda aberta (o Lucas pode ter decidido agora) — 2 workers: 1 ganha
      PERFORM 1 FROM public.credito_solicitacao s WHERE s.id = v_s.id AND s.status = 'aberta' FOR UPDATE SKIP LOCKED;
      CONTINUE WHEN NOT FOUND;
      SELECT * INTO v_ant FROM public.credito_fila_alerta WHERE solicitacao_id = v_s.id FOR UPDATE;
      CONTINUE WHEN FOUND AND v_ant.status = 'enfileirado';

      PERFORM public.credito_portao(v_s.id::text);
      IF v_canal IS NOT NULL THEN
        IF v_ant.solicitacao_id IS NULL THEN
          INSERT INTO public.credito_fila_alerta (solicitacao_id, status, destinatarios, motivo_sem_canal)
          VALUES (v_s.id, 'sem_canal', COALESCE(v_dest, '{}'), v_canal);
        ELSE
          UPDATE public.credito_fila_alerta
             SET motivo_sem_canal = v_canal, destinatarios = COALESCE(v_dest, '{}'),
                 tentativas = v_ant.tentativas + 1, ultima_tentativa_em = now()
           WHERE solicitacao_id = v_s.id;
        END IF;
      ELSE
        -- sem nome do cliente na tela bloqueada; tag POR solicitação (uma não apaga a outra)
        PERFORM public._push_enviar(v_dest, 'Crédito: pedido esperando há mais de 2 h',
          format('R$ %s · %s',
            -- separadores fixos (to_char G/D seguem lc_numeric): 5.000,00 em qualquer locale
            translate(to_char(v_s.valor_brl, 'FM999,999,990.00'), ',.', '.,'), v_s.company),
          '/credito/fila', 'credito-fila-' || v_s.id::text);
        IF v_ant.solicitacao_id IS NULL THEN
          INSERT INTO public.credito_fila_alerta (solicitacao_id, status, destinatarios, enfileirado_em)
          VALUES (v_s.id, 'enfileirado', v_dest, now());
        ELSE
          UPDATE public.credito_fila_alerta
             SET status = 'enfileirado', destinatarios = v_dest, motivo_sem_canal = NULL,
                 tentativas = v_ant.tentativas + 1, ultima_tentativa_em = now(), enfileirado_em = now()
           WHERE solicitacao_id = v_s.id;
        END IF;
        v_n := v_n + 1;
      END IF;
      PERFORM public.credito_portao(NULL);
    EXCEPTION WHEN OTHERS THEN
      -- o sub-bloco desfaz o registro deste item: nova tentativa no próximo tick
      RAISE WARNING '[credito_fila_alertar] solicitação %: % (%)', v_s.id, SQLERRM, SQLSTATE;
    END;
  END LOOP;
  PERFORM public.credito_portao(NULL);
  RETURN v_n;
END;
$$;

-- ── 10. Grants (fecho por allowlist, molde do PR 2) ────────────────────────────────────────
DO $grants$
DECLARE
  f record;
  g record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure::text AS sig
             FROM pg_proc p
            WHERE p.oid IN ('public.credito_enforcement_prontidao(text)'::regprocedure,
                            'public.credito_definir_enforcement(text,boolean,text)'::regprocedure,
                            'public.credito_gate_v2_efetivo(uuid,text,uuid)'::regprocedure,
                            'public.credito_decidir_fila(uuid,boolean,text,integer)'::regprocedure,
                            'public.credito_autorizar_solicitacao(uuid,boolean,text,integer)'::regprocedure,
                            'private.credito_fila_entrada_ia(uuid)'::regprocedure,
                            'private.credito_entrada_so_escalares(jsonb)'::regprocedure,
                            'public.credito_fila_reivindicar_recomendacao(integer)'::regprocedure,
                            'public.credito_registrar_recomendacao(uuid,uuid,text,integer,numeric,text[],text,text,text)'::regprocedure,
                            'private.credito_fila_alertar()'::regprocedure) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    FOR g IN SELECT DISTINCT a.grantee::regrole::text AS papel
               FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
              WHERE p.oid = f.sig::regprocedure AND a.grantee <> 0 AND a.grantee <> p.proowner LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %s', f.sig, g.papel);
    END LOOP;
  END LOOP;
END
$grants$;
GRANT EXECUTE ON FUNCTION public.credito_gate_v2_efetivo(uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.credito_fila_reivindicar_recomendacao(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.credito_registrar_recomendacao(uuid,uuid,text,integer,numeric,text[],text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.credito_enforcement_prontidao(text) TO authenticated, service_role;
DO $ro$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_ro') THEN
    GRANT EXECUTE ON FUNCTION public.credito_enforcement_prontidao(text) TO claude_ro;
  END IF;
END $ro$;
GRANT EXECUTE ON FUNCTION public.credito_definir_enforcement(text,boolean,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.credito_decidir_fila(uuid,boolean,text,integer) TO authenticated;
-- credito_autorizar_solicitacao (PR 2) fica SEM grant: só credito_decidir_fila (dono) a chama.

-- ── 11. Cron (alerta SQL; recomendação chama a edge com timeout explícito) ─────────────────
DO $cron$
BEGIN
  IF to_regnamespace('cron') IS NULL OR to_regprocedure('cron.schedule(text,text,text)') IS NULL THEN
    RAISE NOTICE 'pg_cron ausente: jobs da fila não agendados';
    RETURN;
  END IF;
  PERFORM cron.schedule('credito-fila-alertar', '*/15 * * * *', 'SELECT private.credito_fila_alertar();');
  PERFORM cron.schedule('credito-fila-recomendar', '*/10 * * * *', $job$
    SELECT net.http_post(url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/credito-fila-recomendar',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret',
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET')),
      body := '{"max":5}'::jsonb, timeout_milliseconds := 150000);
  $job$);
END
$cron$;

-- ── 12. Postcondição (marcador positivo; falha aborta a transação) ─────────────────────────
DO $pos$
DECLARE
  t text;
  v_n integer;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['credito_enforcement','credito_enforcement_log',
                           'credito_fila_recomendacao','credito_fila_alerta'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN RAISE EXCEPTION 'POS FALHOU: tabela % não existe', t; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'POS FALHOU: % sem RLS', t;
    END IF;
    SELECT count(*) INTO v_n FROM pg_trigger
     WHERE tgrelid = ('public.' || t)::regclass AND tgname IN ('credito_guarda_linha','credito_guarda_truncate')
       AND tgenabled <> 'D';
    IF v_n <> 2 THEN RAISE EXCEPTION 'POS FALHOU: % sem as 2 guardas de escrita (veio %)', t, v_n; END IF;
    SELECT count(*) INTO v_n
      FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.oid = ('public.' || t)::regclass AND a.grantee <> c.relowner
       AND a.privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');
    IF v_n > 0 THEN RAISE EXCEPTION 'POS FALHOU: % tem % grant(s) de escrita fora do dono', t, v_n; END IF;
  END LOOP;

  IF to_regclass('public.credito_sombra_decisao') IS NULL OR to_regclass('public.credito_sombra_lote') IS NULL
     OR to_regclass('public.credito_sombra_tentativa') IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: PR 5 (ledger da sombra) não aplicado — aplique 20261125200000 antes';
  END IF;
  SELECT count(*) INTO v_n FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.oid = 'public.credito_fila_v'::regclass AND a.grantee <> c.relowner
     AND a.privilege_type <> 'SELECT';
  IF v_n > 0 THEN RAISE EXCEPTION 'POS FALHOU: credito_fila_v com % grant(s) além de SELECT', v_n; END IF;
  IF (SELECT count(*) FROM public.credito_enforcement) <> 3 THEN
    RAISE EXCEPTION 'POS FALHOU: credito_enforcement não tem as 3 empresas';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.credito_fila_v'::regclass
                  AND 'security_invoker=on' = ANY (c.reloptions)) THEN
    RAISE EXCEPTION 'POS FALHOU: credito_fila_v sem security_invoker=on';
  END IF;
  IF has_table_privilege('anon', 'public.credito_fila_v', 'SELECT') THEN
    RAISE EXCEPTION 'POS FALHOU: anon lê credito_fila_v';
  END IF;

  FOREACH f IN ARRAY ARRAY['public.credito_gate_v2_efetivo(uuid,text,uuid)',
                           'public.credito_fila_reivindicar_recomendacao(integer)',
                           'public.credito_registrar_recomendacao(uuid,uuid,text,integer,numeric,text[],text,text,text)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executável por anon/authenticated', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % sem EXECUTE para service_role', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.credito_definir_enforcement(text,boolean,text)',
                           'public.credito_decidir_fila(uuid,boolean,text,integer)',
                           'public.credito_enforcement_prontidao(text)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') THEN RAISE EXCEPTION 'POS FALHOU: % executável por anon', f; END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % sem EXECUTE para authenticated', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.credito_definir_enforcement(text,boolean,text)',
                           'public.credito_decidir_fila(uuid,boolean,text,integer)'] LOOP
    IF has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: service_role executa % (só o aprovador, por auth.uid)', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['private.credito_fila_alertar()','private.credito_fila_entrada_ia(uuid)',
                           'public.credito_autorizar_solicitacao(uuid,boolean,text,integer)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS FALHOU: % executável fora do dono', f;
    END IF;
  END LOOP;
  RAISE NOTICE 'POS OK: crédito PR 6a — fila, flag dormente (3 empresas desligadas), recomendação e alerta';
END
$pos$;
