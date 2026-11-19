-- ============================================================================================
-- Regrupo por recusa do portal Sayerlack (GRUPO_LEADTIME_MISMATCH) — v1, SEM herança de aprovação.
-- Incidentes: #4505 (2026-11-18, YC.1400FP em sayerlack_normal, portal Prz Ent 5 ≠ 8) e os 5
--   precedentes do mesmo estado (#1276, #1497, #2388, #2416, #3169) — TODOS normal→rápido, todos
--   terminaram em cancelamento humano + correção do grupo à mão.
--
-- O que faz: a edge enviar-pedido-portal-sayerlack (v1.16), ao receber a recusa por grupo com
--   efetivarAttempted=false, chama reposicao_regrupar_por_recusa_portal(pedido, tentativa). O
--   SERVIDOR decide tudo a partir da tentativa gravada (pedidos_portal_tentativas.evidence.
--   grupoLeadtime) — nada que a edge passe além dos dois ids é confiado:
--     (1) corrige sku_grupo_producao do(s) SKU(s) recusado(s) para o ÚNICO grupo do fornecedor
--         cujo LT (úteis) = Prz Ent lido no portal (atualizado_por='sistema:prz_ent_portal');
--     (2) cancela o pedido original na hora (status 'cancelado', cancelado_por
--         'sistema:regrupo_portal') — mesma higiene e mesmo predicado de prova do
--         reposicao_encerrar_recusas_definitivas (20261011150000);
--     (3) avisa em fornecedor_alerta. O próximo ciclo do motor (grupo lido AO VIVO) regera os
--         itens no grupo certo, para NOVA aprovação humana. Aprovar continua sendo do founder.
--
-- Fail-closed (precisão > recall): qualquer dúvida → não corrige nada, não cancela, devolve o
--   motivo; a edge alerta como hoje e o encerramento de 3 dias segue valendo. Recusa quando:
--   tentativa não é a mais recente do pedido ou não é a mesma do portal_resposta; pedido saiu do
--   estado da recusa; grade parcialmente lida; célula Prz Ent não é inteiro exato; SKU não
--   identificado ("linha N"); SKU não casa 1:1 com um item do pedido; Prz Ent casa 0 ou >1 grupos;
--   SKU membro de grupo de equivalência ativo (o motor usa o grupo da ÂNCORA — mover um membro
--   reproduziria a recusa: Codex P1, revisão da família é humana); grupo atual do SKU não é nem o
--   do pedido nem o destino. Destino já gravado (caso #4505, corrigido à mão) = "já corrigido":
--   não escreve o cadastro, mas cancela.
--
-- Concorrência: pega o MESMO advisory lock do motor por empresa ANTES dos locks de linha (Codex
--   P0-3) — nem o ciclo nem outra chamada intercalam; depois FOR UPDATE no pedido e no cadastro.
--
-- Ponto de pedido / estoque máximo: NÃO recalculados aqui. Seguem com o aplicador diário
--   (aplicar_parametros_automatico_diario, madrugada), que respeita pinado/segurado/validação e
--   não tem modo de 1 SKU. Um pedido regerado no mesmo dia ainda usa pp/máx do LT antigo (maior);
--   o founder vê a quantidade na aprovação. Decisão registrada no PR.
--
-- APLICAR: bun run db:aplicar supabase/migrations/<este arquivo> — o executor fornece a transação.
-- Idempotente (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS).
-- Pré-voo (psql-ro, 2026-11-18): função nova (pg_proc sem reposicao_regrupar_por_recusa_portal);
--   colunas de pedido_compra_item (sku_portal_aprovado), sku_fornecedor_externo, sku_grupo_producao,
--   fornecedor_grupo_producao, sku_embalagem_equivalencia, pedidos_portal_tentativas e
--   fornecedor_alerta (CHECKs de tipo/severidade/status) conferidas.
-- ============================================================================================

-- (1) Auditoria: 1 linha por SKU decidido (regrupado / ja_corrigido) ou 1 por chamada recusada.
CREATE TABLE IF NOT EXISTS public.reposicao_regrupo_audit (
  id               bigserial PRIMARY KEY,
  pedido_id        bigint NOT NULL,
  tentativa_id     uuid,
  resultado        text NOT NULL CHECK (resultado IN ('regrupado', 'ja_corrigido', 'recusado')),
  motivo           text,
  sku_codigo_omie  text,
  sku_portal       text,
  grupo_de         text,
  grupo_para       text,
  prz_ent          integer,
  lt_esperado      integer,
  criado_em        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reposicao_regrupo_audit_pedido
  ON public.reposicao_regrupo_audit (pedido_id);

ALTER TABLE public.reposicao_regrupo_audit ENABLE ROW LEVEL SECURITY;

-- Staff lê. Escrita só pela função SECURITY DEFINER (sem policy de escrita para authenticated).
DROP POLICY IF EXISTS "reposicao_regrupo_audit_select_staff" ON public.reposicao_regrupo_audit;
CREATE POLICY "reposicao_regrupo_audit_select_staff"
  ON public.reposicao_regrupo_audit
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('employee'::public.app_role, 'master'::public.app_role)
    )
  );

COMMENT ON TABLE public.reposicao_regrupo_audit IS
  'Decisões de reposicao_regrupar_por_recusa_portal (regrupo Sayerlack por Prz Ent). Escritor único: a função.';

-- (2) A RPC ------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reposicao_regrupar_por_recusa_portal(p_pedido_id bigint, p_tentativa_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_empresa     text;
  v_ped         record;
  v_tent        record;
  v_g           jsonb;
  v_lt_pedido   integer;
  v_m           jsonb;
  v_key         text;
  v_sku         text;
  v_n           integer;
  v_prz         integer;
  v_destino     text;
  v_atual       text;
  v_planos      jsonb := '[]'::jsonb;
  v_p           jsonb;
  v_motivo      text;
  v_movidos     integer := 0;
  v_cancelou    bigint;
  v_lista       text;
BEGIN
  SELECT empresa INTO v_empresa FROM public.pedido_compra_sugerido WHERE id = p_pedido_id;
  IF v_empresa IS NULL THEN
    RETURN jsonb_build_object('cancelado', false, 'motivo', 'pedido_inexistente');
  END IF;

  -- Mesmo lock do gerar_pedidos_sugeridos_ciclo, ANTES dos locks de linha.
  PERFORM pg_advisory_xact_lock(hashtext('gerar_pedidos_sugeridos_ciclo:' || lower(v_empresa)));

  <<decidir>>
  BEGIN
    SELECT * INTO v_ped FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;

    -- Estado da recusa provadamente não-efetivada (= predicado do encerramento de 3 dias).
    IF NOT (v_ped.status = 'aprovado_aguardando_disparo'
            AND v_ped.status_envio_portal = 'erro_nao_retentavel'
            AND NULLIF(btrim(v_ped.portal_protocolo), '') IS NULL
            AND NULLIF(btrim(v_ped.omie_pedido_compra_id), '') IS NULL
            AND NULLIF(btrim(v_ped.omie_pedido_compra_numero), '') IS NULL
            AND v_ped.disparo_claim_em IS NULL
            AND v_ped.portal_resposta -> 'evidence' -> 'efetivarAttempted' = 'false'::jsonb
            AND v_ped.portal_resposta -> 'evidence' ->> 'erroTipo' = 'GRUPO_LEADTIME_MISMATCH') IS TRUE THEN
      v_motivo := 'estado_do_pedido_mudou'; EXIT decidir;
    END IF;

    SELECT * INTO v_tent FROM public.pedidos_portal_tentativas
     WHERE id = p_tentativa_id AND pedido_id = p_pedido_id;
    IF NOT FOUND THEN v_motivo := 'tentativa_inexistente'; EXIT decidir; END IF;

    -- A tentativa tem de ser a MAIS RECENTE do pedido (Codex P0-2: resposta atrasada de outra execução).
    IF EXISTS (SELECT 1 FROM public.pedidos_portal_tentativas x
                WHERE x.pedido_id = p_pedido_id AND x.id <> v_tent.id
                  AND x.concluido_em >= v_tent.concluido_em) THEN
      v_motivo := 'tentativa_nao_e_a_mais_recente'; EXIT decidir;
    END IF;

    IF NOT (v_tent.evidence -> 'efetivarAttempted' = 'false'::jsonb
            AND v_tent.evidence ->> 'erroTipo' = 'GRUPO_LEADTIME_MISMATCH'
            AND v_tent.evidence ->> 'statusFinal' = 'erro_nao_retentavel') IS TRUE THEN
      v_motivo := 'tentativa_sem_prova_de_recusa'; EXIT decidir;
    END IF;

    v_g := v_tent.evidence -> 'grupoLeadtime';
    -- A prova da tentativa tem de ser a MESMA que está no pedido (mesma execução).
    IF v_g IS NULL OR jsonb_typeof(v_g) <> 'object'
       OR (v_ped.portal_resposta -> 'evidence' -> 'grupoLeadtime') IS DISTINCT FROM v_g THEN
      v_motivo := 'prova_ausente_ou_divergente'; EXIT decidir;
    END IF;

    -- Grade inteira lida (nenhuma linha pulada por Prz Ent ilegível).
    IF NOT (jsonb_typeof(v_g -> 'linhas_total') = 'number'
            AND (v_g ->> 'linhas_total') ~ '^[0-9]+$'
            AND (v_g ->> 'linhas_total')::int > 0
            AND v_g -> 'linhas_validadas' = v_g -> 'linhas_total'
            AND jsonb_typeof(v_g -> 'mismatches') = 'array'
            AND jsonb_array_length(v_g -> 'mismatches') > 0) IS TRUE THEN
      v_motivo := 'grade_incompleta'; EXIT decidir;
    END IF;

    -- LT do grupo do pedido, AO VIVO, tem de ser o que o portal comparou.
    SELECT g.lt_producao_dias INTO v_lt_pedido
      FROM public.fornecedor_grupo_producao g
     WHERE g.empresa = v_ped.empresa AND g.fornecedor_nome = v_ped.fornecedor_nome
       AND g.grupo_codigo = v_ped.grupo_codigo
       AND COALESCE(g.lt_producao_unidade, 'uteis') = 'uteis';
    IF v_lt_pedido IS NULL OR (v_g ->> 'lt_esperado') IS DISTINCT FROM v_lt_pedido::text THEN
      v_motivo := 'lt_do_grupo_mudou'; EXIT decidir;
    END IF;

    FOR v_m IN SELECT e FROM jsonb_array_elements(v_g -> 'mismatches') AS t(e) LOOP
      IF NOT (v_m -> 'sku_identificado' = 'true'::jsonb
              AND v_m -> 'prz_ent_exato' = 'true'::jsonb
              AND (v_m ->> 'prz_ent') ~ '^[0-9]{1,3}$'
              AND (v_m ->> 'lt_esperado') = v_lt_pedido::text) IS TRUE THEN
        v_motivo := 'mismatch_sem_identidade_ou_prz_inexato'; EXIT decidir;
      END IF;
      v_key := upper(btrim(v_m ->> 'sku_portal'));
      v_prz := (v_m ->> 'prz_ent')::int;
      IF v_key = '' OR v_prz = v_lt_pedido THEN
        v_motivo := 'mismatch_invalido'; EXIT decidir;
      END IF;

      -- SKU do portal → exatamente 1 item do pedido (sku selado na aprovação; sem selo, de-para ativo exato).
      SELECT count(*), min(i.sku_codigo_omie) INTO v_n, v_sku
        FROM public.pedido_compra_item i
       WHERE i.pedido_id = p_pedido_id
         AND (upper(btrim(i.sku_portal_aprovado)) = v_key
              OR (NULLIF(btrim(i.sku_portal_aprovado), '') IS NULL
                  AND EXISTS (SELECT 1 FROM public.sku_fornecedor_externo e
                               WHERE e.empresa = v_ped.empresa AND e.fornecedor_nome = v_ped.fornecedor_nome
                                 AND e.sku_omie = i.sku_codigo_omie AND e.ativo
                                 AND upper(btrim(e.sku_portal)) = v_key)));
      IF v_n <> 1 THEN v_motivo := 'sku_portal_nao_casa_1_item'; EXIT decidir; END IF;

      IF v_planos @> jsonb_build_array(jsonb_build_object('sku', v_sku)) THEN
        v_motivo := 'sku_repetido'; EXIT decidir;
      END IF;

      -- Membro de equivalência ativa → revisão humana da família (o motor usa o grupo da âncora).
      IF EXISTS (SELECT 1 FROM public.sku_embalagem_equivalencia q
                  WHERE q.empresa = v_ped.empresa AND q.sku_codigo_omie = v_sku AND q.ativo
                    AND (q.vigente_ate IS NULL OR q.vigente_ate >= current_date)) THEN
        v_motivo := 'sku_em_grupo_de_equivalencia'; EXIT decidir;
      END IF;

      -- Prz Ent → exatamente 1 grupo do mesmo fornecedor.
      SELECT count(*), min(g.grupo_codigo) INTO v_n, v_destino
        FROM public.fornecedor_grupo_producao g
       WHERE g.empresa = v_ped.empresa AND g.fornecedor_nome = v_ped.fornecedor_nome
         AND g.lt_producao_dias = v_prz
         AND COALESCE(g.lt_producao_unidade, 'uteis') = 'uteis';
      IF v_n <> 1 THEN v_motivo := 'prz_ent_nao_casa_1_grupo'; EXIT decidir; END IF;

      SELECT s.grupo_codigo INTO v_atual
        FROM public.sku_grupo_producao s
       WHERE s.empresa = v_ped.empresa AND s.sku_codigo_omie = v_sku
       FOR UPDATE;
      IF NOT FOUND THEN v_motivo := 'sku_sem_grupo_cadastrado'; EXIT decidir; END IF;

      IF v_atual = v_ped.grupo_codigo THEN
        v_planos := v_planos || jsonb_build_array(jsonb_build_object(
          'sku', v_sku, 'sku_portal', v_m ->> 'sku_portal', 'de', v_atual, 'para', v_destino,
          'prz', v_prz, 'acao', 'regrupado'));
      ELSIF v_atual = v_destino THEN
        v_planos := v_planos || jsonb_build_array(jsonb_build_object(
          'sku', v_sku, 'sku_portal', v_m ->> 'sku_portal', 'de', v_ped.grupo_codigo, 'para', v_destino,
          'prz', v_prz, 'acao', 'ja_corrigido'));
      ELSE
        v_motivo := 'grupo_atual_inesperado'; EXIT decidir;
      END IF;
    END LOOP;
  END decidir;

  IF v_motivo IS NOT NULL THEN
    INSERT INTO public.reposicao_regrupo_audit (pedido_id, tentativa_id, resultado, motivo)
    VALUES (p_pedido_id, p_tentativa_id, 'recusado', v_motivo);
    RETURN jsonb_build_object('cancelado', false, 'motivo', v_motivo);
  END IF;

  -- Tudo provado: aplica (all-or-nothing — qualquer exceção abaixo desfaz o cadastro também).
  FOR v_p IN SELECT e FROM jsonb_array_elements(v_planos) AS t(e) LOOP
    IF v_p ->> 'acao' = 'regrupado' THEN
      UPDATE public.sku_grupo_producao
         SET grupo_codigo = v_p ->> 'para', atualizado_em = now(), atualizado_por = 'sistema:prz_ent_portal'
       WHERE empresa = v_ped.empresa AND sku_codigo_omie = v_p ->> 'sku' AND grupo_codigo = v_p ->> 'de';
      IF NOT FOUND THEN
        RAISE EXCEPTION '[REGRUPO] cadastro de % mudou sob o lock', v_p ->> 'sku' USING ERRCODE = '40001';
      END IF;
      v_movidos := v_movidos + 1;
    END IF;
    INSERT INTO public.reposicao_regrupo_audit
      (pedido_id, tentativa_id, resultado, sku_codigo_omie, sku_portal, grupo_de, grupo_para, prz_ent, lt_esperado)
    VALUES (p_pedido_id, p_tentativa_id, v_p ->> 'acao', v_p ->> 'sku', v_p ->> 'sku_portal',
            v_p ->> 'de', v_p ->> 'para', (v_p ->> 'prz')::int, v_lt_pedido);
  END LOOP;

  UPDATE public.pedido_compra_sugerido
     SET status = 'cancelado',
         cancelado_por = 'sistema:regrupo_portal',
         cancelado_em = now(),
         justificativa_cancelamento =
           'Cancelado automaticamente: o portal Sayerlack recusou por grupo errado (Prz Ent ≠ lead time do grupo), '
           || 'sem clique no Efetivar. Grupo do(s) SKU(s) corrigido pelo Prz Ent do portal; os itens voltam pelo '
           || 'próximo ciclo para nova aprovação. Motivo do portal: '
           || COALESCE(NULLIF(btrim(portal_erro), ''), '(não registrado)'),
         status_envio_portal = 'nao_aplicavel',
         portal_proximo_retry_em = NULL,
         atualizado_em = now()
   WHERE id = p_pedido_id
     AND status = 'aprovado_aguardando_disparo'
     AND status_envio_portal = 'erro_nao_retentavel'
     AND disparo_claim_em IS NULL
  RETURNING id INTO v_cancelou;
  IF v_cancelou IS NULL THEN
    RAISE EXCEPTION '[REGRUPO] pedido % mudou sob o lock', p_pedido_id USING ERRCODE = '40001';
  END IF;

  SELECT string_agg(format('%s (%s): %s → %s%s', p ->> 'sku_portal', p ->> 'sku', p ->> 'de', p ->> 'para',
                           CASE WHEN p ->> 'acao' = 'ja_corrigido' THEN ' [já estava corrigido]' ELSE '' END), '; ')
    INTO v_lista
    FROM jsonb_array_elements(v_planos) AS t(p);

  INSERT INTO public.fornecedor_alerta (empresa, fornecedor_nome, tipo, severidade, titulo, mensagem, status, metadata)
  VALUES (v_ped.empresa, v_ped.fornecedor_nome, 'outro', 'atencao',
          format('Pedido #%s cancelado: SKU no grupo errado (corrigido)', p_pedido_id),
          format('O portal Sayerlack recusou o pedido #%s (nada foi colocado no portal). Grupo corrigido pelo Prz Ent: %s. '
                 || 'O próximo ciclo do motor regera os itens no grupo certo para a sua aprovação. '
                 || 'Ponto de pedido e máximo são recalculados na madrugada: um pedido regerado hoje ainda usa a quantidade do prazo antigo.',
                 p_pedido_id, v_lista),
          'pendente_notificacao',
          jsonb_build_object('pedido_id', p_pedido_id, 'tentativa_id', p_tentativa_id,
                             'erro_tipo', 'GRUPO_LEADTIME_MISMATCH', 'origem', 'reposicao_regrupar_por_recusa_portal',
                             'regrupo', v_planos));

  RETURN jsonb_build_object('cancelado', true, 'movidos', v_movidos, 'itens', v_planos);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.reposicao_regrupar_por_recusa_portal(bigint, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reposicao_regrupar_por_recusa_portal(bigint, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.reposicao_regrupar_por_recusa_portal(bigint, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.reposicao_regrupar_por_recusa_portal(bigint, uuid) TO service_role;

COMMENT ON FUNCTION public.reposicao_regrupar_por_recusa_portal(bigint, uuid) IS
  'Regrupo Sayerlack v1: corrige sku_grupo_producao pelo Prz Ent do portal e cancela o pedido recusado (fail-closed; sem herança de aprovação). Só service_role (edge enviar-pedido-portal-sayerlack).';

-- (3) Postcondição ------------------------------------------------------------------------------
DO $post$
DECLARE v_r jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public' AND c.relname = 'reposicao_regrupo_audit' AND c.relrowsecurity) THEN
    RAISE EXCEPTION 'A1 FALHOU: reposicao_regrupo_audit ausente ou SEM RLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                  WHERE n.nspname = 'public' AND p.proname = 'reposicao_regrupar_por_recusa_portal' AND p.prosecdef) THEN
    RAISE EXCEPTION 'A2 FALHOU: reposicao_regrupar_por_recusa_portal ausente ou não é SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', 'public.reposicao_regrupar_por_recusa_portal(bigint, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.reposicao_regrupar_por_recusa_portal(bigint, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon/authenticated podem executar o regrupo (cancela pedido e muda cadastro)';
  END IF;
  -- Execução (late-binding): pedido inexistente devolve o motivo sem escrever nada.
  v_r := public.reposicao_regrupar_por_recusa_portal(-1, gen_random_uuid());
  IF v_r ->> 'motivo' IS DISTINCT FROM 'pedido_inexistente' THEN
    RAISE EXCEPTION 'A4 FALHOU: execução de prova devolveu %', v_r;
  END IF;
  RAISE NOTICE 'regrupo por recusa do portal: tabela+RLS, função DEFINER fechada, execução ok';
END
$post$;
