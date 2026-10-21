-- ============================================================================================
-- Venda por cliente — Task 7: PAINEL DO FOUNDER (adoção por farmer × semana + estado das ondas)
-- Spec: docs/superpowers/specs/2026-10-20-venda-por-cliente-design.md §7 Fase 0, §8
-- Plano: docs/superpowers/plans/2026-10-20-venda-por-cliente.md, Task 7
-- Prova PG17: db/test-venda-painel.sh (os dois locales + --falsificar)
--
-- Só LEITURA: `venda_painel(p_de, p_ate)` (master) devolve, por farmer × semana (seg–dom):
--   na_lista · mostradas · contatados · compraram (compradores distintos, fase 'ativa')
--   virou · nao_virou · nao_medivel · pendentes · receita_realizada (sugestões de RECOMPRA)
--   taxa_ativa · taxa_base_historico_mesma_semana (52 semanas antes) · taxa_base_sombra
--   base_confiavel · ondas (config + venda_onda_log + pré-requisitos da próxima avaliação)
--
-- Caminho de apply: `bun run db:aplicar` — a transação é do EXECUTOR, por isso este arquivo NÃO
-- leva BEGIN/COMMIT (o executor recusa). Idempotente (CREATE OR REPLACE + REVOKE/GRANT).
--
-- Decisões que o plano deixou ao construtor (registradas no PR):
--  • Ausente ≠ zero: taxa = virou / (virou + nao_virou), NULL quando o denominador é 0 (nada
--    fechado ainda). nao_medivel e pendentes ficam FORA do denominador e são devolvidos à parte:
--    a tela diz "não consegui medir" quando nao_medivel > 20% das avaliadas, nunca "0%".
--  • Desfecho e taxa contam só `tipo='recompra'`: é o único tipo que a linha de base (historico e
--    sombra) tem — misturar complemento/preço na taxa ativa compararia coisas diferentes.
--  • contatados = compradores da lista da semana com `venda_contato` da MESMA farmer na MESMA
--    semana — a mesma régua da condição da Onda 2 em `venda_avaliar_ondas`.
--  • base_confiavel = existe `venda_onda_log` da onda_recompra: só o cron liga a Onda 1, e só
--    depois de 3 dias de lista ao vivo idêntica à reconstruída. Config ligada à mão sem log ≠ conferida.
--  • O painel NÃO chama `venda_avaliar_ondas` (ela ESCREVE: liga onda) nem `venda_lista_calc`
--    (~8 s por dia, medido pela carga histórica). Mostra os pré-requisitos baratos da próxima
--    avaliação; o veredito da lista idêntica é do cron, registrado em `venda_onda_log`.
--  • Custo/margem fora: este RPC não devolve cmc/custo/markup (a lista de repasse, que tem custo,
--    é `venda_repasse_candidatos`, com o próprio gate master + cap_custo_ler).
-- ============================================================================================

CREATE OR REPLACE FUNCTION public.venda_painel(p_de date, p_ate date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_ini date;
  v_fim date;   -- exclusivo
  v_cfg_on1 boolean; v_cfg_on2 boolean; v_cfg_on3 boolean;
  v_base_confiavel boolean;
  v_linhas jsonb;
  v_hist_dias int;
  v_sombra_dias jsonb := '[]'::jsonb;
  v_d date;
  v_semanas jsonb := '[]'::jsonb;
  v_seg date;
  v_n_farmers int;
  v_min_taxa numeric;
  v_repasse boolean;
  v_ondas jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'master'::public.app_role) THEN
    RAISE EXCEPTION 'venda_painel: requer master' USING ERRCODE = '42501';
  END IF;
  IF p_de IS NULL OR p_ate IS NULL OR p_ate < p_de OR p_ate - p_de > 400 THEN
    RAISE EXCEPTION 'PAINEL_PERIODO: periodo invalido (de=%, ate=%; maximo 400 dias)', p_de, p_ate
      USING ERRCODE = '22023';
  END IF;

  -- semanas inteiras (seg–dom) que tocam o período
  v_ini := date_trunc('week', p_de)::date;
  v_fim := date_trunc('week', p_ate)::date + 7;

  SELECT COALESCE(bool_or(chave = 'onda_recompra'    AND valor = 'true'::jsonb), false),
         COALESCE(bool_or(chave = 'onda_complemento' AND valor = 'true'::jsonb), false),
         COALESCE(bool_or(chave = 'onda_preco'       AND valor = 'true'::jsonb), false)
    INTO v_cfg_on1, v_cfg_on2, v_cfg_on3
    FROM public.venda_config;

  v_base_confiavel := EXISTS (SELECT 1 FROM public.venda_onda_log WHERE onda = 'onda_recompra');

  -- ── por farmer × semana ────────────────────────────────────────────────────────────────────
  WITH semanas AS (
    SELECT g::date AS semana FROM generate_series(v_ini, v_fim - 7, interval '7 days') g
  ),
  farmers AS (
    SELECT cr.user_id AS farmer_user_id
      FROM public.commercial_roles cr
     WHERE cr.commercial_role = 'farmer'
    UNION
    SELECT DISTINCT s.farmer_user_id
      FROM public.venda_sugestao s
     WHERE s.fase IN ('ativa', 'sombra') AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
  ),
  ativa AS (
    SELECT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date AS semana,
           count(DISTINCT s.comprador_id)                                              AS na_lista,
           count(DISTINCT s.comprador_id) FILTER (WHERE s.mostrada_em IS NOT NULL)     AS mostradas,
           count(DISTINCT s.comprador_id) FILTER (WHERE s.tipo = 'recompra'
                                                    AND s.desfecho = 'virou_pedido')   AS compraram,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho = 'virou_pedido') AS virou,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho = 'nao_virou')    AS nao_virou,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho = 'nao_medivel')  AS nao_medivel,
           count(*) FILTER (WHERE s.tipo = 'recompra' AND s.desfecho IS NULL)          AS pendentes,
           sum(s.valor_realizado) FILTER (WHERE s.tipo = 'recompra'
                                            AND s.desfecho = 'virou_pedido')           AS receita,
           COALESCE(bool_or(s.tipo = 'recompra' AND s.desfecho = 'virou_pedido'
                            AND s.valor_realizado IS NULL), false)                     AS receita_incompleta
      FROM public.venda_sugestao s
     WHERE s.fase = 'ativa' AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
     GROUP BY 1, 2
  ),
  lista AS (
    SELECT DISTINCT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date AS semana, s.comprador_id
      FROM public.venda_sugestao s
     WHERE s.fase = 'ativa' AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
  ),
  contatos AS (
    SELECT l.farmer_user_id, l.semana, count(*) AS contatados
      FROM lista l
     WHERE EXISTS (SELECT 1 FROM public.venda_contato c
                    WHERE c.farmer_user_id = l.farmer_user_id AND c.comprador_id = l.comprador_id
                      AND c.dia >= l.semana AND c.dia < l.semana + 7)
     GROUP BY 1, 2
  ),
  sombra AS (
    SELECT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date AS semana,
           count(DISTINCT s.comprador_id) AS na_lista
      FROM public.venda_sugestao s
     WHERE s.fase = 'sombra' AND s.dia_referencia >= v_ini AND s.dia_referencia < v_fim
     GROUP BY 1, 2
  ),
  -- mesma semana do ano anterior: 52 semanas = 364 dias (segunda cai em segunda)
  hist AS (
    SELECT s.farmer_user_id, date_trunc('week', s.dia_referencia)::date + 364 AS semana,
           count(*) FILTER (WHERE s.desfecho = 'virou_pedido') AS virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_virou')    AS nao_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_medivel')  AS nao_medivel,
           count(*) FILTER (WHERE s.desfecho IS NULL)          AS pendentes
      FROM public.venda_sugestao s
     WHERE s.fase = 'historico' AND s.tipo = 'recompra'
       AND s.dia_referencia >= v_ini - 364 AND s.dia_referencia < v_fim - 364
     GROUP BY 1, 2
  ),
  -- sombra (antes do go-live) inteira, por farmer — a 2ª linha de base
  base_sombra AS (
    SELECT s.farmer_user_id,
           count(*) FILTER (WHERE s.desfecho = 'virou_pedido') AS virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_virou')    AS nao_virou,
           count(*) FILTER (WHERE s.desfecho = 'nao_medivel')  AS nao_medivel,
           count(*) FILTER (WHERE s.desfecho IS NULL)          AS pendentes
      FROM public.venda_sugestao s
     WHERE s.fase = 'sombra' AND s.tipo = 'recompra'
     GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'farmer_user_id',   f.farmer_user_id,
           'farmer_nome',      p.name,
           'semana',           sm.semana,
           'na_lista',         COALESCE(a.na_lista, 0),
           'mostradas',        COALESCE(a.mostradas, 0),
           'contatados',       COALESCE(ct.contatados, 0),
           'compraram',        COALESCE(a.compraram, 0),
           'virou',            COALESCE(a.virou, 0),
           'nao_virou',        COALESCE(a.nao_virou, 0),
           'nao_medivel',      COALESCE(a.nao_medivel, 0),
           'pendentes',        COALESCE(a.pendentes, 0),
           -- ausente ≠ zero: sem nenhuma venda casada a receita é NULL, não R$ 0
           'receita_realizada', a.receita,
           'receita_incompleta', COALESCE(a.receita_incompleta, false),
           'taxa_ativa',       round(a.virou::numeric / NULLIF(a.virou + a.nao_virou, 0), 4),
           'na_lista_sombra',  COALESCE(so.na_lista, 0),
           'base_historico',   jsonb_build_object(
                                 'virou', COALESCE(h.virou, 0), 'nao_virou', COALESCE(h.nao_virou, 0),
                                 'nao_medivel', COALESCE(h.nao_medivel, 0), 'pendentes', COALESCE(h.pendentes, 0)),
           'taxa_base_historico_mesma_semana', round(h.virou::numeric / NULLIF(h.virou + h.nao_virou, 0), 4),
           'base_sombra',      jsonb_build_object(
                                 'virou', COALESCE(bs.virou, 0), 'nao_virou', COALESCE(bs.nao_virou, 0),
                                 'nao_medivel', COALESCE(bs.nao_medivel, 0), 'pendentes', COALESCE(bs.pendentes, 0)),
           'taxa_base_sombra', round(bs.virou::numeric / NULLIF(bs.virou + bs.nao_virou, 0), 4),
           'base_confiavel',   v_base_confiavel
         ) ORDER BY p.name NULLS LAST, f.farmer_user_id, sm.semana DESC), '[]'::jsonb)
    INTO v_linhas
    FROM farmers f
   CROSS JOIN semanas sm
    LEFT JOIN public.profiles p ON p.user_id = f.farmer_user_id
    LEFT JOIN ativa a     ON a.farmer_user_id = f.farmer_user_id AND a.semana = sm.semana
    LEFT JOIN contatos ct ON ct.farmer_user_id = f.farmer_user_id AND ct.semana = sm.semana
    LEFT JOIN sombra so   ON so.farmer_user_id = f.farmer_user_id AND so.semana = sm.semana
    LEFT JOIN hist h      ON h.farmer_user_id = f.farmer_user_id AND h.semana = sm.semana
    LEFT JOIN base_sombra bs ON bs.farmer_user_id = f.farmer_user_id;

  -- ── ondas: estado + pré-requisitos da PRÓXIMA avaliação (leitura; quem liga é o cron) ──────────
  -- Onda 1: as mesmas condições baratas de venda_avaliar_ondas (dias de histórico, sombra ao vivo
  -- nos 3 dias anteriores). A comparação de lista idêntica é do cron (custa ~8 s/dia).
  SELECT count(*) INTO v_hist_dias
    FROM public.venda_gerador_execucao WHERE fase = 'historico' AND dia_referencia < v_hoje;
  FOR i IN 1..3 LOOP
    v_d := v_hoje - i;
    v_sombra_dias := v_sombra_dias || jsonb_build_object('dia', v_d, 'ao_vivo', EXISTS (
      SELECT 1 FROM public.venda_gerador_execucao e
       WHERE e.dia_referencia = v_d AND e.fase = 'sombra'
         AND (e.primeira_em AT TIME ZONE 'America/Sao_Paulo')::date = v_d));
  END LOOP;

  -- Onda 2: ≥ 80% de contatados por farmer em cada uma das 2 últimas semanas completas.
  FOR i IN 1..2 LOOP
    v_seg := date_trunc('week', v_hoje)::date - 7 * i;
    WITH lista AS (
      SELECT DISTINCT s.farmer_user_id, s.comprador_id
        FROM public.venda_sugestao s
       WHERE s.fase = 'ativa' AND s.dia_referencia >= v_seg AND s.dia_referencia < v_seg + 7
    ),
    por_farmer AS (
      SELECT l.farmer_user_id,
             (count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM public.venda_contato c
                 WHERE c.farmer_user_id = l.farmer_user_id AND c.comprador_id = l.comprador_id
                   AND c.dia >= v_seg AND c.dia < v_seg + 7)))::numeric / count(*) AS taxa
        FROM lista l
       GROUP BY l.farmer_user_id
    )
    SELECT count(*), min(pf.taxa) INTO v_n_farmers, v_min_taxa FROM por_farmer pf;
    v_semanas := v_semanas || jsonb_build_object('semana', v_seg, 'farmers', v_n_farmers,
                                                 'menor_taxa', round(v_min_taxa, 4),
                                                 'ok', v_n_farmers > 0 AND v_min_taxa >= 0.8);
  END LOOP;

  -- Onda 3: ≥ 1 repasse aprovado vigente (tabela da Task 6; ausente = NULL, "não sei", não false).
  v_repasse := NULL;
  IF to_regclass('public.venda_repasse_aprovado') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.venda_repasse_aprovado
                               WHERE revogado_em IS NULL AND valido_ate >= $1)'
         INTO v_repasse USING v_hoje;
    EXCEPTION WHEN undefined_column OR undefined_table THEN
      v_repasse := NULL;
    END;
  END IF;

  SELECT jsonb_build_object(
    'onda_recompra', jsonb_build_object(
      'ligada', v_cfg_on1,
      'ligada_em', (SELECT l.ligada_em FROM public.venda_onda_log l WHERE l.onda = 'onda_recompra'),
      'condicao_ao_ligar', (SELECT l.condicao FROM public.venda_onda_log l WHERE l.onda = 'onda_recompra'),
      'prerequisitos', jsonb_build_object(
        'historico_dias', v_hist_dias, 'historico_meta', 365,
        'sombra_ao_vivo', v_sombra_dias,
        -- o cron avalia e DEPOIS gera a lista do dia: lista de hoje gravada = avaliação de hoje já rodou
        'avaliada_hoje', EXISTS (SELECT 1 FROM public.venda_gerador_execucao e
                                  WHERE e.dia_referencia = v_hoje AND e.fase IN ('sombra', 'ativa')))),
    'onda_complemento', jsonb_build_object(
      'ligada', v_cfg_on2,
      'ligada_em', (SELECT l.ligada_em FROM public.venda_onda_log l WHERE l.onda = 'onda_complemento'),
      'condicao_ao_ligar', (SELECT l.condicao FROM public.venda_onda_log l WHERE l.onda = 'onda_complemento'),
      'prerequisitos', jsonb_build_object('onda_recompra_ligada', v_cfg_on1, 'semanas', v_semanas)),
    'onda_preco', jsonb_build_object(
      'ligada', v_cfg_on3,
      'ligada_em', (SELECT l.ligada_em FROM public.venda_onda_log l WHERE l.onda = 'onda_preco'),
      'condicao_ao_ligar', (SELECT l.condicao FROM public.venda_onda_log l WHERE l.onda = 'onda_preco'),
      'prerequisitos', jsonb_build_object('onda_complemento_ligada', v_cfg_on2, 'repasse_vigente', v_repasse)))
    INTO v_ondas;

  RETURN jsonb_build_object(
    'hoje', v_hoje,
    'periodo', jsonb_build_object('de', v_ini, 'ate', v_fim - 1),
    'base_confiavel', v_base_confiavel,
    'repasse_disponivel', to_regprocedure('public.venda_repasse_candidatos()') IS NOT NULL,
    'linhas', v_linhas,
    'ondas', v_ondas);
END
$function$;

REVOKE ALL ON FUNCTION public.venda_painel(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.venda_painel(date, date) TO authenticated;

COMMENT ON FUNCTION public.venda_painel(date, date) IS
  'Venda por cliente (Task 7): painel do founder (master) — adoção por farmer × semana, conversão de '
  'recompra ativa × linha de base (histórico da mesma semana do ano anterior e sombra) e estado das ondas. '
  'Só leitura; não devolve custo. Antes × depois, não é prova causal.';

-- ── postcondição ──────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  f text := 'public.venda_painel(date,date)';
BEGIN
  -- P1 existe, SECURITY DEFINER, STABLE, search_path fixo, sem sobrecarga
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'venda_painel') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                     WHERE n.nspname = 'public' AND p.proname = 'venda_painel'
                       AND p.prosecdef AND p.provolatile = 's'
                       AND p.proconfig @> ARRAY['search_path=public, pg_temp']) THEN
    RAISE EXCEPTION 'P1 FALHOU: venda_painel ausente, com sobrecarga ou sem SECURITY DEFINER/STABLE/search_path';
  END IF;

  -- P2 ACL: anon e PUBLIC sem EXECUTE; authenticated com (o gate master é na fronteira)
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: ACL de venda_painel (anon/PUBLIC sem, authenticated com)';
  END IF;

  RAISE NOTICE 'venda_cliente_painel OK: venda_painel(date,date) master-only, ACL fechada para anon/PUBLIC';
END
$post$;
