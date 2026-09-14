-- ============================================================================================
-- pedido_total_liquido_acervo_mes_entre_contas — o gate de "mês completo" atravessa as contas
-- ============================================================================================
-- Corrige `20260914181500_pedido_total_liquido_acervo` antes do primeiro apply dela. Ela bloqueava
-- o conta×mês que tinha pedido sem apuração, mas deixava a OUTRA conta do mesmo mês converter. Os
-- comparadores que não filtram conta — `customer_metrics_mv` (faturamento_90d × prev_90d), o painel
-- de vendas (hoje × ontem), `v_grupo_comercial` — somam as duas, e oben líquido sobre colacor bruta
-- no mesmo mês é exatamente a base mista que o gate existe para impedir (o P1-3 da 2ª opinião
-- falava das DUAS contas nas DUAS janelas; a primeira versão só olhou uma).
--
-- Agora, com `p_exigir_mes_completo` (o default), um mês só converte quando NENHUMA conta do escopo
-- tem pedido `nao_apurado` ou `linha_invalida` nele. Converter uma conta sozinha continua possível,
-- como escolha explícita: `p_contas => ARRAY['oben']`. `meses_bloqueados` passa a listar todo
-- conta×mês de um mês bloqueado que tinha convertível, para mostrar QUEM bloqueia.
--
-- Só o conversor muda; a tabela de registro, o classificador e o relatório são os da migration
-- anterior, que tem de estar aplicada antes. O `db:aplicar` usa o gêmeo
-- db/aplicar-pedido-total-liquido-rpc.sql, que encadeia as duas. Prova:
-- db/test-pedido-total-liquido-acervo.sh.
-- ============================================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.pedido_total_liquido_converter(
  p_aplicar             boolean,
  p_corte               timestamptz,
  p_contas              text[]  DEFAULT NULL,
  p_mes_de              date    DEFAULT NULL,
  p_mes_ate             date    DEFAULT NULL,
  p_limite              integer DEFAULT 5000,
  p_exigir_mes_completo boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_mes_de         date := date_trunc('month', p_mes_de::timestamp)::date;
  v_mes_ate        date := date_trunc('month', p_mes_ate::timestamp)::date;
  v_lote           uuid := gen_random_uuid();
  v_escopo         jsonb;
  v_elegiveis      uuid[];
  v_n_elegiveis    integer;
  v_soma_prevista  numeric;
  v_por_mes        jsonb;
  v_bloqueados     jsonb;
  v_travados       uuid[];
  v_coerentes      uuid[] := '{}';
  v_incoerentes    uuid[] := '{}';
  v_id             uuid;
  v_n_alvo         integer;
  v_n_escritos     integer;
  v_n_registrados  integer;
  v_escritos       uuid[];
  v_soma_mudanca   numeric;
  v_escritos_mes   jsonb;
  v_ruins          integer;
BEGIN
  IF p_aplicar IS NULL OR p_exigir_mes_completo IS NULL THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: p_aplicar e p_exigir_mes_completo nao podem ser NULL'
      USING ERRCODE = '22023';
  END IF;
  IF p_corte IS NULL OR p_corte > now() THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: p_corte tem de ser um instante passado em que a v1.6 ainda servia (veio %)', p_corte
      USING ERRCODE = '22023';
  END IF;
  IF p_contas IS NOT NULL AND (cardinality(p_contas) = 0 OR NOT (p_contas <@ ARRAY['oben', 'colacor'])) THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: p_contas tem de ser NULL (todas) ou um subconjunto nao vazio de {oben, colacor} (veio %)', p_contas
      USING ERRCODE = '22023';
  END IF;
  IF v_mes_de IS NOT NULL AND v_mes_ate IS NOT NULL AND v_mes_de > v_mes_ate THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: p_mes_de (%) depois de p_mes_ate (%)', v_mes_de, v_mes_ate
      USING ERRCODE = '22023';
  END IF;
  -- NULL é recusado, não lido como "sem limite": `LIMIT NULL` no Postgres remove o limite.
  IF p_limite IS NULL OR p_limite < 1 OR p_limite > 50000 THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: p_limite fora de [1, 50000] (veio %)', p_limite
      USING ERRCODE = '22023';
  END IF;

  IF p_aplicar THEN
    IF NOT pg_try_advisory_xact_lock(hashtext('pedido_total_liquido_converter')) THEN
      RAISE EXCEPTION 'pedido_total_liquido_converter: outra conversao esta em curso'
        USING ERRCODE = '55P03';
    END IF;
  END IF;

  v_escopo := jsonb_build_object(
    'contas',              to_jsonb(p_contas),
    'mes_de',              to_char(v_mes_de, 'YYYY-MM'),
    'mes_ate',             to_char(v_mes_ate, 'YYYY-MM'),
    'exigir_mes_completo', p_exigir_mes_completo
  );

  WITH c AS MATERIALIZED (
    SELECT * FROM public.pedido_total_liquido_classificar(p_corte, NULL)
  ),
  mes_estado AS (
    SELECT c.account, c.mes,
           count(*) FILTER (WHERE c.classe = 'convertivel')    AS n_convertivel,
           count(*) FILTER (WHERE c.classe = 'nao_apurado')    AS n_nao_apurado,
           count(*) FILTER (WHERE c.classe = 'linha_invalida') AS n_linha_invalida
      FROM c
     GROUP BY c.account, c.mes
  ),
  no_escopo AS (
    SELECT m.*
      FROM mes_estado m
     WHERE (p_contas  IS NULL OR m.account = ANY (p_contas))
       AND (v_mes_de  IS NULL OR m.mes >= v_mes_de)
       AND (v_mes_ate IS NULL OR m.mes <= v_mes_ate)
  ),
  -- O mês fica incompleto se QUALQUER conta do escopo tiver pedido sem apuração nele: os
  -- comparadores que não filtram conta somam as duas, e oben líquido sobre colacor bruta é base
  -- mista do mesmo jeito. Converter uma conta sozinha é escolha explícita, pelo escopo.
  mes_bloqueado AS (
    SELECT m.mes
      FROM no_escopo m
     GROUP BY m.mes
    HAVING sum(m.n_nao_apurado + m.n_linha_invalida) > 0
  ),
  elegivel AS (
    SELECT c.*
      FROM c
      JOIN no_escopo m ON m.account = c.account AND m.mes = c.mes
     WHERE c.classe = 'convertivel'
       AND (NOT p_exigir_mes_completo OR c.mes NOT IN (SELECT b.mes FROM mes_bloqueado b))
  )
  SELECT (SELECT array_agg(e.sales_order_id ORDER BY e.sales_order_id) FROM elegivel e),
         (SELECT count(*) FROM elegivel),
         (SELECT sum(e.liquido - e.total) FROM elegivel e),
         (SELECT jsonb_agg(jsonb_build_object(
                   'conta', g.account, 'mes', to_char(g.mes, 'YYYY-MM'), 'pedidos', g.n,
                   'soma_total_atual', g.s_total, 'soma_liquido', g.s_liquido,
                   'soma_mudanca', g.s_liquido - g.s_total
                 ) ORDER BY g.account, g.mes DESC)
            FROM (SELECT e.account, e.mes, count(*) AS n, sum(e.total) AS s_total, sum(e.liquido) AS s_liquido
                    FROM elegivel e GROUP BY e.account, e.mes) g),
         -- Todo conta×mês de um mês bloqueado que tinha convertível no escopo: mostra QUEM bloqueia.
         (SELECT jsonb_agg(jsonb_build_object(
                   'conta', m.account, 'mes', to_char(m.mes, 'YYYY-MM'), 'convertivel', m.n_convertivel,
                   'nao_apurado', m.n_nao_apurado, 'linha_invalida', m.n_linha_invalida
                 ) ORDER BY m.mes DESC, m.account)
            FROM no_escopo m
           WHERE p_exigir_mes_completo
             AND m.mes IN (SELECT b.mes FROM mes_bloqueado b)
             AND m.mes IN (SELECT x.mes FROM no_escopo x WHERE x.n_convertivel > 0))
    INTO v_elegiveis, v_n_elegiveis, v_soma_prevista, v_por_mes, v_bloqueados;
  -- array_agg de nada é NULL — e NULL, para o classificador, quer dizer TODOS os pedidos.
  v_elegiveis := coalesce(v_elegiveis, '{}'::uuid[]);

  IF v_n_elegiveis > p_limite THEN
    IF p_aplicar THEN
      RAISE EXCEPTION 'pedido_total_liquido_converter: o escopo tem % convertiveis, acima do limite % — reduza o escopo ou suba o limite; nada foi gravado', v_n_elegiveis, p_limite
        USING ERRCODE = 'TL002';
    END IF;
    RETURN jsonb_build_object(
      'modo', 'ensaio', 'corte', p_corte, 'escopo', v_escopo, 'limite', p_limite,
      'excede_limite', true, 'elegiveis', v_n_elegiveis,
      'por_conta_mes', coalesce(v_por_mes, '[]'::jsonb),
      'meses_bloqueados', coalesce(v_bloqueados, '[]'::jsonb)
    );
  END IF;

  IF p_aplicar THEN
    -- SKIP LOCKED: pedido que um escritor está reescrevendo agora fica para a próxima rodada. Não
    -- esperar é o que impede deadlock com a ordem de lock dos escritores.
    SELECT array_agg(t.id ORDER BY t.id)
      INTO v_travados
      FROM (SELECT so.id
              FROM public.sales_orders so
             WHERE so.id = ANY (v_elegiveis)
             ORDER BY so.id
               FOR UPDATE SKIP LOCKED) t;
    v_travados := coalesce(v_travados, '{}'::uuid[]);
  ELSE
    v_travados := v_elegiveis;
  END IF;

  -- A mesma função que a trigger deferida roda no COMMIT: quem ela recusaria não entra no lote.
  FOREACH v_id IN ARRAY v_travados LOOP
    BEGIN
      PERFORM public.pedido_venda_exigir_coerencia(v_id);
      v_coerentes := v_coerentes || v_id;
    EXCEPTION WHEN check_violation THEN
      v_incoerentes := v_incoerentes || v_id;
    END;
  END LOOP;

  IF NOT p_aplicar THEN
    RETURN jsonb_build_object(
      'modo', 'ensaio', 'corte', p_corte, 'escopo', v_escopo, 'limite', p_limite,
      'excede_limite', false, 'elegiveis', v_n_elegiveis,
      'incoerentes', cardinality(v_incoerentes), 'amostra_incoerentes', to_jsonb(v_incoerentes[1:20]),
      -- Σ dos elegíveis, ANTES de pular os incoerentes; sobre nada elegível, a mudança é 0 de fato.
      'soma_mudanca_prevista', coalesce(v_soma_prevista, 0),
      'por_conta_mes', coalesce(v_por_mes, '[]'::jsonb),
      'meses_bloqueados', coalesce(v_bloqueados, '[]'::jsonb)
    );
  END IF;

  -- Statement POSTERIOR ao lock: snapshot novo. `alvo` re-classifica quem está travado, e o
  -- UPDATE só reescreve o total que acabou de ler.
  WITH alvo AS (
    SELECT c.sales_order_id, c.account, c.mes, c.total, c.liquido
      FROM public.pedido_total_liquido_classificar(p_corte, v_coerentes) c
     WHERE c.classe = 'convertivel'
  ),
  escrito AS (
    UPDATE public.sales_orders so
       SET total    = a.liquido,
           subtotal = a.liquido
      FROM alvo a
     WHERE so.id = a.sales_order_id
       AND so.total = a.total
    RETURNING so.id AS sales_order_id, a.account, a.mes, a.total AS total_antes, a.liquido AS total_depois
  ),
  registrado AS (
    INSERT INTO public.pedido_total_liquido_conversoes
           (lote, sales_order_id, account, mes, total_antes, total_depois, corte)
    SELECT v_lote, e.sales_order_id, e.account, e.mes, e.total_antes, e.total_depois, p_corte
      FROM escrito e
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM alvo),
         (SELECT count(*) FROM escrito),
         (SELECT count(*) FROM registrado),
         (SELECT array_agg(e.sales_order_id ORDER BY e.sales_order_id) FROM escrito e),
         (SELECT sum(e.total_depois - e.total_antes) FROM escrito e),
         (SELECT jsonb_agg(jsonb_build_object(
                   'conta', m.account, 'mes', to_char(m.mes, 'YYYY-MM'), 'pedidos', m.n,
                   'soma_total_antes', m.s_antes, 'soma_total_depois', m.s_depois,
                   'soma_mudanca', m.s_depois - m.s_antes
                 ) ORDER BY m.account, m.mes DESC)
            FROM (SELECT e.account, e.mes, count(*) AS n,
                         sum(e.total_antes) AS s_antes, sum(e.total_depois) AS s_depois
                    FROM escrito e GROUP BY e.account, e.mes) m)
    INTO v_n_alvo, v_n_escritos, v_n_registrados, v_escritos, v_soma_mudanca, v_escritos_mes;
  v_escritos := coalesce(v_escritos, '{}'::uuid[]);

  -- Postcondição em statements POSTERIORES ao UPDATE: qualquer falha devolve o lote inteiro.
  IF v_n_escritos <> v_n_alvo OR v_n_registrados <> v_n_escritos THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: POSTCONDICAO alvo=% escritos=% registrados=% — nada foi gravado', v_n_alvo, v_n_escritos, v_n_registrados
      USING ERRCODE = 'TL001';
  END IF;

  SELECT count(*)
    INTO v_ruins
    FROM public.sales_orders so
    LEFT JOIN public.pedido_total_liquido_classificar(p_corte, v_escritos) c ON c.sales_order_id = so.id
   WHERE so.id = ANY (v_escritos)
     AND (c.sales_order_id IS NULL
          OR c.classe NOT IN ('ja_liquido', 'ambiguo')
          OR so.total    IS DISTINCT FROM c.liquido
          OR so.subtotal IS DISTINCT FROM c.liquido);
  IF v_ruins > 0 THEN
    RAISE EXCEPTION 'pedido_total_liquido_converter: POSTCONDICAO % pedido(s) escritos sem total = subtotal = liquido das linhas — nada foi gravado', v_ruins
      USING ERRCODE = 'TL001';
  END IF;

  RETURN jsonb_build_object(
    'modo', 'aplicado', 'lote', v_lote, 'corte', p_corte, 'escopo', v_escopo, 'limite', p_limite,
    'elegiveis',              v_n_elegiveis,
    'pulados_em_uso',         v_n_elegiveis - cardinality(v_travados),
    'incoerentes',            cardinality(v_incoerentes),
    'amostra_incoerentes',    to_jsonb(v_incoerentes[1:20]),
    'mudaram_sob_lock',       cardinality(v_coerentes) - v_n_alvo,
    'escritos',               v_n_escritos,
    -- Σ sobre nada escrito: a mudança foi 0 de fato.
    'soma_mudanca',           coalesce(v_soma_mudanca, 0),
    'escritos_por_conta_mes', coalesce(v_escritos_mes, '[]'::jsonb),
    'meses_bloqueados',       coalesce(v_bloqueados, '[]'::jsonb)
  );
END
$fn$;

REVOKE ALL ON FUNCTION public.pedido_total_liquido_converter(boolean, timestamptz, text[], date, date, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pedido_total_liquido_converter(boolean, timestamptz, text[], date, date, integer, boolean) TO service_role;

DO $post$
DECLARE
  v_oid regprocedure := to_regprocedure('public.pedido_total_liquido_converter(boolean,timestamptz,text[],date,date,integer,boolean)');
  v_src text;
  v_r   jsonb;
BEGIN
  IF v_oid IS NULL OR to_regprocedure('public.pedido_total_liquido_classificar(timestamptz,uuid[])') IS NULL
     OR to_regclass('public.pedido_total_liquido_conversoes') IS NULL THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: conversor, classificador ou registro ausente — aplique antes 20260914181500_pedido_total_liquido_acervo';
  END IF;
  -- O corpo NOVO, ancorado na estrutura que ele introduz — sem os comentários, que podem citá-la.
  v_src := regexp_replace(pg_get_functiondef(v_oid), '--[^\n]*', '', 'g');
  IF v_src !~ 'mes_bloqueado AS \(\s*SELECT m\.mes\s+FROM no_escopo m\s+GROUP BY m\.mes\s+HAVING'
     OR v_src !~ 'c\.mes NOT IN \(SELECT b\.mes FROM mes_bloqueado b\)' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: o conversor nao tem o gate de mes entre contas — o REPLACE nao pegou';
  END IF;
  IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_oid) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: o conversor e SECURITY DEFINER — escreveria como o dono, por cima de quem chama';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: o conversor e executavel por PUBLIC/anon/authenticated — a conversao do acervo ficaria no PostgREST';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: service_role sem EXECUTE no conversor (controle positivo do REVOKE)';
  END IF;

  -- plpgsql é late-bound: o ensaio EXECUTA o caminho de leitura sobre o dado real.
  v_r := public.pedido_total_liquido_converter(p_aplicar => false, p_corte => now());
  IF v_r->>'modo' IS DISTINCT FROM 'ensaio' OR jsonb_typeof(v_r->'meses_bloqueados') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: o ensaio nao devolveu o formato esperado: %', left(v_r::text, 160);
  END IF;
END
$post$;

COMMIT;
