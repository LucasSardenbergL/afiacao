-- ============================================================================================
-- pedido_total_liquido_converter — migration CANÔNICA do corpo que a PROD já roda, com a tabela
-- de exceção nominal que ele lê (I2 · plano v2, item 5)
--
-- POR QUE EXISTE: desde 2026-10-05 a prod roda um conversor que NENHUMA migration commitada
-- reproduz. A exclusão NOMINAL e auditável — o universo passa a ser
-- `pedido_total_liquido_classificar(...) z WHERE NOT EXISTS (pedido_total_liquido_excecao)` e o
-- retorno ganha `escopo.excecoes_ativas` — foi aplicada pelo envelope
-- `db/2026-10-05-pedido-total-liquido-excecao.sql` (db_aplicacoes #274, acervo #2846): duas
-- edições ancoradas sobre o `pg_get_functiondef` VIVO. A TABELA `public.pedido_total_liquido_excecao`
-- (105 pedidos em 2026-10-19) também nasceu só no envelope: nenhuma migration a declara. Um
-- `CREATE OR REPLACE` a partir da 20260914193000 apagaria a exclusão em silêncio e a conversão
-- voltaria a alcançar pedido sem apuração — "a última a recriar vence" (docs/agent/database.md §2).
--
-- O QUE FAZ: (1) declara a tabela (DDL idêntica à do envelope; `IF NOT EXISTS` porque em prod ela
-- existe) e FECHA os privilégios default de PUBLIC/anon/authenticated — RLS sem policy nega as
-- linhas, mas NÃO cobre TRUNCATE (parecer Codex de desenho, 2026-10-19, P1); (2) torna o corpo
-- vivo a declaração CANÔNICA: o CREATE é o `pg_get_functiondef` da PROD de 2026-10-19 copiado
-- BYTE A BYTE (md5(prosrc) = 4d88eebd9dea026346d706befca0fced). Em prod é no-op de corpo; num
-- restore só de migrations (DR) reconstrói função E esquema da tabela — NÃO o acervo de exceções:
-- a lista e suas evidências voltam pelo restore de dados, e até lá os meses com pedido sem
-- apuração ficam BLOQUEADOS (fail-closed por omissão, nunca conversão indevida).
-- Decisão do founder em 2026-10-19 — opção (a) da decisão #1 do plano v2.
--
-- MOLDE (skill lovable-db-operator, "Recriar objeto VIVO"): TRAVA → PRE → CREATE → PÓS numa
-- transação só (SQL Editor: BEGIN/COMMIT aqui). A PRE exige corpo vivo ∈ {predecessor revisado
-- (20260914193000, md5 0cdb517ed0e81b65e1330d815fde6784 — o mesmo que db/aplicar-pedido-total-liquido-rpc.sql
-- deixa), este}; outro estado ABORTA — nunca trocar a constante no SQL Editor. A PÓS prova a
-- estrutura da tabela (colunas, NOT NULL, CHECKs, PK, FK ON DELETE CASCADE validada, RLS, zero
-- policies, privilégios), o corpo, a assinatura COM defaults, retorno, linguagem, INVOKER,
-- volatilidade, STRICT, search_path, ACL — e EXECUTA o ensaio (plpgsql é late-bound). Sem
-- `pg_get_functiondef`+`EXECUTE`+`replace(` juntos, de propósito (o auditor leria como patch).
--
-- Idempotente. Prova PG17 com falsificação (dois locales): db/test-pedido-total-liquido-excecao.sh,
-- seção C e sabotagens `canonica_*`. Depois de aplicada e mergeada, `bun run deriva:corpo:prod`
-- julga a identidade EM_DIA e as entradas EDICAO_MANUAL/PATCH dela saem da baseline.
-- Narrativa: docs/historico/deriva-canonica-i2.md
-- ============================================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';          -- orçamento: ENABLE RLS e a TRAVA esperam no máximo isto
SET LOCAL statement_timeout = '180s';   -- a PÓS executa o ensaio sobre o acervo; nada aqui pode segurar a prod mais que isto

-- ─── 1. A tabela de exceção nominal (DDL do envelope, verbatim) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.pedido_total_liquido_excecao (
  sales_order_id uuid PRIMARY KEY REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  motivo         text        NOT NULL CHECK (motivo IN ('sem_apuracao', 'apuracao_parcial')),
  evidencia      text        NOT NULL CHECK (length(btrim(evidencia)) > 0),
  criado_em      timestamptz NOT NULL DEFAULT now(),
  criado_por     text        NOT NULL CHECK (length(btrim(criado_por)) > 0),
  -- Exceção sem data de revisão é alarme silenciado: se o Omie passar a correlacionar o trio, a
  -- linha aqui vira lixo que esconde a regressão seguinte. O sensor cobra por esta coluna.
  revisar_em     date        NOT NULL
);

COMMENT ON TABLE public.pedido_total_liquido_excecao IS
  'Pedidos que o conversor do total liquido ignora NOMINALMENTE: nao contam no gate de mes completo '
  'e nunca sao convertidos. Fail-closed por omissao — pedido nao apurado e nao listado segue '
  'bloqueando o mes. Ver docs/historico/backfill-desconto-a-porta-fora-do-envelope.md';
COMMENT ON COLUMN public.pedido_total_liquido_excecao.motivo IS
  'Forma medida LOCALMENTE e verificavel: sem_apuracao = nenhuma linha do pedido tem '
  'desconto_valor; apuracao_parcial = tem linha apurada e linha NULL no mesmo pedido. O motivo do '
  'lado do Omie (sem_correspondencia/ambiguo) exige um dry-run do backfill e e enriquecimento, '
  'nao pre-requisito.';

ALTER TABLE public.pedido_total_liquido_excecao ENABLE ROW LEVEL SECURITY;
-- Sem policy: ninguém da API chega às linhas. E sem privilégio: os defaults do Supabase davam
-- ALL (inclusive TRUNCATE, que RLS não cobre) a anon/authenticated. Quem lê é o conversor
-- (SECURITY INVOKER) chamado por postgres (dono) ou service_role (BYPASSRLS).
REVOKE ALL ON TABLE public.pedido_total_liquido_excecao FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.pedido_total_liquido_excecao TO service_role;

-- ─── 2. O conversor: TRAVA → PRE → CREATE → PÓS ─────────────────────────────────────────────
DO $trava$
BEGIN
  IF to_regprocedure('public.pedido_total_liquido_converter(boolean,timestamp with time zone,text[],date,date,integer,boolean)') IS NOT NULL THEN
    -- a volatilidade é conferida ANTES do ALTER (que a normalizaria): mesmo corpo, outra volatilidade → aborta
    IF (SELECT p.provolatile FROM pg_catalog.pg_proc p
         WHERE p.oid = to_regprocedure('public.pedido_total_liquido_converter(boolean,timestamp with time zone,text[],date,date,integer,boolean)')) <> 'v' THEN
      RAISE EXCEPTION 'PRE FALHOU: pedido_total_liquido_converter viva não é VOLATILE — alguém mudou a volatilidade à mão; reconcilie antes de colar';
    END IF;
    ALTER FUNCTION public.pedido_total_liquido_converter(boolean, timestamp with time zone, text[], date, date, integer, boolean) VOLATILE;
  END IF;
END
$trava$;

DO $pre$
DECLARE
  v_oid  oid := to_regprocedure('public.pedido_total_liquido_converter(boolean,timestamp with time zone,text[],date,date,integer,boolean)');
  v_vivo text;
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.pedido_total_liquido_converter(...) não existe — aplique antes 20260914181500_pedido_total_liquido_acervo e 20260914193000_pedido_total_liquido_acervo_mes_entre_contas';
  END IF;
  IF to_regprocedure('public.pedido_total_liquido_classificar(timestamp with time zone,uuid[])') IS NULL
     OR to_regclass('public.pedido_total_liquido_conversoes') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: classificador ou registro de conversões ausente — o corpo canônico os lê em runtime';
  END IF;
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  IF v_vivo NOT IN ('0cdb517ed0e81b65e1330d815fde6784',   -- 20260914193000: o predecessor revisado (restore só de migrations)
                    '4d88eebd9dea026346d706befca0fced')   -- PROD 2026-10-19: ESTE corpo (reaplicar é no-op)
  THEN
    RAISE EXCEPTION 'PRE FALHOU: o corpo vivo de pedido_total_liquido_converter (md5 %) não é o predecessor revisado nem este — outra entrega o recriou; NÃO troque a constante: confirme o rollback, recapture a definição viva na PROD e reconcilie antes de colar de novo', v_vivo;
  END IF;
  -- O contrato FORA do prosrc e a ACL, ANTES de o CREATE/REVOKE/GRANT os sobrescreverem (parecer Codex de
  -- código, 2026-10-19, P1): o mesmo corpo com `p_limite DEFAULT 100`, outro search_path ou SECURITY DEFINER,
  -- ou uma revogação de emergência de EXECUTE, não pode ser normalizado em silêncio — aborta e alguém olha.
  IF pg_get_function_arguments(v_oid) IS DISTINCT FROM
       'p_aplicar boolean, p_corte timestamp with time zone, p_contas text[] DEFAULT NULL::text[], '
       'p_mes_de date DEFAULT NULL::date, p_mes_ate date DEFAULT NULL::date, p_limite integer DEFAULT 5000, '
       'p_exigir_mes_completo boolean DEFAULT true'
     OR pg_get_function_result(v_oid) IS DISTINCT FROM 'jsonb'
     OR (SELECT l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE p.oid = v_oid) IS DISTINCT FROM 'plpgsql'
     OR (SELECT p.prosecdef OR p.proisstrict FROM pg_catalog.pg_proc p WHERE p.oid = v_oid)
     OR (SELECT p.proconfig FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
  THEN
    RAISE EXCEPTION 'PRE FALHOU: atributos vivos de pedido_total_liquido_converter fora do contrato (defaults da assinatura, RETURNS jsonb, plpgsql, INVOKER, não-STRICT, search_path public,pg_temp) com o mesmo corpo — mudança à mão; reconcilie antes de colar';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_function_privilege('public', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'PRE FALHOU: ACL viva de pedido_total_liquido_converter fora do contrato (EXECUTE só para service_role entre as roles da API) — revogação de emergência ou grant à mão; reconcilie antes de colar';
  END IF;
END
$pre$;

-- CREATE: pg_get_functiondef da PROD (2026-10-19), byte a byte.
CREATE OR REPLACE FUNCTION public.pedido_total_liquido_converter(p_aplicar boolean, p_corte timestamp with time zone, p_contas text[] DEFAULT NULL::text[], p_mes_de date DEFAULT NULL::date, p_mes_ate date DEFAULT NULL::date, p_limite integer DEFAULT 5000, p_exigir_mes_completo boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    'exigir_mes_completo', p_exigir_mes_completo,
    'excecoes_ativas',     (SELECT count(*) FROM public.pedido_total_liquido_excecao)
  );

  WITH c AS MATERIALIZED (
    -- Exclusao NOMINAL: o pedido listado em `pedido_total_liquido_excecao` sai do universo ANTES de
    -- tudo, e isso lhe da as duas propriedades de uma vez — nao conta no `n_nao_apurado` que bloqueia
    -- o mes, e nunca entra em `elegivel`, porque sua classe nunca foi 'convertivel'. A exclusao deixa
    -- de CONSERTAR o pedido; nao lhe fabrica desconto (`ausente != zero`): ele segue com cabecalho
    -- bruto na tela, visivel e nao mentido.
    SELECT z.*
      FROM public.pedido_total_liquido_classificar(p_corte, NULL) z
     WHERE NOT EXISTS (SELECT 1
                         FROM public.pedido_total_liquido_excecao x
                        WHERE x.sales_order_id = z.sales_order_id)
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
$function$;

-- ACL repetida como na 20260914193000.
REVOKE ALL ON FUNCTION public.pedido_total_liquido_converter(boolean, timestamp with time zone, text[], date, date, integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pedido_total_liquido_converter(boolean, timestamp with time zone, text[], date, date, integer, boolean) TO service_role;

-- PÓS: tabela com a estrutura inteira, corpo canônico com o contrato inteiro, e o ensaio EXECUTA.
DO $pos$
DECLARE
  v_tab  oid := to_regclass('public.pedido_total_liquido_excecao');
  v_oid  oid := to_regprocedure('public.pedido_total_liquido_converter(boolean,timestamp with time zone,text[],date,date,integer,boolean)');
  v_src  text;
  v_r    jsonb;
  v_n    bigint;
  v_cols text;
BEGIN
  -- (a) a tabela: existe ≠ vale (skill lovable-db-operator, postcondição embutida).
  IF v_tab IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: pedido_total_liquido_excecao não existe';
  END IF;
  SELECT string_agg(c.column_name || ':' || c.data_type || ':' || c.is_nullable
                    || ':' || coalesce(c.column_default, '-'), ',' ORDER BY c.ordinal_position)
    INTO v_cols
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'pedido_total_liquido_excecao';
  IF v_cols IS DISTINCT FROM 'sales_order_id:uuid:NO:-,motivo:text:NO:-,evidencia:text:NO:-,'
                             'criado_em:timestamp with time zone:NO:now(),criado_por:text:NO:-,revisar_em:date:NO:-' THEN
    RAISE EXCEPTION 'POS FALHOU: colunas/nulabilidade/defaults da tabela fora do contrato: %', v_cols;
  END IF;
  -- CHECKs pela EXPRESSÃO, não pelo nome (parecer Codex de código, P2): `> 0` virado `>= 0` mantém o nome.
  IF (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid = v_tab AND k.contype = 'c' AND k.convalidated
        AND pg_get_constraintdef(k.oid) IN (
          'CHECK ((motivo = ANY (ARRAY[''sem_apuracao''::text, ''apuracao_parcial''::text])))',
          'CHECK ((length(btrim(evidencia)) > 0))',
          'CHECK ((length(btrim(criado_por)) > 0))')) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = v_tab AND k.contype = 'p'
                      AND pg_get_constraintdef(k.oid) = 'PRIMARY KEY (sales_order_id)')
     OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conrelid = v_tab AND k.contype = 'f' AND k.convalidated
                      AND pg_get_constraintdef(k.oid) = 'FOREIGN KEY (sales_order_id) REFERENCES sales_orders(id) ON DELETE CASCADE') THEN
    RAISE EXCEPTION 'POS FALHOU: os 3 CHECKs (pela expressão), a PK ou a FK validada sales_order_id → sales_orders(id) ON DELETE CASCADE faltam na tabela de exceção';
  END IF;
  IF NOT (SELECT c.relrowsecurity FROM pg_catalog.pg_class c WHERE c.oid = v_tab)
     OR (SELECT count(*) FROM pg_catalog.pg_policy p WHERE p.polrelid = v_tab) <> 0 THEN
    RAISE EXCEPTION 'POS FALHOU: a tabela de exceção precisa de RLS ligada e ZERO policies';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public', 'anon', 'authenticated']) r,
                           unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) pr
              WHERE has_table_privilege(r, v_tab, pr))
     OR NOT has_table_privilege('service_role', v_tab, 'SELECT') THEN
    RAISE EXCEPTION 'POS FALHOU: privilégios da tabela de exceção fora do contrato (nada para PUBLIC/anon/authenticated; SELECT para service_role)';
  END IF;

  -- (b) a função: corpo e contrato.
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'POS FALHOU: pedido_total_liquido_converter sumiu depois do CREATE';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
  IF md5(v_src) IS DISTINCT FROM '4d88eebd9dea026346d706befca0fced' THEN
    RAISE EXCEPTION 'POS FALHOU: o corpo vivo (md5 %) não é o canônico — o CREATE não pegou', md5(v_src);
  END IF;
  IF pg_get_function_arguments(v_oid) IS DISTINCT FROM
       'p_aplicar boolean, p_corte timestamp with time zone, p_contas text[] DEFAULT NULL::text[], '
       'p_mes_de date DEFAULT NULL::date, p_mes_ate date DEFAULT NULL::date, p_limite integer DEFAULT 5000, '
       'p_exigir_mes_completo boolean DEFAULT true'
     OR pg_get_function_result(v_oid) IS DISTINCT FROM 'jsonb'
     OR (SELECT l.lanname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE p.oid = v_oid) IS DISTINCT FROM 'plpgsql'
     OR (SELECT p.prosecdef OR p.proisstrict OR p.provolatile <> 'v' FROM pg_catalog.pg_proc p WHERE p.oid = v_oid)
     OR (SELECT p.proconfig FROM pg_catalog.pg_proc p WHERE p.oid = v_oid) IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
  THEN
    RAISE EXCEPTION 'POS FALHOU: atributos fora do contrato (defaults da assinatura, RETURNS jsonb, plpgsql, SECURITY INVOKER, VOLATILE, não-STRICT, search_path public,pg_temp)';
  END IF;
  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE')
     OR has_function_privilege('public', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE')
     OR has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS FALHOU: ACL fora do esperado — EXECUTE só para service_role entre as roles da API';
  END IF;
  IF position('FROM public.pedido_total_liquido_excecao x' IN v_src) = 0
     OR position($k$'excecoes_ativas',$k$ IN v_src) = 0 THEN
    RAISE EXCEPTION 'POS FALHOU: o corpo não lê a tabela de exceção nem publica excecoes_ativas — não é o corpo do envelope';
  END IF;
  -- (c) o ensaio EXECUTA o caminho de leitura sobre o dado real: nada escreve, e a contagem publicada
  -- é a da tabela (a chave tem de EXISTIR — comparação NULL-safe, não `<>`).
  v_r := public.pedido_total_liquido_converter(p_aplicar => false, p_corte => now());
  SELECT count(*) INTO v_n FROM public.pedido_total_liquido_excecao;
  IF (v_r ->> 'modo') IS DISTINCT FROM 'ensaio'
     OR jsonb_typeof(v_r -> 'meses_bloqueados') IS DISTINCT FROM 'array'
     OR NOT (v_r -> 'escopo') ? 'excecoes_ativas'
     OR (v_r #>> '{escopo,excecoes_ativas}')::bigint IS DISTINCT FROM v_n THEN
    RAISE EXCEPTION 'POS FALHOU: o ensaio não devolveu modo=ensaio + meses_bloqueados + escopo.excecoes_ativas=% : %', v_n, left(v_r::text, 240);
  END IF;
END
$pos$;

COMMIT;
