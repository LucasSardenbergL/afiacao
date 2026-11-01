-- ============================================================================================
-- 20261101050000 · tint_watchdog_fase5 v5 — S1 e universo em passada única (cabe no Mini)
-- Prova: db/test-tint-fase5-watchdog-v5.sh (PG17: a suíte da v4 inteira contra a v5 + equivalência
-- do oráculo contra a view real + falsificação no MESMO laço do controle verde)
-- [money-path]
--
-- O QUE MUDA (só custo; sinais, critério, alertas e série são os da v4)
--   `k` (universo carimbado): GROUP BY + HAVING bool_or(motivo fase5) numa passada, no lugar do IN.
--   S1 (chave sem preço): o oráculo deixa de ler v_tint_formula_canonica e passa a ser `receita_ok`
--      (GROUP BY formula_id HAVING bool_and(predicado de corante da view)) + `v_ok`. Equivalência: a
--      canônica da chave é a de menor rank_pref e rank_pref <= 1 é exatamente receita_valida, então a
--      chave tem canônica precificável SSE alguma ativa com SKU dela tem receita válida.
--
-- POR QUÊ (psql-ro + EXPLAIN ANALYZE BUFFERS em prod, 2026-11-01 04:38 UTC, porte Mini)
--   A v4 leu 1.061.231 blocos (8,1 GB) do disco em 620 s: 4,7 GB nos SubPlans por fórmula da view
--   (493 mil ativas em ordem aleatória, 481 mil heap fetches: o visibility map de tint_formula_itens
--   estava em 49,6%) e 2,4 GB no IN do `k` (Index Scan da tabela inteira). No small levava 86-154 s;
--   no Mini, 581 s às 12:00 e TIMEOUT de 600 s às 18:00 de 31/10, a 2 falhas do dead-man de 13 h.
--   Medido em prod (mesmo SELECT, EXPLAIN ANALYZE BUFFERS, 05:00-05:10 UTC):
--     v4: 620 s · 8,1 GB do disco                 v5 com a config abaixo: 18 s · 1,14 GB · 365 MB temp
--   O que sobra é o catálogo lido UMA vez em seq scan (heap de tint_formulas + tint_formula_itens).
--   Equivalência nos dados de prod (04:50-04:59 UTC): oráculo 493.064 = 493.064 chaves e universo
--   463.995 = 463.995, zero diferença nos dois sentidos; S1 0 = 0.
--
-- NÃO MUDA: v_criterio continua 'v4' (S2 não mudou de critério; trocar fecharia alerta aberto à toa).
-- ============================================================================================

-- TRAVA, antes de ler: ALTER sem efeito na função que a PRE guarda e este arquivo recria.
DO $trava$
BEGIN
  IF to_regprocedure('public.tint_watchdog_fase5_check()') IS NOT NULL THEN
    ALTER FUNCTION public.tint_watchdog_fase5_check() VOLATILE;
  END IF;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {v4 revisada (= repo 20261013210000), esta v5}. Ausente ABORTA.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.tint_watchdog_fase5_check()'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('48c49303017a36b2ff287c6241421c5c', 'c0b6f37f9ecc132bd14a295f6b724101') THEN
    RAISE EXCEPTION 'PRE FALHOU: tint_watchdog_fase5_check() vivo (md5 %) não é a v4 revisada nem esta v5', v_vivo;
  END IF;
  IF to_regprocedure('public._tint_watchdog_fase5_transicao(text,text,bigint,text,text,text,jsonb,numeric)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: o helper _tint_watchdog_fase5_transicao v2 não existe';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.tint_watchdog_fase5_check()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
-- v5: o plano por config DA FUNÇÃO (vale só durante a chamada e volta sozinho). Sem index scan,
-- o `k` e o `v_ok` leem a tabela em seq scan (ring buffer: não expulsa o cache quente); com o
-- index scan o planner escolhia percorrer tint_formulas inteira pelo índice = 2,5 GB aleatórios.
-- work_mem: os HashAggregate de 0,5-1 M grupos; com os 3,5 MB do porte, 909 MB de temp.
SET enable_indexscan TO 'off'
SET enable_indexonlyscan TO 'off'
SET work_mem TO '16MB'
AS $function$
DECLARE
  -- tint_watchdog_fase5 guard v5 — MARCADOR do guard anti-rollback. Uma versão
  -- SUCESSORA que recrie esta função DEVE trocar este marcador (v6, v7...), para que
  -- re-aplicar ESTA por cima dela ABORTE em vez de revertê-la em silêncio.
  -- v5 = a v4 com S1 e universo em passada única (CTEs `k`, `receita_ok`, `v_ok`); critério,
  -- alertas e série inalterados (por isso v_criterio continua 'v4').
  v_conta       text := 'oben';   -- 100% do catálogo tint é oben (medido)
  v_criterio    constant text := 'v4';
  v_t0          timestamptz := clock_timestamp();
  v_s1          bigint;
  v_s2          bigint;   -- RETIRADA NOVA (janela de 7 dias de snapshots) — o que alarma
  v_s2_bruto    bigint;   -- carimbadas sem ativa — MÉTRICA e denominador do S4
  v_universo    bigint;
  v_max         bigint;
  v_ancora      timestamptz;
  v_dismiss     timestamptz;
  v_queda       numeric;
  v_msg         text;
  v_snap_id     uuid;          -- último snapshot de chaves APLICADO
  v_snap_rec    timestamptz;   -- max(created_at) dos chunks dele: relógio do SERVIDOR
  v_ret_fonte   bigint;        -- chaves-fonte retiradas na janela
  v_fant        bigint;        -- S5: ativas ausentes da fonte, sem staging posterior
  v_fant_vend   bigint;
  v_fant_fonte  bigint;
  v_cor_nova    bigint;        -- ausentes do snapshot COM staging posterior (legítimas)
BEGIN
  -- Anti-sobreposição: um ciclo preso não pode empilhar outro por cima. Se já há um rodando,
  -- SAI SEM avançar o marcador — e o marcador parado é o que faz o dead-man cruzado alarmar.
  IF NOT pg_try_advisory_xact_lock(hashtext('tint_watchdog_fase5')) THEN
    RETURN;
  END IF;

  -- ── UMA FOTOGRAFIA SÓ (challenge Codex v4, P1-2) ──────────────────────────────────────────
  -- Referência da fonte, janela de retirada, staging posterior, universo carimbado e fórmulas
  -- ativas saem do MESMO statement: em READ COMMITTED cada statement de uma função VOLATILE tem
  -- snapshot próprio, e a varredura leva minutos — staging lido numa query e fórmulas lidas noutra,
  -- com uma promoção no meio, transformavam cor nova legítima em "fantasma".
  --
  -- REFERÊNCIA = o snapshot APLICADO de maior generated_at (P1-1). É a ordem do PRÓPRIO apply: ele
  -- só aplica de fato quando generated_at > last_keys_snapshot_at, e o que ele pula como "fora de
  -- ordem" é marcado 'aplicado' com aplicado_em NOVO sem ter governado nada. Ordenar por aplicado_em
  -- deixava um snapshot ANTIGO re-aplicado virar a referência. aplicado_em não decide nada aqui.
  -- O relógio da PRESENÇA (staging × snapshot) é created_at nos dois lados, como no 20261013150000.
  --
  -- JANELA DA RETIRADA NOVA = snapshots APLICADOS inteiros (por snapshot_id, nunca por chunk — P2-6)
  -- gerados nos últimos 7 dias. generated_at é o relógio do conector; numa janela de dias, skew de
  -- minutos é irrelevante, e é ele que exclui o snapshot velho recebido atrasado.
  WITH ref AS MATERIALIZED (
    SELECT ks.snapshot_id, max(ks.created_at) AS rec
      FROM tint_keys_snapshots ks
     WHERE ks.account = v_conta AND ks.entity = 'formulas'
       AND ks.aplicacao_status = 'aplicado'
     GROUP BY ks.snapshot_id
     ORDER BY max(ks.generated_at) DESC NULLS LAST, max(ks.created_at) DESC
     LIMIT 1
  ), snap AS MATERIALIZED (
    SELECT DISTINCT c.chave
      FROM tint_keys_snapshots ks
      JOIN ref ON ref.snapshot_id = ks.snapshot_id,
           jsonb_array_elements_text(ks.keys) AS c(chave)
     WHERE ks.entity = 'formulas' AND c.chave IS NOT NULL
  ), janela AS MATERIALIZED (
    SELECT ks.snapshot_id
      FROM tint_keys_snapshots ks
     WHERE ks.account = v_conta AND ks.entity = 'formulas'
       AND ks.aplicacao_status = 'aplicado'
       AND ks.snapshot_id <> (SELECT snapshot_id FROM ref)
     GROUP BY ks.snapshot_id
    HAVING max(ks.generated_at) >= now() - interval '7 days'
  ), retirada AS MATERIALIZED (
    -- chave-fonte presente em algum snapshot aplicado da janela e ausente da referência
    SELECT DISTINCT c.chave
      FROM tint_keys_snapshots ks
      JOIN janela j ON j.snapshot_id = ks.snapshot_id,
           jsonb_array_elements_text(ks.keys) AS c(chave)
     WHERE ks.entity = 'formulas' AND c.chave IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM snap s WHERE s.chave = c.chave)
  ), k_ret AS MATERIALIZED (
    -- as chaves (account, sku_id, cor_id) que expandem essas chaves-fonte (N embalagens por fonte).
    -- Pré-filtro por cor_id (índice account, cor_id, …); quem decide é a chave inteira.
    SELECT DISTINCT f.account, f.sku_id, f.cor_id
      FROM tint_formulas f
      JOIN tint_produtos p ON p.id = f.produto_id
      JOIN tint_bases    b ON b.id = f.base_id
     WHERE f.account = v_conta AND f.sku_id IS NOT NULL
       AND f.cor_id IN (SELECT split_part(r.chave, '|', 1) FROM retirada r)
       AND (f.cor_id || '|' || p.cod_produto || '|' || b.id_base_sayersystem || '|'
            || (CASE WHEN f.personalizada THEN 'true' ELSE 'false' END))
           IN (SELECT r.chave FROM retirada r)
  ), novo AS MATERIALIZED (
    -- COR NOVA: staging RECEBIDO a partir da referência (o 20261013150000 só barra created_at < rec)
    SELECT DISTINCT x.chave
      FROM (SELECT sf.cor_id || '|' || sf.cod_produto || '|' || sf.id_base || '|'
                   || (CASE WHEN sf.personalizada THEN 'true' ELSE 'false' END) AS chave
              FROM tint_staging_formulas sf
             WHERE sf.account = v_conta AND sf.created_at >= (SELECT rec FROM ref)) x
     WHERE x.chave IS NOT NULL
  ), k AS (
    -- as chaves carimbadas pela Fase 5, com "ainda tem fórmula ativa?" por agregação.
    -- v5: UMA passada em tint_formulas (GROUP BY + HAVING). O `IN` da v4 virava Index Scan da
    -- tabela inteira em ordem de índice: 2,4 GB de heap aleatório por execução no Mini
    -- (EXPLAIN ANALYZE em prod, 2026-11-01). Chave com componente NULL fica de fora, como no IN
    -- (comparação de linha com NULL nunca casa).
    SELECT f.account, f.sku_id, f.cor_id,
           bool_or(f.desativada_em IS NULL AND f.sku_id IS NOT NULL) AS tem_ativa
      FROM tint_formulas f
     WHERE f.account IS NOT NULL AND f.sku_id IS NOT NULL AND f.cor_id IS NOT NULL
     GROUP BY f.account, f.sku_id, f.cor_id
    HAVING bool_or(f.desativada_motivo = 'fase5_geracao_legada')
  ), receita_ok AS MATERIALIZED (
    -- O ORÁCULO DO S1, em passada única. Fórmula com receita válida = tem item E nenhum item
    -- falha o predicado de corante de v_tint_formula_canonica (tem_receita AND corantes_ok,
    -- MESMO predicado, copiado de lá). A chave tem canônica com receita_valida SSE alguma ativa
    -- com SKU dela tem receita válida: a canônica é a de menor rank_pref, e rank_pref <= 1 é
    -- exatamente receita_valida. A v4 lia a view, que avalia isso por fórmula em SubPlan: 4,7 GB
    -- de leitura aleatória em tint_formula_itens por execução no Mini. MUDOU O PREDICADO DE
    -- CORANTE NA VIEW? Mude aqui também; db/test-tint-fase5-watchdog-v5.sh prova a igualdade.
    SELECT fi.formula_id
      FROM tint_formula_itens fi
      LEFT JOIN tint_corantes c   ON c.id = fi.corante_id
      LEFT JOIN omie_products op  ON op.id = c.omie_product_id
     GROUP BY fi.formula_id
    HAVING bool_and(COALESCE(op.valor_unitario, 0) > 0 AND COALESCE(op.ativo, false)
                    AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0)
  ), v_ok AS (
    -- as chaves que o balcão consegue precificar hoje (= v_tint_formula_canonica WHERE receita_valida)
    SELECT DISTINCT f.account, f.sku_id, f.cor_id
      FROM tint_formulas f
      JOIN receita_ok r ON r.formula_id = f.id
     WHERE f.desativada_em IS NULL AND f.sku_id IS NOT NULL
  ), o AS (
    -- S5: o universo do apply (ativas da conta com produto e base resolvidos)
    SELECT f.sku_id,
           (f.cor_id || '|' || p.cod_produto || '|' || b.id_base_sayersystem || '|'
            || (CASE WHEN f.personalizada THEN 'true' ELSE 'false' END)) AS chave
      FROM tint_formulas f
      JOIN tint_produtos p ON p.id = f.produto_id
      JOIN tint_bases    b ON b.id = f.base_id
     WHERE f.account = v_conta AND f.desativada_em IS NULL
  )
  SELECT (SELECT snapshot_id FROM ref), (SELECT rec FROM ref), (SELECT count(*) FROM retirada),
         u.s1, u.s2, u.bruto, u.universo,
         f5.fant, f5.fant_vend, f5.fant_fonte, f5.cor_nova
    INTO v_snap_id, v_snap_rec, v_ret_fonte,
         v_s1, v_s2, v_s2_bruto, v_universo,
         v_fant, v_fant_vend, v_fant_fonte, v_cor_nova
    FROM (
      -- count(DISTINCT ...) no universo, não count(*): a unicidade da view por chave é propriedade
      -- dela, não invariante imposta aqui (Codex [P1]).
      SELECT count(*) FILTER (WHERE k.tem_ativa AND v.account IS NULL) AS s1,
             count(DISTINCT (k.account, k.sku_id, k.cor_id))
               FILTER (WHERE NOT k.tem_ativa AND kr.cor_id IS NOT NULL) AS s2,
             count(DISTINCT (k.account, k.sku_id, k.cor_id)) FILTER (WHERE NOT k.tem_ativa) AS bruto,
             count(DISTINCT (k.account, k.sku_id, k.cor_id)) AS universo
        FROM k
        LEFT JOIN v_ok v   -- o oráculo: o que o balcão consegue precificar hoje (CTE acima)
               ON v.account = k.account AND v.sku_id = k.sku_id AND v.cor_id = k.cor_id
        LEFT JOIN k_ret kr
               ON kr.account = k.account AND kr.sku_id = k.sku_id AND kr.cor_id = k.cor_id
    ) u,
    (
      SELECT count(*) FILTER (WHERE n.chave IS NULL) AS fant,
             count(*) FILTER (WHERE n.chave IS NULL AND o.sku_id IS NOT NULL) AS fant_vend,
             count(DISTINCT o.chave) FILTER (WHERE n.chave IS NULL) AS fant_fonte,
             count(*) FILTER (WHERE n.chave IS NOT NULL) AS cor_nova
        FROM o
        LEFT JOIN novo n ON n.chave = o.chave
       WHERE NOT EXISTS (SELECT 1 FROM snap s WHERE s.chave = o.chave)
    ) f5;

  -- Sem referência da fonte: S2 e S5 são AUSENTES, não zero (com snap vazio o S5 contaria TODA
  -- ativa como fantasma, e o S2 zeraria por vacuidade).
  IF v_snap_id IS NULL THEN
    v_s2 := NULL; v_ret_fonte := NULL;
    v_fant := NULL; v_fant_vend := NULL; v_fant_fonte := NULL; v_cor_nova := NULL;
  END IF;

  -- ── S3: CARDINALIDADE do universo (o vigia de vacuidade) — corpo da v3 ──────────────────────
  SELECT COALESCE((metadata->>'universo_max')::bigint, 0),
         COALESCE((metadata->>'ancora_em')::timestamptz, '-infinity'::timestamptz)
    INTO v_max, v_ancora
    FROM sync_state
   WHERE entity_type = 'tint_watchdog_fase5' AND account = v_conta;
  v_max    := COALESCE(v_max, 0);
  v_ancora := COALESCE(v_ancora, '-infinity'::timestamptz);

  SELECT max(dismissed_at) INTO v_dismiss
    FROM fin_alertas
   WHERE company = v_conta AND tipo = 'tint_fase5_universo_encolheu'
     AND dismissed_at IS NOT NULL;

  -- Dismiss manual re-ancora só com universo > 0 e queda <= 1.000 chaves (teto ABSOLUTO, Codex
  -- [P1]); acima disso o rebaseline é escrita deliberada no SQL Editor.
  IF v_dismiss IS NOT NULL AND v_dismiss > v_ancora THEN
    IF v_universo > 0 AND (v_max - v_universo) <= 1000 THEN
      v_max := v_universo; v_ancora := now();
    ELSE
      v_ancora := v_dismiss;   -- consome o dismiss sem rebaixar o patamar
    END IF;
  END IF;

  IF v_universo > v_max THEN                    -- high-water-mark sobe sozinho
    v_max := v_universo; v_ancora := now();
  END IF;

  v_queda := CASE WHEN v_max > 0
                  THEN (v_max - v_universo)::numeric / v_max ELSE 0 END;

  IF v_max > 0 AND v_universo < v_max THEN
    v_msg := 'Tintometrico/Fase 5: o universo carimbado ENCOLHEU de ' || v_max ||
             ' para ' || v_universo || ' chaves (' ||
             round(v_queda * 100, 1) || '%). O watchdog por chave mede sobre esse ' ||
             'universo: se ele sumir, S1/S2 vao a zero por VACUIDADE e a rede fica ' ||
             'cega sem nunca ficar vermelha. ' ||
             CASE WHEN (v_max - v_universo) <= 1000
                  THEN 'Se a mudanca foi deliberada, dispense este alerta que ' ||
                       'o patamar novo vira a referencia.'
                  ELSE 'Queda ACIMA do teto de re-ancoragem (1.000 chaves): dispensar ' ||
                       'NAO muda o patamar e o alerta reabre no proximo ciclo. Restaure ' ||
                       'o universo, ou faca o rebaseline explicito no SQL Editor: ' ||
                       'UPDATE sync_state SET metadata = metadata || jsonb_build_object(' ||
                       '''universo_max'', ' || v_universo || ', ''ancora_em'', now()) ' ||
                       'WHERE entity_type=''tint_watchdog_fase5'';' END;
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_universo_encolheu', v_max - v_universo,
      CASE WHEN v_universo = 0 OR v_queda >= 0.5 THEN 'critico' ELSE 'aviso' END,
      '[Tintometrico] universo carimbado da Fase 5 encolheu', v_msg,
      jsonb_build_object('universo', v_universo, 'universo_max', v_max,
                         'queda_pct', round(v_queda * 100, 2)));
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_universo_encolheu', 0, 'info', '', '', '{}'::jsonb);
    v_ancora := now();   -- auto-dismiss NAO pode parecer aceite manual
  END IF;

  -- ── S1: a chave existe e NAO PRECIFICA (dano de venda real) — corpo da v3 ───────────────────
  IF v_s1 > 0 THEN
    v_msg := 'Tintometrico: ' || v_s1 || ' chave(s) desativada(s) pela Fase 5 estao ' ||
             'SEM formula precificavel - a RPC devolve precoFinal NULL (fail-closed) ' ||
             'e o balcao nao vende essas cores. A geracao 1 que as respaldava ja foi ' ||
             'desativada e NAO e mais fallback. Causa tipica: corante sem custo Omie ' ||
             'ou receita corrompida por sync.';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_chave_sem_preco', v_s1,
      CASE WHEN v_s1 >= 1000 THEN 'critico' ELSE 'aviso' END,
      '[Tintometrico] chaves da Fase 5 sem preco', v_msg,
      jsonb_build_object('chaves', v_s1, 'universo', v_universo));
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_chave_sem_preco', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  -- ── S2: RETIRADA NOVA pela fonte ──────────────────────────────────────────────────────────
  -- Encerramento por MUDANÇA DE CRITÉRIO (P2c): um alerta aberto sob outro critério não é
  -- "resolvido" quando o número dele zera aqui — ele mede outra coisa. Fecha anotando de qual
  -- critério para qual, e o critério novo abre o seu (com e-mail) se tiver o que dizer.
  UPDATE fin_alertas
     SET dismissed_at = now(),
         contexto = COALESCE(contexto, '{}'::jsonb)
                    || jsonb_build_object('encerrado_por', 'mudanca_criterio',
                                          'criterio_de', COALESCE(contexto->>'criterio', 'v3'),
                                          'criterio_para', v_criterio,
                                          'encerrado_em', now())
   WHERE company = v_conta AND tipo = 'tint_fase5_fonte_retirada' AND dismissed_at IS NULL
     AND (contexto->>'criterio') IS DISTINCT FROM v_criterio
     -- só quando o critério novo PODE avaliar (Codex v4 P2-4): sem referência, nada é tocado
     AND v_s2 IS NOT NULL;

  IF v_s2 IS NULL THEN
    NULL;   -- sem snapshot aplicado: não abre nem fecha (ausência de dado ≠ saudável)
  ELSIF v_s2 > 0 THEN
    v_msg := 'Tintometrico: ' || v_s2 || ' chave(s) carimbada(s) pela Fase 5 ficaram sem ' ||
             'formula ativa porque a FONTE retirou a cor nos ultimos 7 dias (' || v_ret_fonte ||
             ' chave(s)-fonte estavam num snapshot aplicado da janela e sumiram do ultimo). ' ||
             'Nao e venda perdida por defeito (S1 mede isso): e a cor saindo do catalogo do ' ||
             'SayerSystem. NAO mexa no tombstone da Fase 5: ele e o piso do tint_gate_revalida ' ||
             'e o rotulo do balcao, e alterar o carimbo foi REJEITADO em 20260924120000 e e ' ||
             'barrado por trigger (20261010120000). A acao e confirmar na fonte se a cor saiu ' ||
             'mesmo e, se sim, decidir em PRODUTO o que fazer com o piso dela.';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_retirada', v_s2,
      -- v2 (decisão do founder): S2 NUNCA é crítico.
      CASE WHEN v_s2 >= 100 THEN 'aviso' ELSE 'info' END,
      '[Tintometrico] fonte retirou cores com carimbo da Fase 5', v_msg,
      jsonb_build_object('criterio', v_criterio, 'chaves', v_s2,
                         'chaves_fonte_retiradas_7d', v_ret_fonte,
                         'bruto', v_s2_bruto, 'universo', v_universo,
                         'snapshot_id', v_snap_id),
      -- histerese 2.0: retirada chega em lote; re-emissão logarítmica.
      2.0);
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_retirada', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  -- ── S4: COLAPSO do bruto (snapshot truncado / retirada em massa) — corpo da v3 ──────────────
  -- LIMIAR 5% (aviso) e 20% (crítico) do universo. O churn normal medido fica em ~2,7%.
  IF v_universo > 0 AND v_s2_bruto::numeric / v_universo >= 0.05 THEN
    v_msg := 'Tintometrico: ' || v_s2_bruto || ' de ' || v_universo || ' chaves ' ||
             'carimbadas (' || round(v_s2_bruto::numeric * 100 / v_universo, 1) ||
             '%) estao SEM formula ativa AGORA. O patamar normal fica em torno de 2-3% ' ||
             '(maxima medida 2,7%); este indica snapshot TRUNCADO ou retirada em ' ||
             'massa pela fonte. O balcao nao vende essas cores enquanto durar. Acao: ' ||
             'conferir o ultimo ciclo do conector (tint_sync_runs) e a fonte.';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_colapso', v_s2_bruto,
      CASE WHEN v_s2_bruto::numeric / v_universo >= 0.20 THEN 'critico' ELSE 'aviso' END,
      '[Tintometrico] colapso de disponibilidade no catalogo carimbado', v_msg,
      jsonb_build_object('bruto', v_s2_bruto, 'universo', v_universo,
                         'pct', round(v_s2_bruto::numeric * 100 / v_universo, 2)),
      1.0);
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_colapso', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  -- ── S5: FANTASMA — a fórmula está ATIVA e a fonte não a tem ─────────────────────────────────
  -- Nasce em ZERO por construção: o apply desativa toda ativa ausente do snapshot, e desde
  -- 20261013150000 o promote não reativa staging recebido antes dele. Qualquer valor > 0 é o
  -- balcão cotando cor que o SayerSystem não tem. Fator 1.0: toda piora merece e-mail.
  IF v_fant IS NULL THEN
    NULL;   -- sem snapshot aplicado: não abre nem fecha
  ELSIF v_fant > 0 THEN
    v_msg := 'Tintometrico: ' || v_fant || ' formula(s) ATIVA(s) (' || v_fant_vend ||
             ' com SKU, ' || v_fant_fonte || ' chave(s)-fonte) NAO estao no ultimo snapshot de ' ||
             'chaves APLICADO da fonte (recebido em ' || to_char(v_snap_rec AT TIME ZONE 'UTC',
             'YYYY-MM-DD HH24:MI') || ' UTC) e nao tem staging recebido depois dele. O balcao ' ||
             'cota cor que o SayerSystem nao tem mais. Nao e cor nova (' || v_cor_nova ||
             ' formula(s) com staging posterior ficaram de fora deste numero). Causa tipica: o ' ||
             'promote voltou a reativar staging antigo (regressao do 20261013150000) ou o apply do ' ||
             'snapshot nao desativou (tint_sync_runs keys_snapshot: skipped, erro, blast radius).';
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_fantasma', v_fant,
      CASE WHEN v_fant >= 1000 THEN 'critico' ELSE 'aviso' END,
      '[Tintometrico] formulas ativas que a fonte nao tem', v_msg,
      jsonb_build_object('formulas', v_fant, 'com_sku', v_fant_vend,
                         'chaves_fonte', v_fant_fonte, 'cor_nova', v_cor_nova,
                         'snapshot_id', v_snap_id, 'snapshot_recebido_em', v_snap_rec),
      1.0);
  ELSE
    PERFORM public._tint_watchdog_fase5_transicao(
      v_conta, 'tint_fase5_fonte_fantasma', 0, 'info', '', '', '{}'::jsonb);
  END IF;

  -- ── SÉRIE (P2d) + MARCADOR DE SUCESSO ─────────────────────────────────────────────────────
  -- Só chega aqui quem varreu E transicionou todos os alertas; exceção acima aborta a função e
  -- não grava amostra nem avança o marcador que o dead-man cruzado vigia (>13h => alerta).
  INSERT INTO tint_watchdog_fase5_amostras
    (criterio, universo, s1_sem_preco, sem_ativa_bruto, s2_retirada_nova, fantasmas,
     fantasmas_vendaveis, cor_nova, snapshot_id, snapshot_recebido_em, duracao_s)
  VALUES (v_criterio, v_universo, v_s1, v_s2_bruto, v_s2, v_fant, v_fant_vend, v_cor_nova,
          v_snap_id, v_snap_rec,
          round(EXTRACT(epoch FROM clock_timestamp() - v_t0)::numeric, 1));
  DELETE FROM tint_watchdog_fase5_amostras WHERE medido_em < now() - interval '180 days';

  INSERT INTO sync_state (entity_type, account, last_sync_at, status, error_message, metadata)
  -- clock_timestamp(), não now(): now() é o início da TRANSAÇÃO e a varredura leva minutos.
  VALUES ('tint_watchdog_fase5', v_conta, clock_timestamp(), 'complete', NULL,
          jsonb_build_object('criterio', v_criterio,
                             'chaves_sem_preco', v_s1, 'fonte_retirada', v_s2,
                             'fonte_retirada_bruto', v_s2_bruto,
                             'chaves_fonte_retiradas_7d', v_ret_fonte,
                             'fantasmas', v_fant, 'fantasmas_com_sku', v_fant_vend,
                             'cor_nova', v_cor_nova,
                             'snapshot_id', v_snap_id, 'snapshot_recebido_em', v_snap_rec,
                             'universo', v_universo, 'universo_max', v_max,
                             'ancora_em', v_ancora,
                             'duracao_s', round(EXTRACT(epoch FROM clock_timestamp() - v_t0)::numeric, 1)))
  ON CONFLICT (entity_type, account) DO UPDATE
    SET last_sync_at  = clock_timestamp(),
        status        = 'complete',
        error_message = NULL,
        updated_at    = now(),
        metadata      = EXCLUDED.metadata;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.tint_watchdog_fase5_check() FROM PUBLIC, anon, authenticated;

-- PÓS: os invariantes da v4 sobre a função (P1-P6, mesmos textos) + os da v5 (P9, P10). Por
-- marcador, não por md5: a PRE já fecha o predecessor, e a falsificação da prova aplica corpos
-- sabotados por cima — md5 aqui abortaria toda sabotagem antes dos asserts.
DO $post$
DECLARE
  v_oid  oid := to_regprocedure('public.tint_watchdog_fase5_check()');
  v_hoid oid := to_regprocedure('public._tint_watchdog_fase5_transicao(text,text,bigint,text,text,text,jsonb,numeric)');
  v_src  text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF position('tint_watchdog_fase5 guard v5' IN v_src) = 0 THEN
    RAISE EXCEPTION 'P1 FALHOU: o marcador v5 não está na função';
  END IF;
  IF position('tint_fase5_fonte_fantasma' IN v_src) = 0 OR position('tint_fase5_fonte_colapso' IN v_src) = 0 THEN
    RAISE EXCEPTION 'P2 FALHOU: S5 (fantasma) ou S4 (colapso) ausente da função';
  END IF;
  -- o corte de 30 dias da v3 (cego) não pode voltar
  IF v_src ~ 'interval ''30 days''' THEN
    RAISE EXCEPTION 'P2b FALHOU: o corte de 30 dias da v3 voltou à função';
  END IF;
  IF v_src ~ 'v_s2 >= [0-9]+ THEN ''critico''' THEN
    RAISE EXCEPTION 'P3 FALHOU: S2 voltou a escalar para critico (decisão de 20261010230000)';
  END IF;
  IF v_src ~ 'recarimbar/limpar' THEN
    RAISE EXCEPTION 'P4 FALHOU: a mensagem voltou a instruir limpar/recarimbar o tombstone (ação rejeitada em 20260924120000 e barrada por trigger)';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_hoid) THEN
    RAISE EXCEPTION 'P5 FALHOU: função ou helper deixou de ser SECURITY DEFINER';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_hoid, 'EXECUTE') OR has_function_privilege('authenticated', v_hoid, 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: anon/authenticated executam o watchdog ou o helper';
  END IF;
  -- v5: a leitura cara não pode voltar (comentário pode citar a view; código não)
  IF position('v_tint_formula_canonica' IN regexp_replace(v_src, '--[^\n]*', '', 'g')) > 0 THEN
    RAISE EXCEPTION 'P9 FALHOU: a v5 voltou a LER v_tint_formula_canonica (SubPlan por formula, 4,7 GB no Mini)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-watchdog-fase5-6h' AND active
                    AND command LIKE '%tint_watchdog_fase5_check()%') THEN
    RAISE EXCEPTION 'P10 FALHOU: o cron tint-watchdog-fase5-6h não está ativo chamando a função';
  END IF;
  IF NOT (SELECT p.proconfig @> ARRAY['enable_indexscan=off', 'enable_indexonlyscan=off', 'work_mem=16MB']
            FROM pg_proc p WHERE p.oid = v_oid) THEN
    RAISE EXCEPTION 'P11 FALHOU: a funcao perdeu a config do plano (sem ela volta o Index Scan da tabela inteira)';
  END IF;
  RAISE NOTICE 'tint_watchdog_fase5 v5: config do plano, marcador v5, S4/S5, sem corte de 30d, definer, ACL, sem leitura da view, cron ativo';
END
$post$;
