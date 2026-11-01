-- Raio-X do estoque parado: LIQUIDAR SÓ O INEQUÍVOCO (Frente C da leva Oben PME/PMR; decisão do founder 2026-10-31:
-- "agora, só o inequívoco"). Spec: docs/superpowers/specs/2026-10-31-oben-pme-pmr-plano-design.md §4 (Frente C) +
-- docs/historico/raio-x-inequivoco.md (desenho pós-Codex: 6 P0 absorvidos).
-- Money-path. ⚠️ NÃO auto-aplica (nome custom) — aplicar via `bun run db:aplicar` (a transação é do executor: este arquivo NÃO leva BEGIN/COMMIT; para o SQL Editor, envolver em BEGIN; … COMMIT;). Depende das migrations
-- 20261016120000 (raio_x_decisao/decidir), 20261031130000 (medicao v2) e 20261031180000 (planejar) JÁ aplicadas.
-- Prova PG17: db/test-raio-x-inequivoco.sh (fixtures com UM impedimento cada + falsificações).
--
-- O que muda:
--   1. RPC NOVA raio_x_inequivoco(p_empresa, p_sku DEFAULT NULL) — INVOKER, gate cap_custo_ler. A REGRA INTEIRA no servidor
--      (nada de AND no React): SKU com saldo>0 é INEQUÍVOCO quando NENHUM impedimento vale; motivos_espera lista TODOS os
--      que valem (não só o primeiro). Desconhecido fica aguardando (sem NF, fonte de consumo velha, cadastro incompleto).
--        consumo 365d = v_sku_demanda_efetiva (venda + explosão PCP + substituição) — não só venda direta;
--        parado = consumo 0 OU cobertura > 365d; não corante (Concentrados LC); sem ENTRADA em 90d por 3 evidências
--        (recebimento real sku_leadtime_history.t4_data_recebimento, NF de entrada do armazém, observação do cmc_ledger —
--        qualquer uma segura: precisão > recall); não cold-start; não substituído; não cadastro recente (<90d);
--        mercadoria pelo SERVIDOR (classe giro, não 01/03/07/08/09/99, famílias/descrições de uso e consumo e
--        não-mercadoria do Raio-X, manual em raio_x_classificacao_manual vence); unidade da venda ≠ do estoque e
--        insumo com ficha em quarentena (consumo explodido invisível) AGUARDAM.
--      Devolve também qtd_liquidavel (saldo − 90 dias de consumo: liquidar não pode zerar quem ainda gira) e revisar_em.
--   2. raio_x_decidir: destino 'liquidar' NOVO (destino mudou) exige inequívoco → senão RX004, nada escrito. Re-salvar uma
--      liquidação já decidida (observação, fornecedor) continua passando. Mesma assinatura; PRE confere o corpo vivo.
--   3. raio_x_decisao ganha frete_estimado, desconto_sobre_medio_pct, margem_unit, preco_medio_base, cmc_base (congelados
--      ao planejar: bases e resultado da versão aprovada) e troca_contrapartida ('giro'|'encalhe': troca por outro encalhe
--      NÃO conta como liberado). raio_x_planejar ganha p_frete e p_troca_contrapartida com DEFAULT-sentinela (-1 /
--      'manter' = preservar o gravado: o cliente ANTIGO de 8 argumentos resolve nesta função sem apagar o que não
--      conhece; cliente novo manda NULL para limpar). Bases do desconto/margem só se releem quando o PISO muda.
--      Assinatura velha DROPADA, ACL reemitida.
--   4. raio_x_medicao devolve troca_contrapartida (coluna nova no fim; DROP+CREATE, ACL reemitida).
-- Não entregue aqui (registrado como follow-up): "caixa líquido RECEBIDO" por SKU (título → baixa) — a medição segue
-- sendo estoque reduzido a custo + receita faturada, rotulada como tal.


-- ── 1) raio_x_inequivoco ─────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.raio_x_inequivoco(p_empresa text, p_sku bigint DEFAULT NULL)
RETURNS TABLE (
  sku_codigo_omie bigint, inequivoco boolean, motivos_espera text[],
  consumo_365 numeric, cobertura_dias numeric, ultima_entrada date, cold_start boolean, substituido boolean,
  corante boolean, cadastro_recente boolean, mercadoria_servidor boolean, qtd_liquidavel numeric, revisar_em date,
  fonte_ok boolean)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  c_cobertura_dias CONSTANT int := 365;
  c_entrada_dias   CONSTANT int := 90;
  c_cadastro_dias  CONSTANT int := 90;
  c_preservar_dias CONSTANT int := 90;
  v_est  text;
  v_vnd  text;
  v_wh   text;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_min  date;
  v_max  date;
  v_fonte boolean := false;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_STAFF' USING ERRCODE = '42501';
  END IF;
  CASE p_empresa
    WHEN 'oben'    THEN v_est := 'oben';           v_vnd := 'OBEN'; v_wh := 'OB';
    WHEN 'colacor' THEN v_est := 'colacor_vendas'; v_vnd := NULL;   v_wh := 'CC';
    ELSE RAISE EXCEPTION 'RAIO_X_EMPRESA_INVALIDA: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END CASE;
  -- Fonte de consumo confiável (régua da fin_ciclo_giro_sku §5.4-1): NF-e da empresa com ≥330d de histórico e ≤7d de atraso.
  IF v_vnd IS NOT NULL THEN
    SELECT min(v.data_emissao), max(v.data_emissao) INTO v_min, v_max FROM public.venda_items_history v WHERE v.empresa = v_vnd;
    v_fonte := v_max IS NOT NULL AND v_min <= v_hoje - 330 AND v_max >= v_hoje - 7;
  END IF;

  RETURN QUERY
  WITH e AS (
    SELECT x.* FROM (
      SELECT DISTINCT ON (ip.omie_codigo_produto) ip.omie_codigo_produto::bigint AS sku, ip.saldo
        FROM public.inventory_position ip
       WHERE ip.account = v_est AND (p_sku IS NULL OR ip.omie_codigo_produto = p_sku)
       ORDER BY ip.omie_codigo_produto, ip.synced_at DESC NULLS LAST) x
    WHERE x.saldo > 0),
  p AS (
    SELECT e.sku, op.tipo_produto, op.familia, op.descricao, op.unidade, (op.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS cad,
           (op.omie_codigo_produto IS NOT NULL) AS tem_cadastro
      FROM e
      LEFT JOIN LATERAL (SELECT o.* FROM public.omie_products o
                          WHERE o.omie_codigo_produto = e.sku AND o.account = p_empresa
                          ORDER BY o.created_at DESC NULLS LAST LIMIT 1) op ON true),
  dem AS MATERIALIZED (
    -- unidade da venda ≠ unidade do estoque (CX × UN): a cobertura em unidades mistas MENTE → aguarda (Codex P1-2)
    SELECT d.sku_codigo_omie AS sku, sum(d.quantidade) AS q365,
           bool_or(d.sku_unidade IS NOT NULL AND p.unidade IS NOT NULL
                   AND upper(trim(d.sku_unidade)) IS DISTINCT FROM upper(trim(p.unidade))) AS un_divergente
      FROM public.v_sku_demanda_efetiva d
      LEFT JOIN p ON p.sku = d.sku_codigo_omie
     WHERE v_fonte AND d.empresa = v_vnd AND d.data_emissao >= v_hoje - 365
       AND (p_sku IS NULL OR d.sku_codigo_omie = p_sku)
     GROUP BY d.sku_codigo_omie),
  -- insumo cuja ficha está em QUARENTENA (perda > 0, unidade divergente, pai ambíguo): o consumo explodido some da view e
  -- viraria "zero" — desconhecido AGUARDA (Codex P1-3)
  qua AS (
    SELECT DISTINCT q.comp_oben AS sku FROM public.v_pcp_malha_oben_quarentena q
     WHERE p_empresa = 'oben' AND q.comp_oben IS NOT NULL AND (p_sku IS NULL OR q.comp_oben = p_sku)),
  -- ENTRADA: 3 evidências; a mais recente vale. Qualquer uma recente SEGURA (precisão > recall para liquidar).
  ent AS (
    SELECT z.sku, max(z.dt) AS ultima FROM (
      SELECT slh.sku_codigo_omie::bigint AS sku, slh.t4_data_recebimento::date AS dt
        FROM public.sku_leadtime_history slh
       WHERE v_vnd IS NOT NULL AND slh.empresa::text = v_vnd AND slh.quantidade_recebida > 0 AND slh.t4_data_recebimento IS NOT NULL   -- empresa é ENUM empresa_reposicao (Codex P1-1)
      UNION ALL
      SELECT ri.produto_omie_id, r.data_emissao::date
        FROM public.nfe_recebimento_itens ri
        JOIN public.nfe_recebimentos r ON r.id = ri.nfe_recebimento_id
        JOIN public.warehouses w ON w.id = r.warehouse_id
       WHERE w.code = v_wh AND ri.produto_omie_id IS NOT NULL
      UNION ALL
      SELECT cl.omie_codigo_produto, (cl.observed_at AT TIME ZONE 'America/Sao_Paulo')::date
        FROM public.cmc_ledger cl
       WHERE cl.account = CASE p_empresa WHEN 'oben' THEN 'vendas' ELSE 'colacor_vendas' END
    ) z
    WHERE (p_sku IS NULL OR z.sku = p_sku)
    GROUP BY z.sku),
  man AS (
    SELECT m.sku_codigo_omie AS sku, m.categoria FROM public.raio_x_classificacao_manual m WHERE m.empresa = p_empresa),
  base AS (
    SELECT p.sku, e.saldo, p.tipo_produto, p.familia, p.descricao, p.cad, p.tem_cadastro,
           dm.q365, coalesce(dm.un_divergente, false) AS un_divergente, (qua.sku IS NOT NULL) AS em_quarentena,
           CASE WHEN dm.q365 > 0 THEN round(e.saldo / (dm.q365 / 365.0), 1) END AS cob,
           ent.ultima,
           coalesce((SELECT sp.parametro_cold_start FROM public.sku_parametros sp
                      WHERE sp.empresa = v_vnd AND sp.sku_codigo_omie = p.sku LIMIT 1), false) AS cold,
           EXISTS (SELECT 1 FROM public.sku_substituicao ss
                    WHERE ss.empresa = v_vnd AND ss.sku_codigo_antigo = p.sku::text AND ss.status = 'aplicada') AS subst,
           (coalesce(p.familia, '') = 'Concentrados LC' AND coalesce(p.descricao, '') !~* '^AT[LP]') AS corante,
           (p.cad IS NOT NULL AND p.cad >= v_hoje - c_cadastro_dias) AS cad_recente,
           man.categoria AS manual,
           -- mercadoria pelo servidor = classe giro, não industrial (01/03), não uso e consumo/não-mercadoria do Raio-X
           (public._fin_estoque_classe(p.tipo_produto, p.familia) = 'giro'
             AND trim(coalesce(p.tipo_produto, '')) NOT IN ('01', '03')
             AND coalesce(p.familia, '') NOT IN ('Material de Uso e Consumo', 'Concentrados MixMachine', 'Imobilizado')
             AND coalesce(p.descricao, '') !~* '(MAQUINA|ESPECTRO|SOFTWARE|MOSTRUARIO|CARTELA|EXPOSITOR|DISPLAY|1000 ?KG)'
             AND NOT (coalesce(p.familia, '') = 'Concentrados LC' AND coalesce(p.descricao, '') ~* '^AT[LP]')) AS merc_regra
      FROM p
      JOIN e ON e.sku = p.sku
      LEFT JOIN dem dm ON dm.sku = p.sku
      LEFT JOIN qua ON qua.sku = p.sku
      LEFT JOIN ent ON ent.sku = p.sku
      LEFT JOIN man ON man.sku = p.sku),
  cls AS (
    -- classificação manual (raio_x_classificacao_manual) VENCE a regra; a regra é a do servidor, uma só vez
    SELECT b.*, CASE WHEN b.manual IS NOT NULL THEN b.manual = 'mercadoria' ELSE b.merc_regra END AS merc
      FROM base b),
  calc AS (
    SELECT b.*,
           ARRAY_REMOVE(ARRAY[
             CASE WHEN v_vnd IS NULL THEN 'sem_nf' END,
             CASE WHEN v_vnd IS NOT NULL AND NOT v_fonte THEN 'fonte_consumo_desatualizada' END,
             CASE WHEN NOT b.tem_cadastro OR nullif(trim(b.tipo_produto), '') IS NULL THEN 'cadastro_incompleto' END,
             CASE WHEN b.tem_cadastro AND nullif(trim(b.tipo_produto), '') IS NOT NULL AND NOT b.merc THEN 'nao_mercadoria' END,
             CASE WHEN v_fonte AND b.q365 > 0 AND b.cob <= c_cobertura_dias THEN 'cobertura_abaixo_365' END,
             CASE WHEN b.un_divergente THEN 'unidade_divergente' END,
             CASE WHEN b.em_quarentena THEN 'insumo_em_quarentena' END,
             CASE WHEN b.corante THEN 'corante' END,
             CASE WHEN b.ultima IS NOT NULL AND b.ultima >= v_hoje - c_entrada_dias THEN 'entrada_recente' END,
             CASE WHEN b.cold THEN 'cold_start' END,
             CASE WHEN b.subst THEN 'substituido' END,
             CASE WHEN b.cad_recente THEN 'cadastro_recente' END
           ]::text[], NULL) AS motivos
      FROM cls b)
  SELECT c.sku,
         (cardinality(c.motivos) = 0),
         c.motivos,
         CASE WHEN v_fonte THEN coalesce(c.q365, 0) END,
         CASE WHEN v_fonte THEN c.cob END,
         c.ultima,
         c.cold, c.subst, c.corante, c.cad_recente, c.merc,
         CASE WHEN cardinality(c.motivos) = 0
              THEN greatest(0, c.saldo - coalesce(c.q365, 0) / 365.0 * c_preservar_dias) END,
         CASE WHEN c.ultima IS NOT NULL AND c.ultima >= v_hoje - c_entrada_dias THEN c.ultima + c_entrada_dias END,
         v_fonte
    FROM calc c
   ORDER BY c.sku;
END
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_inequivoco(text, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_inequivoco(text, bigint) TO authenticated;

-- ── 2) raio_x_decidir: liquidar NOVO só no inequívoco (RX004). Mesma assinatura; PRE confere o corpo vivo. ──────
DO $pre$
DECLARE v text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.raio_x_decidir(text,bigint,text,text,text,text,numeric,boolean,boolean)'));
BEGIN
  IF v IS NULL OR v NOT IN ('3f803bd3688db22599f18856e32c317e', '307b5777d524849ddd821abe94f5b538') THEN
    RAISE EXCEPTION 'PRE FALHOU: raio_x_decidir vivo (md5 %) não é o da 20261016120000 nem o desta migration — reconcilie antes', v;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.raio_x_decidir(
  p_empresa text, p_sku bigint, p_destino text, p_categoria text, p_observacao text, p_fornecedor text,
  p_credito_troca numeric, p_tirar_do_motor boolean, p_restaurar_motor boolean)
RETURNS public.raio_x_decisao
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid       uuid := auth.uid();
  v_est       text;
  v_sp_emp    text;
  v_tirar     boolean := coalesce(p_tirar_do_motor, false);
  v_restaurar boolean := coalesce(p_restaurar_motor, false);
  v_old       public.raio_x_decisao%ROWTYPE;
  v_mudou     boolean;
  v_alvo      text;
  v_sp_tipo   text;
  v_sp_hab    boolean;
  v_mexer     boolean := false;
  v_sp_achou  boolean;
  v_foto      boolean := false;
  v_ip_saldo  numeric;
  v_ip_cmc    numeric;
  v_cmc       numeric;
  v_n_tirar   int;
  v_n_rest    int;
  v_row       public.raio_x_decisao%ROWTYPE;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_CUSTO' USING ERRCODE = '42501';
  END IF;

  -- ---- validacao (nada e escrito antes daqui) ----
  CASE p_empresa
    WHEN 'oben'    THEN v_est := 'oben';    v_sp_emp := 'OBEN';
    WHEN 'colacor' THEN v_est := 'colacor_vendas'; v_sp_emp := NULL;
    ELSE RAISE EXCEPTION 'raio_x: empresa invalida: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END CASE;
  IF p_sku IS NULL THEN
    RAISE EXCEPTION 'raio_x: sku nulo' USING ERRCODE = '22023';
  END IF;
  IF p_destino IS NOT NULL AND p_destino NOT IN
     ('trocar','venda_dirigida','liquidar','manter_suspender_recompra','estrategico','erro_cadastro') THEN
    RAISE EXCEPTION 'raio_x: destino invalido: %', p_destino USING ERRCODE = '22023';
  END IF;
  IF p_categoria IS NOT NULL AND p_categoria NOT IN ('nao_mercadoria','uso_consumo','mercadoria') THEN
    RAISE EXCEPTION 'raio_x: categoria invalida: %', p_categoria USING ERRCODE = '22023';
  END IF;
  IF v_tirar AND v_restaurar THEN
    RAISE EXCEPTION 'raio_x: tirar e restaurar na mesma chamada' USING ERRCODE = '22023';
  END IF;
  v_alvo := CASE p_destino WHEN 'trocar' THEN 'descontinuado' WHEN 'liquidar' THEN 'descontinuado'
                           WHEN 'manter_suspender_recompra' THEN 'sob_encomenda' END;
  IF v_tirar AND v_alvo IS NULL THEN
    RAISE EXCEPTION 'raio_x: tirar do motor exige destino trocar, liquidar ou manter_suspender_recompra'
      USING ERRCODE = '22023';
  END IF;

  IF p_destino IS NOT NULL AND p_categoria IS NULL THEN
    RAISE EXCEPTION 'raio_x: categoria obrigatoria com destino' USING ERRCODE = '22023';
  END IF;
  IF p_credito_troca < 0 THEN
    RAISE EXCEPTION 'raio_x: credito_troca negativo: %', p_credito_troca USING ERRCODE = '22023';
  END IF;
  -- R18: NaN e maior que tudo no numeric do Postgres; o `< 0` nao pega.
  IF p_credito_troca = 'NaN'::numeric THEN
    RAISE EXCEPTION 'raio_x: credito_troca invalido: %', p_credito_troca USING ERRCODE = '22023';
  END IF;

  -- Linha-base primeiro e trava (R14): duas 1as decisoes concorrentes serializam aqui, e a 2a ja ve a foto
  -- da 1a. Tudo abaixo (foto, decidido_em, motor) deriva da linha TRAVADA. Erro adiante desfaz a linha-base.
  INSERT INTO public.raio_x_decisao (empresa, sku_codigo_omie) VALUES (p_empresa, p_sku)
  ON CONFLICT (empresa, sku_codigo_omie) DO NOTHING;
  SELECT * INTO v_old FROM public.raio_x_decisao d
   WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku FOR UPDATE;
  IF v_restaurar AND v_old.motor_antes IS NULL THEN
    RAISE EXCEPTION 'raio_x: nada a restaurar (%/%)', p_empresa, p_sku USING ERRCODE = '22023';
  END IF;

  v_mudou := (v_old.destino IS DISTINCT FROM p_destino);

  -- [RX004] Liquidar NOVO só no INEQUÍVOCO (decisão do founder 2026-10-31: "agora, só o inequívoco"). A regra é a
  -- de raio_x_inequivoco (servidor), nunca uma confirmação do React: chamada direta cai aqui igual. Re-salvar uma
  -- liquidação já decidida (destino não mudou) segue — o que já foi liquidado antes desta regra não vira órfão.
  IF p_destino = 'liquidar' AND v_mudou
     AND NOT EXISTS (SELECT 1 FROM public.raio_x_inequivoco(p_empresa, p_sku) q WHERE q.inequivoco) THEN
    RAISE EXCEPTION 'raio_x: liquidar so no inequivoco (%/%)', p_empresa, p_sku USING ERRCODE = 'RX004';
  END IF;

  -- Estado atual do motor (trava a linha). Sem linha -> RX001 JA (R13): nunca gravar motor_antes de uma
  -- leitura vazia (uma linha inserida entre o SELECT e o UPDATE faria o restaurar apagar o estado real).
  -- (os marcadores [motor-sel:*] e [motor:*] delimitam o motor para a prova sabotar com um bloco que engole erro)
  -- [motor-sel:inicio]
  IF v_tirar THEN
    SELECT sp.tipo_reposicao, sp.habilitado_reposicao_automatica INTO v_sp_tipo, v_sp_hab
      FROM public.sku_parametros sp
     WHERE sp.empresa = v_sp_emp AND sp.sku_codigo_omie = p_sku FOR UPDATE;
    v_sp_achou := FOUND;
    IF NOT v_sp_achou THEN
      RAISE EXCEPTION 'raio_x: sku sem sku_parametros (%/%)', p_empresa, p_sku USING ERRCODE = 'RX001';
    END IF;
    -- Ja no alvo (false + mesmo tipo): nao escreve e nao marca tirou_do_motor.
    v_mexer := NOT (v_sp_hab IS NOT DISTINCT FROM false AND v_sp_tipo IS NOT DISTINCT FROM v_alvo);
  END IF;
  -- [motor-sel:fim]

  -- Foto: so na 1a decisao (foto_em is null) e com estoque presente; sem linha ou saldo NULL -> tudo NULL,
  -- tenta de novo depois.
  IF p_destino IS NOT NULL AND v_old.foto_em IS NULL THEN
    SELECT x.saldo, x.cmc INTO v_ip_saldo, v_ip_cmc FROM (
      SELECT DISTINCT ON (ip.omie_codigo_produto) ip.saldo, ip.cmc
        FROM public.inventory_position ip
       WHERE ip.account = v_est AND ip.omie_codigo_produto = p_sku
       ORDER BY ip.omie_codigo_produto, ip.synced_at DESC NULLS LAST) x;
    IF FOUND AND v_ip_saldo IS NOT NULL THEN
      v_foto := true;
      v_cmc := CASE WHEN v_ip_cmc > 0 THEN v_ip_cmc END;   -- ausente/zero != custo
    END IF;
  END IF;

  -- ---- escrita ----
  INSERT INTO public.raio_x_decisao AS r (
    empresa, sku_codigo_omie, destino, observacao, fornecedor_informado, credito_troca,
    decidido_por, decidido_em, foto_saldo, foto_cmc, foto_valor, foto_categoria, foto_em,
    tirou_do_motor, motor_antes, atualizado_em)
  VALUES (
    p_empresa, p_sku, p_destino, p_observacao, p_fornecedor, p_credito_troca,
    CASE WHEN p_destino IS NOT NULL THEN v_uid END, CASE WHEN p_destino IS NOT NULL THEN now() END,
    CASE WHEN v_foto THEN v_ip_saldo END, CASE WHEN v_foto THEN v_cmc END,
    CASE WHEN v_foto THEN v_ip_saldo * v_cmc END, CASE WHEN v_foto THEN p_categoria END,
    CASE WHEN v_foto THEN now() END,
    v_mexer,
    CASE WHEN v_mexer THEN jsonb_build_object('tipo_reposicao', v_sp_tipo, 'habilitado', v_sp_hab) END,
    now())
  ON CONFLICT (empresa, sku_codigo_omie) DO UPDATE SET
    destino              = EXCLUDED.destino,
    observacao           = EXCLUDED.observacao,
    fornecedor_informado = EXCLUDED.fornecedor_informado,
    credito_troca        = EXCLUDED.credito_troca,
    decidido_por   = CASE WHEN v_mudou THEN EXCLUDED.decidido_por ELSE r.decidido_por END,
    decidido_em    = CASE WHEN v_mudou THEN EXCLUDED.decidido_em  ELSE r.decidido_em  END,
    foto_saldo     = CASE WHEN v_foto AND r.foto_em IS NULL THEN EXCLUDED.foto_saldo     ELSE r.foto_saldo     END,
    foto_cmc       = CASE WHEN v_foto AND r.foto_em IS NULL THEN EXCLUDED.foto_cmc       ELSE r.foto_cmc       END,
    foto_valor     = CASE WHEN v_foto AND r.foto_em IS NULL THEN EXCLUDED.foto_valor     ELSE r.foto_valor     END,
    foto_categoria = CASE WHEN v_foto AND r.foto_em IS NULL THEN EXCLUDED.foto_categoria ELSE r.foto_categoria END,
    foto_em        = CASE WHEN v_foto AND r.foto_em IS NULL THEN EXCLUDED.foto_em        ELSE r.foto_em        END,
    tirou_do_motor = CASE WHEN v_mexer THEN true ELSE r.tirou_do_motor END,
    motor_antes    = coalesce(r.motor_antes, EXCLUDED.motor_antes),
    atualizado_em  = now();

  -- Foto protegida como CONJUNTO: so escreve foto_* se a linha atual ainda tem foto_em NULL (2a camada do R14).
  -- [motor:inicio]
  IF v_mexer THEN
    UPDATE public.sku_parametros sp
       SET tipo_reposicao = v_alvo, habilitado_reposicao_automatica = false
     WHERE sp.empresa = v_sp_emp AND sp.sku_codigo_omie = p_sku;
    GET DIAGNOSTICS v_n_tirar = ROW_COUNT;
    IF v_n_tirar = 0 THEN
      RAISE EXCEPTION 'raio_x: sku sem sku_parametros (%/%)', p_empresa, p_sku USING ERRCODE = 'RX001';
    END IF;
  END IF;
  -- [motor:fim]

  IF v_restaurar THEN
    UPDATE public.sku_parametros sp
       SET tipo_reposicao = v_old.motor_antes->>'tipo_reposicao',
           habilitado_reposicao_automatica = (v_old.motor_antes->>'habilitado')::boolean
     WHERE sp.empresa = v_sp_emp AND sp.sku_codigo_omie = p_sku;
    GET DIAGNOSTICS v_n_rest = ROW_COUNT;
    IF v_n_rest = 0 THEN
      RAISE EXCEPTION 'raio_x: sku sem sku_parametros (%/%)', p_empresa, p_sku USING ERRCODE = 'RX001';
    END IF;
    UPDATE public.raio_x_decisao d SET tirou_do_motor = false, motor_antes = NULL, atualizado_em = now()
     WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku;
  END IF;

  SELECT * INTO v_row FROM public.raio_x_decisao d WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku;
  RETURN v_row;
END
$fn$;

-- ── 3) Colunas do plano: frete, desconto sobre o médio, margem unitária (com as bases congeladas) e contrapartida da troca ──
ALTER TABLE public.raio_x_decisao
  ADD COLUMN IF NOT EXISTS frete_estimado           numeric,
  ADD COLUMN IF NOT EXISTS desconto_sobre_medio_pct numeric,
  ADD COLUMN IF NOT EXISTS margem_unit              numeric,
  ADD COLUMN IF NOT EXISTS preco_medio_base         numeric,
  ADD COLUMN IF NOT EXISTS cmc_base                 numeric,
  ADD COLUMN IF NOT EXISTS troca_contrapartida      text;
ALTER TABLE public.raio_x_decisao DROP CONSTRAINT IF EXISTS raio_x_decisao_frete_estimado_check;
ALTER TABLE public.raio_x_decisao ADD CONSTRAINT raio_x_decisao_frete_estimado_check
  CHECK (frete_estimado IS NULL OR (frete_estimado >= 0 AND frete_estimado <> 'NaN'::numeric));
ALTER TABLE public.raio_x_decisao DROP CONSTRAINT IF EXISTS raio_x_decisao_troca_contrapartida_check;
ALTER TABLE public.raio_x_decisao ADD CONSTRAINT raio_x_decisao_troca_contrapartida_check
  CHECK (troca_contrapartida IS NULL OR troca_contrapartida IN ('giro', 'encalhe'));
COMMENT ON COLUMN public.raio_x_decisao.desconto_sobre_medio_pct IS
  '1 - preco_piso/preco_medio_base, congelado ao planejar. É desconto COMERCIAL sobre o médio 12m — não deságio financeiro.';
COMMENT ON COLUMN public.raio_x_decisao.margem_unit IS 'preco_piso - cmc_base (por unidade), congelado ao planejar. NULL sem cmc.';
COMMENT ON COLUMN public.raio_x_decisao.troca_contrapartida IS
  'O que entra no lugar na troca: giro (produto que vende) ou encalhe (outro parado — NÃO conta como liberado). NULL = não informado.';

-- ── 4) raio_x_planejar com frete e contrapartida (DROP da assinatura velha: o cliente de 8 args resolve nesta pelos DEFAULTs) ──
DROP FUNCTION IF EXISTS public.raio_x_planejar(text, bigint, numeric, text, uuid, date, boolean, timestamptz);
CREATE OR REPLACE FUNCTION public.raio_x_planejar(
  p_empresa text, p_sku bigint, p_preco_piso numeric, p_canal text, p_responsavel uuid, p_prazo date,
  p_concluido boolean, p_atualizado_em timestamptz, p_frete numeric DEFAULT -1, p_troca_contrapartida text DEFAULT 'manter')
RETURNS public.raio_x_decisao
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_old public.raio_x_decisao%ROWTYPE;
  v_row public.raio_x_decisao%ROWTYPE;
  v_est text;
  v_vnd text;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_pm12 numeric;
  v_cmc numeric;
  -- DEFAULTs-sentinela = "manter o gravado": o cliente ANTIGO (8 args) não pode apagar frete/contrapartida que não conhece
  -- (Codex P2-5). Cliente novo manda NULL explícito para limpar.
  v_frete numeric;
  v_contra text;
  v_recalc boolean;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_CUSTO' USING ERRCODE = '42501';
  END IF;
  IF p_empresa IS NULL OR p_empresa NOT IN ('oben','colacor') THEN
    RAISE EXCEPTION 'raio_x: empresa invalida: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END IF;
  v_est := CASE p_empresa WHEN 'oben' THEN 'oben' ELSE 'colacor_vendas' END;
  v_vnd := CASE p_empresa WHEN 'oben' THEN 'OBEN' END;
  IF p_sku IS NULL THEN
    RAISE EXCEPTION 'raio_x: sku obrigatorio' USING ERRCODE = '22023';
  END IF;
  IF p_concluido IS NULL THEN
    RAISE EXCEPTION 'raio_x: concluido obrigatorio' USING ERRCODE = '22023';
  END IF;
  IF p_preco_piso < 0 THEN
    RAISE EXCEPTION 'raio_x: preco_piso negativo: %', p_preco_piso USING ERRCODE = '22023';
  END IF;
  IF p_preco_piso = 'NaN'::numeric THEN
    RAISE EXCEPTION 'raio_x: preco_piso invalido: %', p_preco_piso USING ERRCODE = '22023';
  END IF;
  IF p_frete < 0 AND p_frete IS DISTINCT FROM -1 THEN
    RAISE EXCEPTION 'raio_x: frete negativo: %', p_frete USING ERRCODE = '22023';
  END IF;
  IF p_frete = 'NaN'::numeric OR p_frete = 'Infinity'::numeric THEN
    RAISE EXCEPTION 'raio_x: frete invalido: %', p_frete USING ERRCODE = '22023';
  END IF;
  IF p_canal IS NOT NULL AND p_canal NOT IN ('cliente_especifico','promocao_carteira','outlet_queima','outro') THEN
    RAISE EXCEPTION 'raio_x: canal invalido: %', p_canal USING ERRCODE = '22023';
  END IF;
  IF p_troca_contrapartida IS NOT NULL AND p_troca_contrapartida NOT IN ('giro', 'encalhe', 'manter') THEN
    RAISE EXCEPTION 'raio_x: contrapartida invalida: %', p_troca_contrapartida USING ERRCODE = '22023';
  END IF;
  IF p_responsavel IS NOT NULL
     AND NOT (public.has_role(p_responsavel, 'employee') OR public.has_role(p_responsavel, 'master')) THEN
    RAISE EXCEPTION 'raio_x: responsavel nao e da equipe' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_old FROM public.raio_x_decisao d
   WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku FOR UPDATE;
  -- [rx002:inicio]
  IF NOT FOUND OR v_old.destino IS NULL THEN
    RAISE EXCEPTION 'raio_x: sem decisao para planejar (sku %)', p_sku USING ERRCODE = 'RX002';
  END IF;
  -- [rx002:fim]
  -- Concorrência otimista: o cliente manda o atualizado_em que EDITOU. Outro operador gravou no meio (decidir,
  -- contar ou planejar) → RX003, nada escrito: o estado completo velho não sobrescreve o novo em silêncio.
  IF v_old.atualizado_em IS DISTINCT FROM p_atualizado_em THEN
    RAISE EXCEPTION 'raio_x: decisao mudou desde a leitura (sku %)', p_sku USING ERRCODE = 'RX003';
  END IF;
  v_frete  := CASE WHEN p_frete IS NOT DISTINCT FROM -1 THEN v_old.frete_estimado ELSE p_frete END;
  v_contra := CASE WHEN p_troca_contrapartida IS NOT DISTINCT FROM 'manter' THEN v_old.troca_contrapartida ELSE p_troca_contrapartida END;
  IF v_old.destino <> 'liquidar' AND (p_preco_piso IS NOT NULL OR p_canal IS NOT NULL OR v_frete IS NOT NULL) THEN
    RAISE EXCEPTION 'raio_x: piso, canal e frete so no destino liquidar (destino %)', v_old.destino USING ERRCODE = '22023';
  END IF;
  IF v_old.destino <> 'trocar' AND v_contra IS NOT NULL THEN
    RAISE EXCEPTION 'raio_x: contrapartida so no destino trocar (destino %)', v_old.destino USING ERRCODE = '22023';
  END IF;

  -- Bases CONGELADAS da versão aprovada (preço médio 12m faturado e CMC atual): só se (re)leem quando o PISO muda ou
  -- ainda não há base — editar só responsável/prazo amanhã NÃO reescreve o histórico (Codex P1-4). Sem médio (0 venda
  -- em 12m) o desconto é DESCONHECIDO (NULL), nunca 0.
  v_recalc := p_preco_piso IS NOT NULL AND (p_preco_piso IS DISTINCT FROM v_old.preco_piso OR (v_old.preco_medio_base IS NULL AND v_old.cmc_base IS NULL));
  IF v_old.destino = 'liquidar' AND p_preco_piso IS NOT NULL AND NOT v_recalc THEN
    v_pm12 := v_old.preco_medio_base;
    v_cmc := v_old.cmc_base;
  END IF;
  IF v_old.destino = 'liquidar' AND v_recalc THEN
    IF v_vnd IS NOT NULL THEN
      SELECT sum(h.valor_total) / nullif(sum(h.quantidade), 0) INTO v_pm12
        FROM public.v_venda_items_history_efetivo h
       WHERE h.empresa = v_vnd AND h.sku_codigo_omie = p_sku AND h.data_emissao >= v_hoje - 365;
    END IF;
    SELECT x.cmc INTO v_cmc FROM (
      SELECT DISTINCT ON (ip.omie_codigo_produto) ip.cmc FROM public.inventory_position ip
       WHERE ip.account = v_est AND ip.omie_codigo_produto = p_sku
       ORDER BY ip.omie_codigo_produto, ip.synced_at DESC NULLS LAST) x;
    v_cmc := CASE WHEN v_cmc > 0 THEN v_cmc END;
  END IF;

  UPDATE public.raio_x_decisao d SET
    preco_piso       = p_preco_piso,
    canal_liquidacao = p_canal,
    frete_estimado   = v_frete,
    preco_medio_base = CASE WHEN p_preco_piso IS NOT NULL THEN round(v_pm12::numeric, 4) END,
    cmc_base         = CASE WHEN p_preco_piso IS NOT NULL THEN v_cmc END,
    desconto_sobre_medio_pct = CASE WHEN p_preco_piso IS NOT NULL AND v_pm12 > 0 THEN round(1 - p_preco_piso / v_pm12, 4) END,
    margem_unit      = CASE WHEN p_preco_piso IS NOT NULL AND v_cmc IS NOT NULL THEN round(p_preco_piso - v_cmc, 4) END,
    troca_contrapartida = v_contra,
    responsavel      = p_responsavel,
    prazo            = p_prazo,
    -- re-salvar "executado" VIGENTE não move data nem autor; executado de antes do destino atual
    -- (concluido_em < decidido_em) é de outra decisão: marcar de novo registra a nova execução.
    concluido_em     = CASE WHEN p_concluido THEN
                         CASE WHEN d.concluido_em IS NOT NULL AND (d.decidido_em IS NULL OR d.concluido_em >= d.decidido_em)
                              THEN d.concluido_em ELSE now() END END,
    concluido_por    = CASE WHEN p_concluido THEN
                         CASE WHEN d.concluido_em IS NOT NULL AND (d.decidido_em IS NULL OR d.concluido_em >= d.decidido_em)
                              THEN d.concluido_por ELSE auth.uid() END END,
    atualizado_em    = now()
   WHERE d.empresa = p_empresa AND d.sku_codigo_omie = p_sku
  RETURNING d.* INTO v_row;
  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_planejar(text, bigint, numeric, text, uuid, date, boolean, timestamptz, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_planejar(text, bigint, numeric, text, uuid, date, boolean, timestamptz, numeric, text) TO authenticated;

-- ── 5) raio_x_medicao devolve troca_contrapartida (coluna no FIM; DROP+CREATE, ACL reemitida) ───────────────────
DROP FUNCTION IF EXISTS public.raio_x_medicao(text);
CREATE FUNCTION public.raio_x_medicao(p_empresa text)
RETURNS TABLE (
  sku_codigo_omie bigint, destino text, decidido_em timestamptz,
  foto_saldo numeric, foto_cmc numeric, foto_valor numeric, foto_categoria text, credito_troca numeric,
  saldo_atual numeric, qtd_vendida numeric, receita numeric, preco_medio_12m numeric,
  compras_apos timestamptz[], troca_contrapartida text)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  v_est  text;
  v_vnd  text;
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF NOT private.cap_custo_ler(auth.uid()) THEN
    RAISE EXCEPTION 'RAIO_X_SO_STAFF' USING ERRCODE = '42501';
  END IF;

  CASE p_empresa
    WHEN 'oben'    THEN v_est := 'oben';           v_vnd := 'OBEN';
    WHEN 'colacor' THEN v_est := 'colacor_vendas'; v_vnd := NULL;
    ELSE RAISE EXCEPTION 'RAIO_X_EMPRESA_INVALIDA: %', coalesce(p_empresa, '<null>') USING ERRCODE = '22023';
  END CASE;

  RETURN QUERY
  WITH d AS (
    SELECT x.sku_codigo_omie AS sku, x.destino, x.decidido_em, x.foto_saldo, x.foto_cmc, x.foto_valor,
           x.foto_categoria, x.credito_troca, x.troca_contrapartida,
           (x.foto_em AT TIME ZONE 'America/Sao_Paulo')::date AS dia   -- NULL sem foto
      FROM public.raio_x_decisao x
     WHERE x.empresa = p_empresa AND x.destino IS NOT NULL),
  e AS (
    SELECT DISTINCT ON (ip.omie_codigo_produto) ip.omie_codigo_produto::bigint AS sku, ip.saldo
      FROM public.inventory_position ip
     WHERE ip.account = v_est
     ORDER BY ip.omie_codigo_produto, ip.synced_at DESC NULLS LAST),
  vh AS (
    SELECT h.sku_codigo_omie AS sku, h.data_emissao, h.quantidade, h.valor_total
      FROM public.v_venda_items_history_efetivo h
     WHERE v_vnd IS NOT NULL AND h.empresa = v_vnd),
  v AS (
    SELECT d.sku,
           coalesce(sum(vh.quantidade)  FILTER (WHERE vh.data_emissao > d.dia), 0) AS qtd,
           coalesce(sum(vh.valor_total) FILTER (WHERE vh.data_emissao > d.dia), 0) AS rec,
           sum(vh.valor_total) FILTER (WHERE vh.data_emissao >= v_hoje - 365)
             / nullif(sum(vh.quantidade) FILTER (WHERE vh.data_emissao >= v_hoje - 365), 0) AS pm12
      FROM d JOIN vh ON vh.sku = d.sku
     GROUP BY d.sku),
  c AS (
    SELECT d.sku, array_agg(i.criado_em ORDER BY i.criado_em) AS compras
      FROM d
      JOIN public.pedido_compra_item i ON i.sku_codigo_omie = d.sku::text
      JOIN public.pedido_compra_sugerido pc ON pc.id = i.pedido_id
     WHERE p_empresa = 'oben' AND pc.empresa = 'OBEN'
       AND pc.status IN ('disparado','split_em_filhos')
       AND i.criado_em > d.decidido_em
     GROUP BY d.sku)
  SELECT d.sku, d.destino, d.decidido_em, d.foto_saldo, d.foto_cmc, d.foto_valor, d.foto_categoria, d.credito_troca,
         e.saldo,
         CASE WHEN v_vnd IS NULL OR d.dia IS NULL THEN NULL::numeric ELSE coalesce(v.qtd, 0) END,
         CASE WHEN v_vnd IS NULL OR d.dia IS NULL THEN NULL::numeric ELSE coalesce(v.rec, 0) END,
         CASE WHEN v_vnd IS NULL THEN NULL::numeric ELSE round(v.pm12::numeric, 4) END,
         CASE WHEN p_empresa = 'oben' AND private.cap_compras_ler(auth.uid()) THEN coalesce(c.compras, '{}'::timestamptz[])
              ELSE NULL::timestamptz[] END,
         d.troca_contrapartida
    FROM d
    LEFT JOIN e ON e.sku = d.sku
    LEFT JOIN v ON v.sku = d.sku
    LEFT JOIN c ON c.sku = d.sku
   ORDER BY d.sku;
END
$fn$;

REVOKE ALL ON FUNCTION public.raio_x_medicao(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.raio_x_medicao(text) TO authenticated;

-- ── PÓS ──────────────────────────────────────────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE f text; v_src text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.raio_x_inequivoco(text,bigint)', 'public.raio_x_medicao(text)'] LOOP
    IF (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
      RAISE EXCEPTION 'postcondicao: % virou SECURITY DEFINER', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.raio_x_inequivoco(text,bigint)', 'public.raio_x_medicao(text)',
                           'public.raio_x_planejar(text,bigint,numeric,text,uuid,date,boolean,timestamptz,numeric,text)',
                           'public.raio_x_decidir(text,bigint,text,text,text,text,numeric,boolean,boolean)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: anon/public executa %', f;
    END IF;
    IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'postcondicao: authenticated nao executa %', f;
    END IF;
  END LOOP;
  IF to_regprocedure('public.raio_x_planejar(text,bigint,numeric,text,uuid,date,boolean,timestamptz)') IS NOT NULL THEN
    RAISE EXCEPTION 'postcondicao: assinatura velha de raio_x_planejar ainda existe (rota sem os controles novos)';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.raio_x_planejar(text,bigint,numeric,text,uuid,date,boolean,timestamptz,numeric,text)'::regprocedure)
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = 'public.raio_x_decidir(text,bigint,text,text,text,text,numeric,boolean,boolean)'::regprocedure) THEN
    RAISE EXCEPTION 'postcondicao: planejar/decidir perderam SECURITY DEFINER';
  END IF;
  SELECT p.prosrc INTO v_src FROM pg_proc p WHERE p.oid = 'public.raio_x_decidir(text,bigint,text,text,text,text,numeric,boolean,boolean)'::regprocedure;
  IF position('RX004' IN v_src) = 0 OR position('raio_x_inequivoco(p_empresa, p_sku)' IN v_src) = 0 THEN
    RAISE EXCEPTION 'postcondicao: raio_x_decidir instalado nao recusa liquidar fora do inequivoco';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'raio_x_decisao'
        AND column_name IN ('frete_estimado','desconto_sobre_medio_pct','margem_unit','preco_medio_base','cmc_base','troca_contrapartida')) <> 6 THEN
    RAISE EXCEPTION 'postcondicao: colunas do plano ausentes em raio_x_decisao';
  END IF;
  RAISE NOTICE 'RAIO-X-INEQUIVOCO-OK';
END
$pos$;

