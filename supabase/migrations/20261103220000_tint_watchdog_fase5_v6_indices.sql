-- ============================================================================================
-- 20261103220000 · tint_watchdog_fase5 v6 — o ciclo lê ÍNDICES pequenos, não o catálogo (cabe no Mini)
-- Prova: db/test-tint-fase5-watchdog-v6.sh (PG17: a suíte da v5 inteira contra a v6 + PARIDADE do
-- statement v5 × v6 em vários estados + equivalência do oráculo contra a view real + guarda do plano
-- + falsificação no MESMO laço do controle verde)
-- [money-path]
--
-- O QUE MUDA (só custo; sinais, critério, alertas, série e marcador são os da v5)
--   5 índices (abaixo) e o statement do ciclo reescrito para ler só deles:
--   `k`        universo pelo índice parcial das carimbadas + sonda "tem ativa" no índice das ativas
--   S1         pelo COMPLEMENTO: as ativas INVÁLIDAS (sem item, ou com item de corante ruim) e as
--              chaves em que TODA ativa é inválida. A v5 agregava os 3,5 M itens para achar as válidas.
--   `o` (S5)   pelo índice parcial das ativas (carrega produto, base e personalizada)
--   `novo`     pelo índice (account, created_at) do staging, no lugar do seq scan do heap inchado
--   config     enable_seqscan off (a v5 desligava o index scan, o contrário); work_mem 16MB mantido
--
-- POR QUÊ (psql-ro, série de 60 s de pg_stat_database + pg_statio, 2026-11-03 17:56-18:11 UTC, Mini)
--   A janela de 15 min com o run das 18:00 leu 2.178 MB do disco (hit 90,98%, temp 466 MB) contra o
--   teto do Mini de 400 MB / 99% / 100 MB. Quem leu: tint_formulas 1.290 MB (3 passadas de 430 MB),
--   tint_formula_itens 571 MB, tint_staging_formulas 291 MB (heap inchado: ~630 linhas vivas).
--   Uma passada só em tint_formulas já estoura o teto; o que cabe é não varrer as tabelas.
--   O founder decidiu (03/11) que esse pico agendado CONTA para o critério do Mini.
--   Bancada PG17 em escala de prod: docs/historico/tint-purge-staging-io.md §"v6".
--
-- CUSTO NOVO: os 5 índices e a manutenção deles na escrita do promote. O build lê ~2,3 GB de heap
--   (tint_formulas e itens duas vezes cada, staging) e a ESCRITA nas três tabelas fica bloqueada até o
--   COMMIT da transação inteira, não só durante cada build: aplicar fora do sync (03:00 e 10:00
--   UTC) e longe dos runs do watchdog (00/06/12/18 UTC).
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

-- PRE: md5 EXATO do corpo vivo ∈ {v5 (= repo 20261101050000), esta v6}. Ausente ABORTA.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.tint_watchdog_fase5_check()'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('c9455ef40533517cf7c98759e36bd011', '9bd4d586f20672099cdd159852361e8f') THEN
    RAISE EXCEPTION 'PRE FALHOU: tint_watchdog_fase5_check() vivo (md5 %) não é a v5 (= repo 20261101050000) nem esta v6', v_vivo;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
                  WHERE p.oid = to_regprocedure('public._tint_watchdog_fase5_transicao(text,text,bigint,text,text,text,jsonb,numeric)')
                    AND position('tint_watchdog_fase5 helper v2' IN p.prosrc) > 0) THEN
    RAISE EXCEPTION 'PRE FALHOU: o helper _tint_watchdog_fase5_transicao vivo não é a v2';
  END IF;
  IF md5(pg_get_viewdef('public.v_tint_formula_canonica'::regclass, true)) IS DISTINCT FROM '9654cfa221f35b4d756fe3a6094bd267' THEN
    RAISE EXCEPTION 'PRE FALHOU: v_tint_formula_canonica viva não é a revisada (o S1 da v6 copia o predicado dela)';
  END IF;
END
$pre$;

-- ÍNDICES do ciclo (v6). Parciais e estreitos: o ciclo lê índice em vez do heap das três tabelas.
-- index-only: o visibility map de tint_formulas e tint_formula_itens está 100% (relallvisible =
-- relpages, 03/11); página suja entre dois VACUUMs vira heap fetch pontual, não varredura.
CREATE INDEX IF NOT EXISTS idx_tint_formulas_wd5_carimbo
  ON public.tint_formulas (account, sku_id, cor_id)
  WHERE desativada_motivo = 'fase5_geracao_legada';
CREATE INDEX IF NOT EXISTS idx_tint_formulas_wd5_ativas
  ON public.tint_formulas (account, sku_id, cor_id, produto_id, base_id, personalizada) INCLUDE (id)
  WHERE desativada_em IS NULL;
CREATE INDEX IF NOT EXISTS idx_tint_formula_itens_formula
  ON public.tint_formula_itens (formula_id);
-- (corante_id, formula_id): a varredura solta de `presentes` e o ramo dos corantes ruins, index-only
-- só nas faixas deles. Com o (corante_id) de prod o planner, sem conhecer o array, preferia ler o
-- (formula_id, corante_id) inteiro (bancada v6: 183 MB) a buscar formula_id no heap.
CREATE INDEX IF NOT EXISTS idx_tint_formula_itens_corante_formula
  ON public.tint_formula_itens (corante_id, formula_id);
CREATE INDEX IF NOT EXISTS idx_tint_staging_formulas_conta_criado
  ON public.tint_staging_formulas (account, created_at);

CREATE OR REPLACE FUNCTION public.tint_watchdog_fase5_check()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
-- v6: o plano por config DA FUNÇÃO (vale só durante a chamada e volta sozinho). Sem seq scan: o
-- ciclo inteiro sai dos índices acima, e uma estatística velha (relallvisible baixo depois de um
-- promote grande) não devolve o planner às varreduras de 430/571/291 MB. Tabela sem índice útil
-- (as de dezenas de linhas) continua em seq scan: off só encarece, não proíbe.
-- work_mem: o hash do snapshot (123 mil chaves-fonte) e o da retirada cabem sem derramar.
SET enable_seqscan TO 'off'
SET work_mem TO '16MB'
AS $function$
DECLARE
  -- tint_watchdog_fase5 guard v6 — MARCADOR do guard anti-rollback. Uma versão
  -- SUCESSORA que recrie esta função DEVE trocar este marcador (v7, v8...), para que
  -- re-aplicar ESTA por cima dela ABORTE em vez de revertê-la em silêncio.
  -- v6 = a v5 lida por índices (CTEs `k`, `presentes`, `ruim`, `inval`, `sem_preco`); critério,
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

  -- v5/v6: o oráculo do S1 (CTE ruim) COPIA o predicado de corante de v_tint_formula_canonica.
  -- A view mudou (md5 do pg_get_viewdef ≠ o revisado em 2026-11-01)? ABORTA: sem amostra e sem
  -- marcador, e o dead-man cruzado (>13 h) alarma. Nunca segue com a cópia velha: o S1 diria
  -- "precifica" para chave que o balcão recusa (parecer Codex v5, P2).
  IF md5(pg_get_viewdef('public.v_tint_formula_canonica'::regclass, true))
       IS DISTINCT FROM '9654cfa221f35b4d756fe3a6094bd267' THEN
    RAISE EXCEPTION 'tint_watchdog_fase5 v6: v_tint_formula_canonica mudou (md5 %): o S1 copia o predicado de corante dela; revise o CTE ruim e recrie o watchdog',
      md5(pg_get_viewdef('public.v_tint_formula_canonica'::regclass, true));
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
  WITH RECURSIVE ref AS MATERIALIZED (
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
       -- v6: NOT IN (hashed SubPlan, em memória), não NOT EXISTS. O planner estima 100 linhas por
       -- jsonb_array_elements_text e, com o NOT EXISTS, ORDENAVA as ~718 mil chaves da janela em
       -- disco (20 MB de temp, na v5 também). Mesmo resultado: os dois lados são NOT NULL por filtro.
       AND c.chave NOT IN (SELECT s.chave FROM snap s)
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
    -- v6: pelo índice (account, created_at); o heap do staging tem ~630 linhas vivas em 291 MB
    SELECT DISTINCT x.chave
      FROM (SELECT sf.cor_id || '|' || sf.cod_produto || '|' || sf.id_base || '|'
                   || (CASE WHEN sf.personalizada THEN 'true' ELSE 'false' END) AS chave
              FROM tint_staging_formulas sf
             WHERE sf.account = v_conta AND sf.created_at >= (SELECT rec FROM ref)) x
     WHERE x.chave IS NOT NULL
  ), k AS (
    -- as chaves carimbadas pela Fase 5, com "ainda tem fórmula ativa?". Sem MATERIALIZED: lido
    -- uma vez, e materializar as ~464 mil chaves derramava em temp.
    -- v6: o universo sai do índice parcial das carimbadas (index-only, ~25 MB) e o "tem ativa" é
    -- uma sonda por chave no índice parcial das ativas, no lugar do GROUP BY da tabela inteira da
    -- v5 (430 MB em seq scan). Mesmo conjunto: chave com componente NULL fica de fora, e uma chave
    -- é do universo SSE alguma linha dela tem o motivo da Fase 5.
    SELECT c.account, c.sku_id, c.cor_id,
           EXISTS (SELECT 1 FROM tint_formulas a
                    WHERE a.account = c.account AND a.sku_id = c.sku_id AND a.cor_id = c.cor_id
                      AND a.desativada_em IS NULL) AS tem_ativa
      FROM (SELECT DISTINCT f.account, f.sku_id, f.cor_id
              FROM tint_formulas f
             WHERE f.desativada_motivo = 'fase5_geracao_legada'
               AND f.account IS NOT NULL AND f.sku_id IS NOT NULL AND f.cor_id IS NOT NULL) c
  ), presentes AS (
    -- os corantes que aparecem em algum item: varredura solta no índice de corante (uma descida
    -- por corante distinto, ~16), sem ler os 3,5 M itens. Inclui corante órfão (id sem linha em
    -- tint_corantes): o predicado abaixo o reprova, como o LEFT JOIN da view.
    SELECT (SELECT fi.corante_id FROM tint_formula_itens fi ORDER BY fi.corante_id LIMIT 1) AS id
    UNION ALL
    SELECT (SELECT fi.corante_id FROM tint_formula_itens fi
             WHERE fi.corante_id > pr.id ORDER BY fi.corante_id LIMIT 1)
      FROM presentes pr WHERE pr.id IS NOT NULL
  ), ruim AS MATERIALIZED (
    -- corante presente que REPROVA o predicado de corante de v_tint_formula_canonica (MESMO
    -- predicado, copiado de lá — tem_receita AND corantes_ok). MUDOU O PREDICADO DE CORANTE NA
    -- VIEW? Mude aqui também; db/test-tint-fase5-watchdog-v6.sh prova a igualdade.
    SELECT pr.id
      FROM presentes pr
     WHERE pr.id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tint_corantes c
                         LEFT JOIN omie_products op ON op.id = c.omie_product_id
                        WHERE c.id = pr.id
                          AND COALESCE(op.valor_unitario, 0) > 0 AND COALESCE(op.ativo, false)
                          AND c.volume_total_ml IS NOT NULL AND c.volume_total_ml > 0)
  ), inval AS MATERIALIZED (
    -- O ORÁCULO DO S1 pelo COMPLEMENTO: as ativas com SKU cuja receita NÃO é válida. Receita
    -- válida = tem item E nenhum item tem corante ruim (o receita_ok da v5). Então inválida =
    -- (a) sem item nenhum: sonda por fórmula no índice de itens por formula_id (o OFFSET 0 impede
    --     o planner de virar isto num anti-join que lê os 571 MB de itens), ou
    -- (b) com item de corante ruim: pelo índice de corante, só os itens dos corantes ruins
    --     (300 itens em prod, 03/11). Custa proporcional ao DANO, não ao catálogo. O = ANY(ARRAY())
    --     é o que prende o índice: com IN (SELECT …) o planner fazia hash dos 3 M itens. Corante
    --     ruim que só aparece em fórmula DESATIVADA ainda custa a leitura dos itens dele.
    SELECT a.account, a.sku_id, a.cor_id, a.id
      FROM tint_formulas a
     WHERE a.desativada_em IS NULL AND a.sku_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM tint_formula_itens fi WHERE fi.formula_id = a.id OFFSET 0)
    UNION
    SELECT a.account, a.sku_id, a.cor_id, a.id
      FROM tint_formula_itens fi
      JOIN tint_formulas a ON a.id = fi.formula_id
     WHERE fi.corante_id = ANY (ARRAY(SELECT r.id FROM ruim r))
       AND a.desativada_em IS NULL AND a.sku_id IS NOT NULL
    UNION
    -- (c) item com corante_id NULL: a v5 o reprovava (LEFT JOIN sem corante), e `presentes` não
    --     enxerga NULL. Prod tem NOT NULL na coluna; o ramo deixa o S1 exato sem depender disso
    --     (contraexemplo do parecer Codex v6). Também pelo índice de corante (IS NULL).
    SELECT a.account, a.sku_id, a.cor_id, a.id
      FROM tint_formula_itens fi
      JOIN tint_formulas a ON a.id = fi.formula_id
     WHERE fi.corante_id IS NULL
       AND a.desativada_em IS NULL AND a.sku_id IS NOT NULL
  ), sem_preco AS MATERIALIZED (
    -- a chave NÃO precifica SSE TODA ativa dela é inválida (= não está em v_tint_formula_canonica
    -- WHERE receita_valida: a canônica é a de menor rank_pref, e rank_pref <= 1 é receita_valida).
    -- O UNION acima deixa cada (chave, fórmula) uma vez só, então count(*) conta fórmulas.
    SELECT i.account, i.sku_id, i.cor_id
      FROM inval i
     GROUP BY i.account, i.sku_id, i.cor_id
    HAVING count(*) = (SELECT count(*) FROM tint_formulas a
                        WHERE a.account = i.account AND a.sku_id = i.sku_id AND a.cor_id = i.cor_id
                          AND a.desativada_em IS NULL)
  ), o AS (
    -- S5: o universo do apply (ativas da conta com produto e base resolvidos), pelo índice parcial
    -- das ativas, que carrega produto, base e personalizada
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
      -- v6: count(*), não count(DISTINCT): k sai de um SELECT DISTINCT e as duas junções são com
      -- CTEs únicos por chave (GROUP BY e DISTINCT), então cada chave é UMA linha aqui. O DISTINCT
      -- da v5 ordenava as ~464 mil chaves em disco (temp) a cada ciclo; a paridade v5×v6 da prova
      -- confere os números.
      SELECT count(*) FILTER (WHERE k.tem_ativa AND sp.account IS NOT NULL) AS s1,
             count(*) FILTER (WHERE NOT k.tem_ativa AND kr.cor_id IS NOT NULL) AS s2,
             count(*) FILTER (WHERE NOT k.tem_ativa) AS bruto,
             count(*) AS universo
        FROM k
        LEFT JOIN sem_preco sp   -- o oráculo: as chaves que o balcão NÃO consegue precificar hoje
               ON sp.account = k.account AND sp.sku_id = k.sku_id AND sp.cor_id = k.cor_id
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

-- PÓS: os invariantes da v4 sobre a função (P1-P6, mesmos textos) + os da v5 (P9-P12) + o da v6 (P13). Por
-- marcador, não por md5: a PRE já fecha o predecessor, e a falsificação da prova aplica corpos
-- sabotados por cima — md5 aqui abortaria toda sabotagem antes dos asserts.
DO $post$
DECLARE
  v_oid  oid := to_regprocedure('public.tint_watchdog_fase5_check()');
  v_hoid oid := to_regprocedure('public._tint_watchdog_fase5_transicao(text,text,bigint,text,text,text,jsonb,numeric)');
  v_src  text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = v_oid;
  IF position('tint_watchdog_fase5 guard v6' IN v_src) = 0 THEN
    RAISE EXCEPTION 'P1 FALHOU: o marcador v6 não está na função';
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
  -- v5/v6: a leitura cara não pode voltar (comentário pode citar a view; código não)
  IF lower(regexp_replace(v_src, '--[^\n]*', '', 'g')) ~ '(from|join)\s+("?public"?\.)?"?v_tint_formula_canonica' THEN
    RAISE EXCEPTION 'P9 FALHOU: a v6 voltou a LER v_tint_formula_canonica (SubPlan por formula, 4,7 GB no Mini)';
  END IF;
  -- exatamente 1 job, ativo, na cadência de 6 h e com o comando INTEIRO (não basta citar a função)
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'tint-watchdog-fase5-6h') <> 1
     OR NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tint-watchdog-fase5-6h' AND active
                       AND schedule = '0 */6 * * *'
                       AND command ~ '^\s*(SET statement_timeout = ''[0-9]+min''; )?SELECT public\.tint_watchdog_fase5_check\(\);\s*$') THEN
    RAISE EXCEPTION 'P10 FALHOU: o cron tint-watchdog-fase5-6h não é 1 job ativo, 0 */6 * * *, chamando só a função';
  END IF;
  -- v6: a config é a do plano por índice, e a da v5 (index scan desligado) não pode sobrar
  IF (SELECT p.proconfig @> ARRAY['enable_seqscan=off', 'work_mem=16MB']
             AND NOT p.proconfig && ARRAY['enable_indexscan=off', 'enable_indexonlyscan=off']
        FROM pg_proc p WHERE p.oid = v_oid) IS NOT TRUE THEN
    RAISE EXCEPTION 'P11 FALHOU: a funcao perdeu a config do plano por indice (sem ela o planner pode voltar ao seq scan de 430/571/291 MB)';
  END IF;
  IF position('9654cfa221f35b4d756fe3a6094bd267' IN v_src) = 0
     OR position('RAISE EXCEPTION ''tint_watchdog_fase5 v6: v_tint_formula_canonica mudou' IN v_src) = 0 THEN
    RAISE EXCEPTION 'P12 FALHOU: o guard da view revisada saiu da função (a cópia do predicado ficaria sem âncora)';
  END IF;
  -- v6: os 5 índices existem, VÁLIDOS, com a definição exata (um homônimo com outra definição não
  -- serve ao plano, e o IF NOT EXISTS não o corrigiria)
  IF (SELECT count(*) FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
       WHERE x.indisvalid AND x.indisready AND (i.relname::text, pg_get_indexdef(i.oid)) IN (
         ('idx_tint_formulas_wd5_carimbo', 'CREATE INDEX idx_tint_formulas_wd5_carimbo ON public.tint_formulas USING btree (account, sku_id, cor_id) WHERE (desativada_motivo = ''fase5_geracao_legada''::text)'),
         ('idx_tint_formulas_wd5_ativas', 'CREATE INDEX idx_tint_formulas_wd5_ativas ON public.tint_formulas USING btree (account, sku_id, cor_id, produto_id, base_id, personalizada) INCLUDE (id) WHERE (desativada_em IS NULL)'),
         ('idx_tint_formula_itens_formula', 'CREATE INDEX idx_tint_formula_itens_formula ON public.tint_formula_itens USING btree (formula_id)'),
         ('idx_tint_formula_itens_corante_formula', 'CREATE INDEX idx_tint_formula_itens_corante_formula ON public.tint_formula_itens USING btree (corante_id, formula_id)'),
         ('idx_tint_staging_formulas_conta_criado', 'CREATE INDEX idx_tint_staging_formulas_conta_criado ON public.tint_staging_formulas USING btree (account, created_at)'))) <> 5 THEN
    RAISE EXCEPTION 'P13 FALHOU: os 5 indices da v6 nao estao todos validos e com a definicao exata (sem eles o ciclo volta a varrer o catalogo)';
  END IF;
  RAISE NOTICE 'tint_watchdog_fase5 v6: indices, guard da view, config do plano, marcador v6, S4/S5, sem corte de 30d, definer, ACL, sem leitura da view, cron ativo';
END
$post$;
