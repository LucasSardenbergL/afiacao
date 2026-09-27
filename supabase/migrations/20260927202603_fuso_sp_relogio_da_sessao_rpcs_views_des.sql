-- 20260927202603_fuso_sp_relogio_da_sessao_rpcs_views_des.sql
-- ============================================================
-- O "hoje/semana/mês/trimestre" de 2 RPCs e 2 views DES passa a ser o de SÃO PAULO,
-- seja qual for o TimeZone da sessão.
-- ============================================================
-- A classe (docs/agent/money-path.md, "Prova que depende da HORA"): `date_trunc` de calendário —
-- e `CURRENT_DATE`, que é a mesma coisa — sobre o relógio da SESSÃO sem fuso escrito. A prod roda
-- sessões em UTC (TimeZone=UTC do arquivo de configuração, sem override por papel nem por banco —
-- psql-ro, 2026-09-27), e o PostgREST herda isso: das 21:00 às 23:59 BRT o "hoje" da sessão já é
-- amanhã. Os 4 objetos abaixo são os sítios vivos AFETADOS da classe — varredura da prod em
-- funções, views, matviews, defaults, constraints, policies e os 99 crons; o único outro casamento,
-- o cron 148 (cmc-snapshot-backfill-mensal), dispara às 01:00 BRT do dia 2: mesmo mês nos 2 fusos.
--   · radar_kpis(): `virou_cliente_mes` zerava das 21:00 às 23:59 BRT do último dia do mês e, o mês
--     inteiro, contava as conversões das 21:00–23:59 BRT do último dia do mês ANTERIOR;
--   · fin_projecao_13_semanas(): domingo, das 21:00 às 23:59 BRT, a projeção de caixa começava na
--     semana SEGUINTE — a corrente, com os títulos em aberto dela, sumia da projeção;
--   · v_des_pedidos_em_transito / v_des_posicao_trimestre_ao_vivo: no último dia do trimestre, das
--     21:00 às 23:59 BRT, o trimestre "atual" já era o seguinte — a posição DES e a faixa de desconto
--     projetada do check-in (v_des_desconto_por_checkin) perdiam os pedidos em trânsito; e todo dia,
--     na mesma janela, `dias_restantes` saía 1 a menos e `calculado_em` era amanhã.
--
-- Conserto: partir de `now()` com o fuso ESCRITO. `CURRENT_DATE AT TIME ZONE …` não conserta (é a
-- data da SESSÃO convertida), nem o 3º argumento do date_trunc aplicado a ela. radar_kpis compara
-- timestamptz com timestamptz, então usa a forma de 3 argumentos (o início do mês de SP como
-- instante); as demais truncam o relógio de parede de SP (`now() AT TIME ZONE …`, um timestamp).
-- Única mudança em cada objeto: o relógio. O resto é o texto VIVO da prod de 2026-09-27
-- (pg_get_functiondef / pg_get_viewdef), linha a linha — mesmos nomes, assinaturas, colunas (ordem
-- e tipos), volatilidade, SECURITY DEFINER e search_path. As 2 views não tinham CREATE no repo
-- (viviam só na prod); `security_invoker = on` repetido: omiti-lo num replace RESETA a opção e a
-- view passa a ler como dono, sem RLS (database.md §4). CREATE OR REPLACE preserva ACL e
-- dependentes; o REVOKE/GRANT das RPCs é para o ambiente onde elas NASCEM aqui.
--
-- Fora, medido, com pergunta aberta: `horario_disparo_real::date` em v_des_pedidos_em_transito
-- (instante → data no fuso da sessão, classe irmã) fica como está. 38 dos 152 disparos Sayerlack
-- caíram das 21:00 às 23:59 BRT, e a data certa ali depende do corte do snapshot GoodData — trocar
-- sem saber mudaria a posição DES em 25% dos pedidos por palpite.
--
-- Prova: db/test-fuso-sp-relogio-sessao.sh (PG17, relógio controlado cruzando 21:00 BRT sob
-- TimeZone=UTC E America/Sao_Paulo) e o mesmo script com --falsificar.
-- Aplicação: bun run db:aplicar — a transação é do executor, por isso não há BEGIN/COMMIT aqui.
-- Reverter depois do commit = migration compensatória nova.
--
-- Identidade (PRE e POS): md5 do texto sem comentário `--` e com espaço colapsado — o `prosrc` das
-- funções e o `pg_get_viewdef(…, true)` das views.

-- Pré-condição: cada objeto vivo tem de ser o PREDECESSOR revisado (o da prod em 2026-09-27) ou JÁ
-- este (re-aplicar é seguro). Qualquer outro é mudança concorrente que este CREATE OR REPLACE
-- apagaria em silêncio — aborta. Objeto ausente (ambiente novo) segue.
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('radar_kpis()',
         (SELECT md5(btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g')))
            FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_kpis()')),
         '53a1f5670f59da3da0b8ee625d3869a3', 'e69f32d0ff27e1e128408174dc4aff0d'),
        ('fin_projecao_13_semanas(text,numeric)',
         (SELECT md5(btrim(regexp_replace(regexp_replace(p.prosrc, '--[^\n]*', '', 'g'), '\s+', ' ', 'g')))
            FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.fin_projecao_13_semanas(text,numeric)')),
         '09a9f14cbbe17b853ef7649c51f4358e', '48f7ceb8457b16304f04c4b7c14c57c6'),
        ('v_des_pedidos_em_transito',
         (SELECT md5(btrim(regexp_replace(pg_catalog.pg_get_viewdef(c.oid, true), '\s+', ' ', 'g')))
            FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.v_des_pedidos_em_transito')),
         'f9964fe561ea37fb47ec08305b3c4b47', '131754f42dbb24105f018ca65ca946cf'),
        ('v_des_posicao_trimestre_ao_vivo',
         (SELECT md5(btrim(regexp_replace(pg_catalog.pg_get_viewdef(c.oid, true), '\s+', ' ', 'g')))
            FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('public.v_des_posicao_trimestre_ao_vivo')),
         '8f260694f102ca50ad41e42b38c8f629', '62b43b598d57342dde8c87f857421746')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NOT NULL AND r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 normalizado %) não é o predecessor revisado nem este — outra mudança chegou antes; reconcilie antes de aplicar', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

CREATE OR REPLACE FUNCTION public.radar_kpis()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_lote text;
  v_novos integer;
  v_a_contatar integer;
  v_em_conversa integer;
  v_virou_mes integer;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;

  SELECT mes_referencia, COALESCE(novos, 0) INTO v_lote, v_novos
    FROM public.radar_ingest_state
   WHERE status = 'complete'
   ORDER BY mes_referencia DESC LIMIT 1;

  SELECT count(*) INTO v_a_contatar FROM public.radar_empresas
   WHERE prospeccao_status = 'a_contatar' AND ja_cliente = false
     AND (v_lote IS NULL OR ultimo_lote = v_lote);
  SELECT count(*) INTO v_em_conversa FROM public.radar_empresas
   WHERE prospeccao_status = 'em_conversa';
  SELECT count(*) INTO v_virou_mes FROM public.radar_empresas
   WHERE prospeccao_status = 'virou_cliente'
     AND prospeccao_atualizado_em >= date_trunc('month', now(), 'America/Sao_Paulo');

  RETURN jsonb_build_object(
    'lote', v_lote, 'novos', COALESCE(v_novos, 0),
    'a_contatar', v_a_contatar, 'em_conversa', v_em_conversa,
    'virou_cliente_mes', v_virou_mes);
END $function$;

CREATE OR REPLACE FUNCTION public.fin_projecao_13_semanas(p_company text DEFAULT NULL::text, p_saldo_inicial numeric DEFAULT NULL::numeric)
 RETURNS TABLE(semana_inicio date, semana_fim date, semana_label text, entradas_previstas numeric, saidas_previstas numeric, fluxo_liquido numeric, saldo_projetado numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_saldo numeric;
  v_week_start date;
  v_week_end date;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  IF p_saldo_inicial IS NOT NULL THEN
    v_saldo := p_saldo_inicial;
  ELSE
    IF p_company IS NOT NULL THEN
      SELECT COALESCE(SUM(saldo_atual), 0) INTO v_saldo FROM fin_contas_correntes WHERE company = p_company AND ativo;
    ELSE
      SELECT COALESCE(SUM(saldo_atual), 0) INTO v_saldo FROM fin_contas_correntes WHERE ativo;
    END IF;
  END IF;

  FOR i IN 0..12 LOOP
    v_week_start := date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')::date + (i * 7);
    v_week_end := v_week_start + 6;
    SELECT COALESCE(SUM(valor_documento - COALESCE(valor_recebido, 0)), 0) INTO entradas_previstas
    FROM fin_contas_receber
    WHERE (p_company IS NULL OR company = p_company)
      AND data_vencimento BETWEEN v_week_start AND v_week_end
      AND status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE');
    SELECT COALESCE(SUM(valor_documento - COALESCE(valor_pago, 0)), 0) INTO saidas_previstas
    FROM fin_contas_pagar
    WHERE (p_company IS NULL OR company = p_company)
      AND data_vencimento BETWEEN v_week_start AND v_week_end
      AND status_titulo IN ('A VENCER','ATRASADO','VENCE HOJE');
    fluxo_liquido := entradas_previstas - saidas_previstas;
    v_saldo := v_saldo + fluxo_liquido;
    semana_inicio := v_week_start;
    semana_fim := v_week_end;
    semana_label := to_char(v_week_start, 'DD/MM') || '-' || to_char(v_week_end, 'DD/MM');
    saldo_projetado := v_saldo;
    RETURN NEXT;
  END LOOP;
END;
$function$;

CREATE OR REPLACE VIEW public.v_des_pedidos_em_transito
WITH (security_invoker = on) AS
WITH trimestre_info AS (
         SELECT EXTRACT(year FROM (now() AT TIME ZONE 'America/Sao_Paulo'))::integer AS ano_atual,
            EXTRACT(quarter FROM (now() AT TIME ZONE 'America/Sao_Paulo'))::integer AS trimestre_atual,
            date_trunc('quarter'::text, now() AT TIME ZONE 'America/Sao_Paulo')::date AS inicio_trimestre,
            (date_trunc('quarter'::text, now() AT TIME ZONE 'America/Sao_Paulo') + '3 mons -1 days'::interval)::date AS fim_trimestre
        ), pedidos AS (
         SELECT pcs.id AS pedido_id,
            pcs.empresa,
            pcs.fornecedor_nome,
            pcs.grupo_codigo,
            pcs.data_ciclo,
            pcs.horario_disparo_real,
            pcs.valor_total,
            pcs.status,
            pcs.tipo_ciclo,
            COALESCE(pcs.horario_disparo_real::date, pcs.data_ciclo) AS data_emissao,
            des_data_faturamento_prevista(COALESCE(pcs.horario_disparo_real::date, pcs.data_ciclo), pcs.grupo_codigo, pcs.empresa) AS data_faturamento_prevista
           FROM pedido_compra_sugerido pcs
          WHERE pcs.fornecedor_nome = 'RENNER SAYERLACK S/A'::text AND (pcs.status = ANY (ARRAY['pendente_aprovacao'::text, 'aprovado'::text, 'disparado'::text]))
        )
 SELECT p.pedido_id,
    p.empresa,
    p.fornecedor_nome,
    p.grupo_codigo,
    p.data_ciclo,
    p.horario_disparo_real,
    p.valor_total,
    p.status,
    p.tipo_ciclo,
    p.data_emissao,
    p.data_faturamento_prevista,
    ti.ano_atual,
    ti.trimestre_atual,
    ti.inicio_trimestre,
    ti.fim_trimestre,
    p.data_faturamento_prevista >= ti.inicio_trimestre AND p.data_faturamento_prevista <= ti.fim_trimestre AS fatura_no_trimestre,
        CASE
            WHEN p.data_faturamento_prevista > ti.fim_trimestre THEN 'fora'::text
            WHEN (ti.fim_trimestre - p.data_emissao)::numeric >= (COALESCE(( SELECT fgp.lt_producao_dias
               FROM fornecedor_grupo_producao fgp
              WHERE fgp.grupo_codigo = p.grupo_codigo
             LIMIT 1), 8)::numeric * 1.4 * 1.2) THEN 'verde'::text
            WHEN (ti.fim_trimestre - p.data_emissao)::numeric >= (COALESCE(( SELECT fgp.lt_producao_dias
               FROM fornecedor_grupo_producao fgp
              WHERE fgp.grupo_codigo = p.grupo_codigo
             LIMIT 1), 8)::numeric * 1.4) THEN 'amarelo'::text
            ELSE 'vermelho'::text
        END AS zona_confianca
   FROM pedidos p
     CROSS JOIN trimestre_info ti;

CREATE OR REPLACE VIEW public.v_des_posicao_trimestre_ao_vivo
WITH (security_invoker = on) AS
WITH snapshot AS (
         SELECT v_des_snapshot_mais_recente.empresa,
            v_des_snapshot_mais_recente.ano,
            v_des_snapshot_mais_recente.trimestre,
            v_des_snapshot_mais_recente.data_referencia,
            v_des_snapshot_mais_recente.objetivo_valor,
            v_des_snapshot_mais_recente.fat_bruto_valor,
            v_des_snapshot_mais_recente.pedidos_abertos_valor
           FROM v_des_snapshot_mais_recente
        ), pedidos_apos_snapshot AS (
         SELECT t.empresa,
            t.ano_atual AS ano,
            t.trimestre_atual AS trimestre,
            sum(
                CASE
                    WHEN t.fatura_no_trimestre AND (t.zona_confianca = ANY (ARRAY['verde'::text, 'amarelo'::text])) THEN t.valor_total
                    ELSE 0::numeric
                END) AS valor_em_transito_seguro,
            sum(
                CASE
                    WHEN t.fatura_no_trimestre AND t.zona_confianca = 'vermelho'::text THEN t.valor_total
                    ELSE 0::numeric
                END) AS valor_em_transito_risco,
            sum(
                CASE
                    WHEN NOT t.fatura_no_trimestre THEN t.valor_total
                    ELSE 0::numeric
                END) AS valor_fora_trimestre,
            count(*) FILTER (WHERE t.fatura_no_trimestre) AS pedidos_no_trimestre,
            count(*) FILTER (WHERE NOT t.fatura_no_trimestre) AS pedidos_fora_trimestre
           FROM v_des_pedidos_em_transito t
             LEFT JOIN snapshot s_1 ON s_1.empresa = t.empresa AND s_1.ano = t.ano_atual AND s_1.trimestre = t.trimestre_atual
          WHERE t.data_emissao > COALESCE(s_1.data_referencia, '1900-01-01'::date)
          GROUP BY t.empresa, t.ano_atual, t.trimestre_atual
        ), meta AS (
         SELECT des_meta_empresa.empresa,
            des_meta_empresa.ano,
            des_meta_empresa.trimestre,
            des_meta_empresa.meta_faturamento,
            des_meta_empresa.faixa_des_objetivo
           FROM des_meta_empresa
        )
 SELECT COALESCE(s.empresa, p.empresa, m.empresa) AS empresa,
    COALESCE(s.ano, p.ano, m.ano) AS ano,
    COALESCE(s.trimestre, p.trimestre, m.trimestre) AS trimestre,
    s.data_referencia AS gooddata_data_referencia,
    s.objetivo_valor AS gooddata_objetivo,
    s.fat_bruto_valor AS fat_bruto_confirmado,
    s.pedidos_abertos_valor AS gooddata_pedidos_abertos,
    m.meta_faturamento AS meta_pessoal,
    m.faixa_des_objetivo AS faixa_des_alvo,
    COALESCE(p.valor_em_transito_seguro, 0::numeric) AS valor_em_transito_seguro,
    COALESCE(p.valor_em_transito_risco, 0::numeric) AS valor_em_transito_risco,
    COALESCE(p.valor_fora_trimestre, 0::numeric) AS valor_fora_trimestre,
    COALESCE(p.pedidos_no_trimestre, 0::bigint) AS qtd_pedidos_no_trimestre,
    COALESCE(p.pedidos_fora_trimestre, 0::bigint) AS qtd_pedidos_fora_trimestre,
    round(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric), 2) AS posicao_ao_vivo_conservadora,
    round(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric) + COALESCE(p.valor_em_transito_risco, 0::numeric), 2) AS posicao_ao_vivo_otimista,
    ( SELECT row_to_json(r.*) AS row_to_json
           FROM ( SELECT des_determinar_faixa.faixa_id,
                    des_determinar_faixa.faixa_numero,
                    des_determinar_faixa.estrelas,
                    des_determinar_faixa.desconto_padrao_perc,
                    des_determinar_faixa.volume_min,
                    des_determinar_faixa.volume_max
                   FROM des_determinar_faixa(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric)) des_determinar_faixa(faixa_id, faixa_numero, estrelas, desconto_padrao_perc, volume_min, volume_max)) r) AS faixa_conservadora,
    ( SELECT row_to_json(r.*) AS row_to_json
           FROM ( SELECT des_determinar_faixa.faixa_id,
                    des_determinar_faixa.faixa_numero,
                    des_determinar_faixa.estrelas,
                    des_determinar_faixa.desconto_padrao_perc,
                    des_determinar_faixa.volume_min,
                    des_determinar_faixa.volume_max
                   FROM des_determinar_faixa(COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric) + COALESCE(p.valor_em_transito_risco, 0::numeric)) des_determinar_faixa(faixa_id, faixa_numero, estrelas, desconto_padrao_perc, volume_min, volume_max)) r) AS faixa_otimista,
    round(GREATEST(0::numeric, COALESCE(m.meta_faturamento, 0::numeric) - (COALESCE(s.fat_bruto_valor, 0::numeric) + COALESCE(p.valor_em_transito_seguro, 0::numeric))), 2) AS gap_para_meta_pessoal,
    (now() AT TIME ZONE 'America/Sao_Paulo')::date AS calculado_em,
    date_trunc('quarter'::text, now() AT TIME ZONE 'America/Sao_Paulo')::date AS inicio_trimestre,
    (date_trunc('quarter'::text, now() AT TIME ZONE 'America/Sao_Paulo') + '3 mons -1 days'::interval)::date AS fim_trimestre,
    (date_trunc('quarter'::text, now() AT TIME ZONE 'America/Sao_Paulo') + '3 mons -1 days'::interval)::date - (now() AT TIME ZONE 'America/Sao_Paulo')::date AS dias_restantes
   FROM snapshot s
     FULL JOIN pedidos_apos_snapshot p ON p.empresa = s.empresa AND p.ano = s.ano AND p.trimestre = s.trimestre
     FULL JOIN meta m ON m.empresa = COALESCE(s.empresa, p.empresa) AND m.ano = COALESCE(s.ano, p.ano) AND m.trimestre = COALESCE(s.trimestre, p.trimestre);

REVOKE ALL ON FUNCTION public.radar_kpis() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fin_projecao_13_semanas(text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_kpis() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fin_projecao_13_semanas(text, numeric) TO authenticated, service_role;

-- Pós-condição: o que ficou instalado é ESTE texto, com os atributos da prod, sem relógio da
-- sessão e com o fuso de SP escrito; as RPCs seguem fechadas para PUBLIC/anon e abertas para
-- authenticated; as views seguem security_invoker.
DO $post$
DECLARE
  r record;
  v_oid oid;
  v_md5 text;
  v_src text;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('public.radar_kpis()', 'e69f32d0ff27e1e128408174dc4aff0d', 'v'::"char"),
      ('public.fin_projecao_13_semanas(text,numeric)', '48f7ceb8457b16304f04c4b7c14c57c6', 's'::"char")
    ) AS x(alvo, este, volatilidade)
  LOOP
    v_oid := to_regprocedure(r.alvo);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'POS1 FALHOU: % não existe — a tela que a chama quebraria', r.alvo;
    END IF;
    SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO v_src FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
    v_md5 := md5(btrim(regexp_replace(v_src, '\s+', ' ', 'g')));
    IF v_md5 <> r.este THEN
      RAISE EXCEPTION 'POS2 FALHOU: o corpo instalado de % (md5 normalizado %) não é o desta migration', r.alvo, v_md5;
    END IF;
    IF v_src ~* '\mcurrent_date\M|\mlocaltimestamp\M|date_trunc\s*\(\s*''[a-z]+''\s*,\s*now\s*\(\s*\)\s*\)'
       OR position('America/Sao_Paulo' IN v_src) = 0 THEN
      RAISE EXCEPTION 'POS3 FALHOU: % ainda lê o relógio da sessão, ou perdeu o fuso de SP', r.alvo;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                    WHERE p.oid = v_oid AND p.prosecdef AND p.provolatile = r.volatilidade
                      AND p.proconfig = ARRAY['search_path=public']
                      AND pg_catalog.pg_get_userbyid(p.proowner) = 'postgres') THEN
      RAISE EXCEPTION 'POS4 FALHOU: % mudou de atributo — esperado SECURITY DEFINER, volatilidade %, search_path=public, dono postgres', r.alvo, r.volatilidade;
    END IF;
    IF pg_catalog.has_function_privilege('anon', v_oid, 'EXECUTE')
       OR pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'POS5 FALHOU: ACL de % — tem de ser fechada para PUBLIC/anon e aberta para authenticated', r.alvo;
    END IF;
  END LOOP;

  FOR r IN
    SELECT * FROM (VALUES
      ('public.v_des_pedidos_em_transito', '131754f42dbb24105f018ca65ca946cf'),
      ('public.v_des_posicao_trimestre_ao_vivo', '62b43b598d57342dde8c87f857421746')
    ) AS x(alvo, este)
  LOOP
    v_oid := to_regclass(r.alvo);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'POS6 FALHOU: % não existe — a posição DES quebraria', r.alvo;
    END IF;
    v_src := pg_catalog.pg_get_viewdef(v_oid, true);
    v_md5 := md5(btrim(regexp_replace(v_src, '\s+', ' ', 'g')));
    IF v_md5 <> r.este THEN
      RAISE EXCEPTION 'POS7 FALHOU: a definição instalada de % (md5 normalizado %) não é a desta migration', r.alvo, v_md5;
    END IF;
    IF v_src ~* '\mcurrent_date\M|\mlocaltimestamp\M' OR position('America/Sao_Paulo' IN v_src) = 0 THEN
      RAISE EXCEPTION 'POS8 FALHOU: % ainda lê o relógio da sessão, ou perdeu o fuso de SP', r.alvo;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c, unnest(c.reloptions) o
                    WHERE c.oid = v_oid AND lower(o) IN ('security_invoker=on', 'security_invoker=true')) THEN
      RAISE EXCEPTION 'POS9 FALHOU: % perdeu security_invoker — passaria a ler como dono, sem RLS', r.alvo;
    END IF;
  END LOOP;
END
$post$;
