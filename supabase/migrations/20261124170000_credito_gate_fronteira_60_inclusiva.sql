-- Crédito: a régua do piso passa a ser vencido >= 60 dias (era > 60), alinhada ao alerta da ficha
-- (onda B da tela de Clientes, PR #4149: `data_vencimento <= hoje_SP - 60`). Decisão do Lucas em
-- 2026-11-24: "Banco bloqueia >= 60". Antes, no 60º dia de atraso a ficha avisava e o pedido passava.
--
-- Escopo: SÓ o operador da fronteira (`data_vencimento < v_corte` -> `<= v_corte`) nas 3 funções que
-- leem o mesmo corte; nada mais muda (corpos = pg_get_functiondef da PROD de 2026-11-24, verbatim).
--   * public.venda_gate_credito_grupo  — o piso que a edge omie-vendas-sync chama (5 comparações)
--   * private.credito_avaliar_reservar — o PR 2 (limite/reserva) que relê o piso (3 comparações)
--   * public.venda_gate_credito        — a v1 por par, sem chamador; alinhada para não divergir (1)
-- CREATE OR REPLACE preserva o ACL (não é DROP+CREATE); a pós-condição confere isso.
-- Guarda: aborta se o corpo de prod não for o do pré-flight (md5 do prosrc) — drift repo x prod.
-- Sem BEGIN/COMMIT: a transação é do `bun run db:aplicar`.
-- Prova: db/test-credito-gate-fronteira-60.sh (PG17, com falsificação).

DO $guarda$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.venda_gate_credito_grupo(uuid,text,bigint)', '8db94e6f6455a3984fb10572035125b7'),
      ('public.venda_gate_credito(text,bigint,uuid)', '01b7e72d69479d3a5dce26a6cfc718e6'),
      ('private.credito_avaliar_reservar(uuid,text,bigint,text,numeric,integer,text,uuid)', '1e39aab4f8e4448416720b3c3fe73ccd')
    ) AS v(fn, md5_esperado) LOOP
    IF to_regprocedure(r.fn) IS NULL THEN
      RAISE EXCEPTION 'GUARDA fronteira-60: % não existe', r.fn;
    END IF;
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure(r.fn)) <> r.md5_esperado THEN
      RAISE EXCEPTION 'GUARDA fronteira-60: corpo de % diverge do pre-flight (drift: refazer)', r.fn;
    END IF;
  END LOOP;
END
$guarda$;

CREATE TEMP TABLE _acl_antes ON COMMIT DROP AS
  SELECT oid, proacl::text AS acl FROM pg_proc
   WHERE oid IN (to_regprocedure('public.venda_gate_credito_grupo(uuid,text,bigint)'),
                 to_regprocedure('public.venda_gate_credito(text,bigint,uuid)'),
                 to_regprocedure('private.credito_avaliar_reservar(uuid,text,bigint,text,numeric,integer,text,uuid)'));

CREATE OR REPLACE FUNCTION public.venda_gate_credito_grupo(p_sales_order_id uuid, p_company text, p_codigo bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_corte date;
  v_grupo_resolvido boolean;
  v_vencido numeric;
  v_titulos integer;
  v_comprovados integer;
  v_indet integer;
  v_mais_antigo date;
  v_pares jsonb;
  v_excecao_id uuid;
  v_excecao_criada timestamptz;
  v_outros_com_divida boolean;
  v_virada timestamptz;
  v_virada_parcial timestamptz;
  v_motivo text;
BEGIN
  -- Corte em data civil de São Paulo (não UTC da sessão).
  v_corte := ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 60);

  -- Sem par comprovado não há raiz → nada a avaliar (a edge segura a EDIÇÃO nesse caso).
  IF p_company IS NULL OR p_codigo IS NULL OR p_codigo <= 0 THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', null, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'pares', '[]'::jsonb, 'grupo_resolvido', false,
                              'valor_indeterminado', false, 'titulos_indeterminados', 0, 'titulos_comprovados', 0,
                              'motivo', 'sem_codigo');
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.omie_customer_account_map m
                  WHERE m.account = p_company AND m.omie_codigo_cliente = p_codigo)
    INTO v_grupo_resolvido;

  -- Escopo = par do pedido ∪ pares do grupo de CADA dono do par (UNION deduplica → título conta 1 vez).
  -- Vocabulário = OPEN_TITLE_STATUSES (src/lib/financeiro/titulo-status.ts) + 'PAGTO PARCIAL'.
  WITH raizes AS (
    SELECT DISTINCT m.user_id
      FROM public.omie_customer_account_map m
     WHERE m.account = p_company AND m.omie_codigo_cliente = p_codigo
  ),
  escopo AS (
    SELECT p_company AS company, p_codigo AS codigo
    UNION
    SELECT g.company, g.omie_codigo_cliente
      FROM raizes r, LATERAL public.credito_grupo_pares(r.user_id) g
  ),
  tit AS (
    SELECT e.company, e.codigo, f.saldo, f.data_vencimento,
           -- vencido > 60 d com resíduo comprovado (PAGTO PARCIAL incluído: o status prova resíduo).
           -- COALESCE: saldo/vencimento NULL dão NULL (não false) — NULL some de FILTER e de bool_and.
           -- PAGTO PARCIAL vencido é comprovado QUALQUER que seja o saldo espelhado (0/NULL contradiz o
           -- status, não o desmente — Codex diff P1-2).
           COALESCE(f.data_vencimento <= v_corte
                    AND (f.saldo > 0 OR f.status_titulo = 'PAGTO PARCIAL'), false) AS comprovado,
           -- valor do vencido > 60 d conhecido: só saldo > 0, vencido, fora de PAGTO PARCIAL
           COALESCE(f.saldo > 0 AND f.data_vencimento <= v_corte
            AND f.status_titulo <> 'PAGTO PARCIAL', false) AS valor_conhecido
      FROM escopo e
      JOIN public.fin_contas_receber f
        ON f.company = e.company AND f.omie_codigo_cliente = e.codigo
     WHERE f.status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE', 'ABERTO', 'VENCIDO', 'PARCIAL', 'PAGTO PARCIAL')
       AND (
             (f.saldo > 0 AND f.data_vencimento <= v_corte)                                  -- comprovado
          OR (f.saldo IS NULL AND (f.data_vencimento IS NULL OR f.data_vencimento <= v_corte)) -- saldo ausente
          OR (f.saldo > 0 AND f.data_vencimento IS NULL)                                   -- vencimento ausente
          OR (f.status_titulo = 'PAGTO PARCIAL'
              AND (f.data_vencimento IS NULL OR f.data_vencimento <= v_corte))              -- parcial, qualquer saldo
           )
  ),
  por_par AS (
    SELECT t.company, t.codigo,
           CASE WHEN bool_and(t.valor_conhecido) THEN sum(t.saldo) END AS vencido,
           count(*) AS titulos,
           count(*) FILTER (WHERE t.comprovado) AS comprovados,
           count(*) FILTER (WHERE NOT t.valor_conhecido) AS indeterminados,
           min(t.data_vencimento) AS mais_antigo
      FROM tit t
     GROUP BY t.company, t.codigo
  )
  SELECT CASE WHEN bool_and(pp.vencido IS NOT NULL) THEN sum(pp.vencido) END,
         COALESCE(sum(pp.titulos), 0)::integer,
         COALESCE(sum(pp.comprovados), 0)::integer,
         COALESCE(sum(pp.indeterminados), 0)::integer,
         min(pp.mais_antigo),
         COALESCE(
           jsonb_agg(jsonb_build_object('company', pp.company, 'codigo', pp.codigo,
                                        'vencido', pp.vencido, 'titulos', pp.titulos,
                                        'valor_indeterminado', pp.vencido IS NULL,
                                        'vencimento_mais_antigo', pp.mais_antigo)
                     ORDER BY pp.company, pp.codigo),
           '[]'::jsonb)
    INTO v_vencido, v_titulos, v_comprovados, v_indet, v_mais_antigo, v_pares
    FROM por_par pp;

  IF v_titulos = 0 THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', 0, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'pares', '[]'::jsonb, 'grupo_resolvido', v_grupo_resolvido,
                              'valor_indeterminado', false, 'titulos_indeterminados', 0, 'titulos_comprovados', 0,
                              'motivo', 'sem_vencido_60d');
  END IF;

  -- Vencido comprovado prevalece sobre indeterminado no motivo; os dois SEGURAM.
  v_motivo := CASE WHEN v_comprovados > 0 THEN 'vencido_60d_sem_excecao' ELSE 'piso_indeterminado' END;

  -- Exceção aprovada PARA ESTE PEDIDO **E O PAR DO PEDIDO**, dentro da validade.
  SELECT x.id, x.created_at INTO v_excecao_id, v_excecao_criada
    FROM public.venda_excecao_credito x
   WHERE x.sales_order_id = p_sales_order_id
     AND x.company = p_company
     AND x.omie_codigo_cliente = p_codigo
     AND x.valido_ate > now()
   ORDER BY x.created_at DESC
   LIMIT 1;

  -- Exceção antiga + dívida (comprovada OU indeterminada) em OUTRO par → não cobre (o gestor não a viu).
  -- Todo par em v_pares tem título que segura; contar presença, não somar valor (que pode ser null).
  SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(v_pares) e
                  WHERE NOT (e->>'company' = p_company AND (e->>'codigo')::bigint = p_codigo))
    INTO v_outros_com_divida;
  SELECT aplicada_em INTO v_virada FROM public.credito_virada_grupo;
  -- Sem marco (linha apagada) → trata TODA exceção como antiga (lado seguro: não cobre o grupo).
  IF v_excecao_id IS NOT NULL AND (v_virada IS NULL OR v_excecao_criada < v_virada) AND v_outros_com_divida THEN
    RETURN jsonb_build_object(
      'bloqueado', true, 'vencido', v_vencido, 'titulos', v_titulos,
      'vencimento_mais_antigo', v_mais_antigo, 'excecao_id', null,
      'pares', v_pares, 'grupo_resolvido', v_grupo_resolvido,
      'valor_indeterminado', v_vencido IS NULL, 'titulos_indeterminados', v_indet,
      'titulos_comprovados', v_comprovados,
      'motivo', 'excecao_anterior_nao_cobre_grupo');
  END IF;

  -- Título que a regra anterior OMITIA (PAGTO PARCIAL / saldo ou vencimento ausente), em qualquer par:
  -- a exceção só o cobre se o gestor aprovou DEPOIS de um bloqueio já avaliado pelo piso novo — log de
  -- bloqueio do (pedido, empresa) entre a virada e a aprovação. Aprovar lendo o log ANTIGO (que não
  -- listava o parcial) não cobre (Codex diff P1-1). Exceção anterior à virada nunca tem esse log.
  -- Sem marco → nada cobre o indeterminado (lado seguro).
  SELECT aplicada_em INTO v_virada_parcial FROM public.credito_virada_piso_parcial;
  IF v_excecao_id IS NOT NULL AND v_indet > 0
     AND (v_virada_parcial IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.venda_bloqueio_credito_log l
                          WHERE l.sales_order_id = p_sales_order_id
                            AND l.company = p_company
                            AND l.acao IN ('bloqueado', 'bloqueado_edicao')
                            -- +5 min: um bloqueio decidido pelo piso ANTIGO e gravado logo após o
                            -- commit desta migration (corrida do deploy) não conta (Codex delta P1-2)
                            AND l.created_at >= v_virada_parcial + interval '5 minutes'
                            AND l.created_at <= v_excecao_criada)) THEN
    RETURN jsonb_build_object(
      'bloqueado', true, 'vencido', v_vencido, 'titulos', v_titulos,
      'vencimento_mais_antigo', v_mais_antigo, 'excecao_id', null,
      'pares', v_pares, 'grupo_resolvido', v_grupo_resolvido,
      'valor_indeterminado', v_vencido IS NULL, 'titulos_indeterminados', v_indet,
      'titulos_comprovados', v_comprovados,
      'motivo', 'excecao_anterior_nao_cobre_parcial');
  END IF;

  RETURN jsonb_build_object(
    'bloqueado', v_excecao_id IS NULL,
    'vencido', v_vencido,
    'titulos', v_titulos,
    'vencimento_mais_antigo', v_mais_antigo,
    'excecao_id', v_excecao_id,
    'pares', v_pares,
    'grupo_resolvido', v_grupo_resolvido,
    'valor_indeterminado', v_vencido IS NULL,
    'titulos_indeterminados', v_indet,
    'titulos_comprovados', v_comprovados,
    'motivo', CASE WHEN v_excecao_id IS NULL THEN v_motivo ELSE 'excecao_valida' END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION private.credito_avaliar_reservar(p_sales_order_id uuid, p_company text, p_codigo bigint, p_revisao text, p_valor numeric, p_prazo_dias integer, p_modo text, p_solicitante uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_corte date := ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 60);
  v_piso jsonb;
  v_raiz jsonb;
  v_root uuid;
  v_assin text;
  v_lim public.credito_limite%ROWTYPE;
  v_tem_lim boolean := false;
  v_res public.credito_reserva%ROWTYPE;
  v_tem_res boolean := false;
  v_dec_res public.credito_decisao_pedido%ROWTYPE;
  v_lastro_limite boolean := false;  -- a reserva ativa veio do limite VIGENTE deste grupo
  v_lastro_aut boolean := false;     -- … ou de autorização ainda válida DESTA revisão
  v_reusa boolean := false;
  v_base numeric := 0;               -- quanto da reserva ativa já está aprovado pelo limite
  v_aut_id uuid;
  v_titulos numeric;
  v_indet integer;
  v_piso_indet integer;
  v_venc60 integer;
  v_venc60_fora_piso integer;
  v_reservas numeric;
  v_faixa text;
  v_motivo text;
  v_dec_id uuid := gen_random_uuid();
  v_res_id uuid;
  v_sol_id uuid;
BEGIN
  IF p_sales_order_id IS NULL OR p_company IS NULL OR p_revisao IS NULL OR btrim(p_revisao) = '' THEN
    RAISE EXCEPTION 'credito_avaliar_reservar: pedido, empresa e revisão são obrigatórios' USING ERRCODE = '22023';
  END IF;
  IF p_company NOT IN ('oben','colacor','colacor_sc') THEN
    RAISE EXCEPTION 'credito_avaliar_reservar: empresa inválida %', p_company USING ERRCODE = '22023';
  END IF;
  IF p_modo IS NULL OR p_modo NOT IN ('sombra','efetivo') THEN
    RAISE EXCEPTION 'credito_avaliar_reservar: modo sombra|efetivo obrigatório' USING ERRCODE = '22023';
  END IF;
  -- NaN/Infinity ordenam acima de tudo em numeric: o teto barra os dois (Codex diff P1-7)
  IF p_valor IS NULL OR p_valor <= 0 OR p_valor >= 1e12 THEN
    RAISE EXCEPTION 'credito_avaliar_reservar: valor do pedido ausente, não positivo ou não finito' USING ERRCODE = '22023';
  END IF;
  -- O lock só serializa se cada comando vê o commit do anterior (snapshot por comando).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'credito_avaliar_reservar: exige READ COMMITTED (veio %)',
      current_setting('transaction_isolation') USING ERRCODE = '25000';
  END IF;

  -- 1) raiz → lock da fila do grupo → TUDO o mais é lido depois do lock (Codex diff P1-2)
  v_raiz := public.credito_grupo_raiz(p_company, p_codigo);
  v_root := (v_raiz ->> 'raiz')::uuid;
  IF v_root IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('credito_grupo:' || v_root::text, 0));
    -- a composição pode ter mudado enquanto esperávamos: relê a raiz SOB o lock
    IF (public.credito_grupo_raiz(p_company, p_codigo) ->> 'raiz')::uuid IS DISTINCT FROM v_root THEN
      v_faixa := 'amarelo'; v_motivo := 'grupo_mudou';
    END IF;
    v_assin := public.credito_grupo_assinatura(v_root);
  END IF;

  -- piso do PR 1 (falha propaga: o chamador segura — fail-closed)
  v_piso := public.venda_gate_credito_grupo(p_sales_order_id, p_company, p_codigo);

  -- títulos abertos do par do pedido ∪ pares do grupo, deduplicados — mesmo SEM raiz.
  -- Vocabulário = OPEN_TITLE_STATUSES + 'PAGTO PARCIAL' (existe em prod e está aberto; o saldo
  -- dele é o valor cheio porque valor_recebido não é preenchido → superestima = lado seguro).
  WITH escopo AS (
    SELECT p_company AS company, p_codigo AS codigo
    UNION
    SELECT g.company, g.omie_codigo_cliente FROM public.credito_grupo_pares(v_root) g WHERE v_root IS NOT NULL
  )
  SELECT COALESCE(sum(f.saldo) FILTER (WHERE f.saldo > 0), 0),
         count(*) FILTER (WHERE f.saldo IS NULL),
         -- dívida possivelmente > 60 d que ninguém consegue medir (ausente ≠ zero)
         count(*) FILTER (WHERE (f.saldo IS NULL OR f.data_vencimento IS NULL)
                            AND (f.data_vencimento IS NULL OR f.data_vencimento <= v_corte)),
         -- 20261121200000: PAGTO PARCIAL vencido conta com QUALQUER saldo espelhado (Codex delta P1-1)
         count(*) FILTER (WHERE (f.saldo > 0 OR f.status_titulo = 'PAGTO PARCIAL') AND f.data_vencimento <= v_corte),
         -- vencido > 60 d comprovado num status que o piso do PR 1 não lê
         count(*) FILTER (WHERE (f.saldo > 0 OR f.status_titulo = 'PAGTO PARCIAL') AND f.data_vencimento <= v_corte
                            AND f.status_titulo NOT IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL'))
    INTO v_titulos, v_indet, v_piso_indet, v_venc60, v_venc60_fora_piso
    FROM escopo e
    JOIN public.fin_contas_receber f ON f.company = e.company AND f.omie_codigo_cliente = e.codigo
   WHERE e.codigo IS NOT NULL
     AND f.status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE','ABERTO','VENCIDO','PARCIAL','PAGTO PARCIAL');

  IF ((v_piso ->> 'bloqueado')::boolean
       -- 20261121200000: piso que segura SÓ por título indeterminado não é vencido comprovado → amarelo
       -- abaixo; piso sem a chave (versão anterior) só segurava por vencido comprovado.
       AND COALESCE((v_piso ->> 'titulos_comprovados')::integer, 1) > 0)
     OR v_venc60_fora_piso > 0                                       -- a exceção do piso não viu isto
     OR (v_venc60 > 0 AND v_piso ->> 'motivo' <> 'excecao_valida')  -- piso lido antes de o título chegar
  THEN
    v_faixa := 'vermelho'; v_motivo := 'piso_vencido_60d';
  ELSIF v_piso_indet > 0
        OR (v_piso ->> 'bloqueado')::boolean  -- piso indeterminado que a releitura não viu: nunca libera
  THEN
    -- antes de QUALQUER liberação: nem reserva antiga nem autorização pulam isto
    v_faixa := 'amarelo'; v_motivo := 'piso_indeterminado';
  ELSIF v_root IS NULL THEN
    v_faixa := 'amarelo'; v_motivo := v_raiz ->> 'motivo';
  ELSIF v_motivo IS NOT NULL THEN
    NULL;  -- grupo_mudou sob o lock
  ELSE
    -- reservas ativas de OUTROS pedidos no MESMO modo: pelo PAR atual do grupo OU pela raiz que as
    -- gravou (troca de código Omie não pode sumir com a reserva — Codex diff P1-4)
    WITH escopo AS (
      SELECT p_company AS company, p_codigo AS codigo
      UNION
      SELECT g.company, g.omie_codigo_cliente FROM public.credito_grupo_pares(v_root) g
    )
    SELECT COALESCE(sum(r.valor_brl), 0) INTO v_reservas
      FROM public.credito_reserva r
     WHERE r.status = 'ativa' AND r.modo = p_modo
       AND (r.grupo_user_id = v_root
            OR EXISTS (SELECT 1 FROM escopo e WHERE e.company = r.company AND e.codigo = r.omie_codigo_cliente))
       AND NOT (r.sales_order_id = p_sales_order_id AND r.company = p_company);

    SELECT * INTO v_res FROM public.credito_reserva r
     WHERE r.sales_order_id = p_sales_order_id AND r.company = p_company
       AND r.modo = p_modo AND r.status = 'ativa';
    v_tem_res := FOUND;
    SELECT * INTO v_lim FROM public.credito_limite l WHERE l.grupo_user_id = v_root;
    v_tem_lim := FOUND;

    -- revisão já encerrada/superada não volta a reservar — salvo se ELA é a ativa (Codex diff P1-6)
    IF NOT (v_tem_res AND v_res.revisao = p_revisao)
       AND EXISTS (SELECT 1 FROM public.credito_reserva r
                    WHERE r.sales_order_id = p_sales_order_id AND r.company = p_company
                      AND r.modo = p_modo AND r.revisao = p_revisao AND r.status <> 'ativa') THEN
      RAISE EXCEPTION 'credito_avaliar_reservar: revisao_encerrada (% já foi substituída ou encerrada)', p_revisao
        USING ERRCODE = 'P0001';
    END IF;

    -- lastro da reserva ativa (Codex diff P1-5): do limite só se for o VIGENTE e do mesmo grupo;
    -- de autorização só para a MESMA revisão e enquanto vale. Só o lastro de limite vira "base".
    IF v_tem_res THEN
      SELECT * INTO v_dec_res FROM public.credito_decisao_pedido d WHERE d.id = v_res.decisao_id;
      v_lastro_limite := v_dec_res.motivo = 'dentro_limite' AND v_tem_lim
                         AND v_dec_res.limite_versao = v_lim.versao AND v_dec_res.grupo_user_id = v_root;
      v_lastro_aut := v_dec_res.motivo = 'autorizado' AND v_res.revisao = p_revisao
                      AND EXISTS (SELECT 1 FROM public.credito_autorizacao a
                                   WHERE a.id = v_dec_res.autorizacao_id AND a.valido_ate > now());
      v_reusa := v_res.revisao = p_revisao AND (v_lastro_limite OR v_lastro_aut);
      v_base := CASE WHEN v_lastro_limite THEN v_res.valor_brl ELSE 0 END;
    END IF;

    SELECT a.id INTO v_aut_id
      FROM public.credito_autorizacao a
      JOIN public.credito_solicitacao s ON s.id = a.solicitacao_id
     WHERE s.sales_order_id = p_sales_order_id AND s.company = p_company
       AND a.revisao = p_revisao AND a.autorizada AND a.valido_ate > now()
       AND p_valor <= a.valor_max_brl
       AND ((a.prazo_max_dias IS NULL AND p_prazo_dias IS NULL) OR p_prazo_dias <= a.prazo_max_dias)
     ORDER BY a.created_at DESC
     LIMIT 1;

    IF v_reusa THEN
      v_faixa := 'verde'; v_motivo := 'reserva_existente'; v_res_id := v_res.id;
    ELSIF v_aut_id IS NOT NULL THEN
      v_faixa := 'verde'; v_motivo := 'autorizado';
    ELSIF NOT v_tem_lim THEN
      v_faixa := 'amarelo'; v_motivo := 'sem_limite';
    ELSIF v_lim.grupo_assinatura IS DISTINCT FROM v_assin THEN
      v_faixa := 'amarelo'; v_motivo := 'grupo_mudou';
    ELSIF v_lim.ficha_calculada_em < now() - interval '14 days' THEN
      v_faixa := 'amarelo'; v_motivo := 'limite_desatualizado';
    ELSIF v_lim.risco IN ('alto','sem_evidencia') THEN
      v_faixa := 'amarelo'; v_motivo := 'risco_' || v_lim.risco;
    ELSIF p_prazo_dias IS NULL THEN
      v_faixa := 'amarelo'; v_motivo := 'prazo_ilegivel';
    ELSIF p_prazo_dias > v_lim.prazo_max_dias THEN
      v_faixa := 'amarelo'; v_motivo := 'prazo_acima';
    ELSIF v_indet > 0 THEN
      v_faixa := 'amarelo'; v_motivo := 'exposicao_indeterminada';
    ELSIF p_valor > v_base AND v_titulos + v_reservas + p_valor > v_lim.limite_brl THEN
      -- só o ACRÉSCIMO sobre o que o limite vigente já cobria é cobrado
      v_faixa := 'amarelo'; v_motivo := 'estoura_limite';
    ELSE
      v_faixa := 'verde'; v_motivo := 'dentro_limite';
    END IF;
  END IF;

  -- 3) decisão (append-only) — antes da reserva/solicitação, que a referenciam
  PERFORM public.credito_portao(v_dec_id::text);
  INSERT INTO public.credito_decisao_pedido (
    id, sales_order_id, company, omie_codigo_cliente, modo, grupo_user_id, grupo_assinatura, revisao,
    valor_brl, prazo_dias, faixa, motivo, exposicao_titulos_brl, exposicao_reservas_brl,
    reserva_anterior_brl, limite_brl, prazo_max_dias, limite_versao, autorizacao_id, piso, solicitante)
  VALUES (
    v_dec_id, p_sales_order_id, p_company, p_codigo, p_modo, v_root, v_assin, p_revisao,
    p_valor, p_prazo_dias, v_faixa, v_motivo, v_titulos, v_reservas,
    CASE WHEN v_tem_res THEN v_res.valor_brl END,
    CASE WHEN v_tem_lim THEN v_lim.limite_brl END, CASE WHEN v_tem_lim THEN v_lim.prazo_max_dias END,
    CASE WHEN v_tem_lim THEN v_lim.versao END,
    CASE WHEN v_motivo = 'autorizado' THEN v_aut_id END, v_piso, p_solicitante);

  -- 4) reserva no 🟢 (a anterior vira 'substituida'; a nova cobre o MAIOR dos dois — redução só
  --    solta depois que o Omie confirmar, PR 5/6)
  IF v_faixa = 'verde' AND v_motivo <> 'reserva_existente' THEN
    IF v_tem_res THEN
      PERFORM public.credito_portao(v_res.id::text);
      UPDATE public.credito_reserva
         SET status = 'substituida', encerrada_em = now(), motivo_encerramento = 'reavaliada na revisão ' || p_revisao
       WHERE id = v_res.id AND status = 'ativa';
    END IF;
    v_res_id := gen_random_uuid();
    PERFORM public.credito_portao(v_res_id::text);
    INSERT INTO public.credito_reserva (id, decisao_id, sales_order_id, company, omie_codigo_cliente,
                                        modo, grupo_user_id, revisao, valor_brl)
    VALUES (v_res_id, v_dec_id, p_sales_order_id, p_company, p_codigo, p_modo, v_root, p_revisao,
            greatest(p_valor, CASE WHEN v_tem_res THEN v_res.valor_brl ELSE 0 END));
  END IF;

  -- 5) 🟡 efetivo resolvível pelo aprovador → solicitação (1 aberta por pedido+empresa+revisão).
  --    Pendência cadastral não vai à fila: aprovar não a resolveria.
  IF v_faixa = 'amarelo' AND p_modo = 'efetivo'
     AND v_motivo NOT IN ('sem_grupo','grupo_conflito','piso_indeterminado','grupo_mudou') THEN
    SELECT s.id INTO v_sol_id FROM public.credito_solicitacao s
     WHERE s.sales_order_id = p_sales_order_id AND s.company = p_company
       AND s.revisao = p_revisao AND s.status = 'aberta';
    IF v_sol_id IS NULL THEN
      v_sol_id := gen_random_uuid();
      PERFORM public.credito_portao(v_sol_id::text);
      INSERT INTO public.credito_solicitacao (id, decisao_id, sales_order_id, company, revisao,
                                              valor_brl, prazo_dias, motivo)
      VALUES (v_sol_id, v_dec_id, p_sales_order_id, p_company, p_revisao, p_valor, p_prazo_dias, v_motivo);
    END IF;
  END IF;
  PERFORM public.credito_portao(NULL);

  RETURN jsonb_build_object(
    'faixa', v_faixa, 'motivo', v_motivo, 'decisao_id', v_dec_id, 'reserva_id', v_res_id,
    'solicitacao_id', v_sol_id, 'grupo_user_id', v_root, 'modo', p_modo,
    'pendencia_cadastral', v_motivo IN ('sem_grupo','grupo_conflito','piso_indeterminado','grupo_mudou'),
    'exposicao_titulos_brl', v_titulos, 'exposicao_reservas_brl', v_reservas,
    'limite_brl', CASE WHEN v_tem_lim THEN v_lim.limite_brl END,
    'prazo_max_dias', CASE WHEN v_tem_lim THEN v_lim.prazo_max_dias END,
    'piso', v_piso);
END;
$function$;

CREATE OR REPLACE FUNCTION public.venda_gate_credito(p_company text, p_codigo bigint, p_sales_order_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_corte date;
  v_vencido numeric;
  v_titulos integer;
  v_mais_antigo date;
  v_excecao_id uuid;
BEGIN
  -- Sem código não há evidência possível → não bloqueia (precisão > recall).
  IF p_codigo IS NULL OR p_codigo <= 0 OR p_company IS NULL THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', null, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'motivo', 'sem_codigo');
  END IF;

  -- Corte em data civil de São Paulo (não UTC da sessão) — P2 Codex.
  v_corte := ((now() AT TIME ZONE 'America/Sao_Paulo')::date - 60);

  -- Vocabulário de status espelha OPEN_TITLE_STATUSES de
  -- src/lib/financeiro/titulo-status.ts (paridade garantida por teste vitest).
  SELECT COALESCE(sum(saldo), 0), count(*), min(data_vencimento)
    INTO v_vencido, v_titulos, v_mais_antigo
    FROM public.fin_contas_receber
   WHERE company = p_company
     AND omie_codigo_cliente = p_codigo
     AND status_titulo IN ('A VENCER', 'ATRASADO', 'VENCE HOJE', 'ABERTO', 'VENCIDO', 'PARCIAL')
     AND saldo > 0
     AND data_vencimento <= v_corte;

  IF v_vencido <= 0 THEN
    RETURN jsonb_build_object('bloqueado', false, 'vencido', 0, 'titulos', 0,
                              'vencimento_mais_antigo', null, 'excecao_id', null,
                              'motivo', 'sem_vencido_60d');
  END IF;

  -- Exceção aprovada PARA ESTE PEDIDO **E ESTE PAR** (company + código), dentro
  -- da validade — exceção de um pedido não libera outro cliente/conta.
  SELECT id INTO v_excecao_id
    FROM public.venda_excecao_credito
   WHERE sales_order_id = p_sales_order_id
     AND company = p_company
     AND omie_codigo_cliente = p_codigo
     AND valido_ate > now()
   ORDER BY created_at DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'bloqueado', v_excecao_id IS NULL,
    'vencido', v_vencido,
    'titulos', v_titulos,
    'vencimento_mais_antigo', v_mais_antigo,
    'excecao_id', v_excecao_id,
    'motivo', CASE WHEN v_excecao_id IS NULL THEN 'vencido_60d_sem_excecao' ELSE 'excecao_valida' END
  );
END;
$function$;

-- Pós-condição: nenhuma comparação estrita sobrou, as inclusivas estão lá (5+1+3) e o ACL não mudou.
DO $pos$
DECLARE
  v_n integer;
BEGIN
  SELECT count(*) INTO v_n FROM pg_proc
   WHERE oid IN (SELECT oid FROM _acl_antes) AND prosrc LIKE '%data_vencimento < v_corte%';
  IF v_n <> 0 THEN RAISE EXCEPTION 'POSCONDICAO fronteira-60: sobrou comparação estrita em % função(ões)', v_n; END IF;
  SELECT sum((length(prosrc) - length(replace(prosrc, 'data_vencimento <= v_corte', ''))) / length('data_vencimento <= v_corte'))
    INTO v_n FROM pg_proc WHERE oid IN (SELECT oid FROM _acl_antes);
  IF v_n <> 9 THEN RAISE EXCEPTION 'POSCONDICAO fronteira-60: esperava 9 comparações inclusivas, achei %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM _acl_antes a JOIN pg_proc p ON p.oid = a.oid WHERE p.proacl::text IS DISTINCT FROM a.acl) THEN
    RAISE EXCEPTION 'POSCONDICAO fronteira-60: ACL mudou';
  END IF;
END
$pos$;
