-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico — o tombstone da Fase 5 só alimenta o RÓTULO se for da GERAÇÃO '1'
-- (revisão dos invariantes do piso contra a Fase 5, 2026-10-16).
--
-- O FURO (latente): a 20260727120000 deixou o `csv_legado` aceitar linha
-- DESATIVADA com `desativada_motivo = 'fase5_geracao_legada'`. No ramo em que a
-- canônica é SL, a allowlist (`EXISTS ... id_subcolecao_sayersystem = '1'`)
-- filtra a geração. Mas no ramo NÃO-SL ela nem dispara (`NOT rf.is_sl`), e aí o
-- predicado confia só no `motivo`: uma linha carimbada de QUALQUER geração —
-- ou da '1' de OUTRA conta — alimentaria o rótulo "Tabela (versão anterior)",
-- afirmando proveniência que não existe.
--
-- POR QUE É LATENTE, NÃO VIVO (psql-ro, 2026-10-16):
--   • os 463.995 tombstones caem 100% na geração '1' (é exatamente o número de
--     chaves SL com geração '1' medido em 2026-07-21);
--   • o trigger da 20261010120000 barra INSERT/UPDATE/DELETE de linha carimbada
--     e o rename da subcoleção '1'; a única porta é o GUC
--     `afiacao.tint_tombstone_manutencao`, que nenhuma função liga e o PostgREST
--     não deixa o cliente setar — só acesso direto ao banco.
--   ⇒ DELTA CONTRA A PROD: 0 linhas. Blindagem: o carimbo deixa de ser, sozinho,
--     prova de proveniência.
--
-- EFEITO NO PISO (honesto): nesse cenário hipotético o piso também DESCE — a
-- linha forjada entrava no `csv_legado` e, por ele, no GREATEST. Isso é correto:
-- uma linha desativada que não é a geração '1' é tratada como qualquer outra
-- desativada (V2: "a fonte aposentou" fica fora do rótulo E do piso). Linha
-- morta não é evidência de preço. I1 e I2 seguem por CONSTRUÇÃO (o GREATEST não
-- muda), e E1/E2 do gate não dependem desta expressão.
--
-- REPLACE: view VERBATIM da 20260727120000 exceto o predicado do carimbo e uma
-- frase do COMMENT. Ordem das 14 colunas preservada e WITH (security_invoker =
-- on) REPETIDO (omitir RESETA a opção → a view bypassa RLS, armadilha #1375).
-- Prova: db/test-tint-fase5-desativacao.sh (V10/V11 + falsificações F5/F6).
-- ═══════════════════════════════════════════════════════════════════════════

-- Sem BEGIN/COMMIT: o `bun run db:aplicar` abre a transação (e recusa o arquivo
-- que traz a sua). Pré-voo e pós-condição abortam a transação DELE.

-- ── PRÉ-VOO: o delta tem de ser 0. Tombstone fora da geração '1' da mesma conta
-- mudaria o rótulo de alguma chave — isso exige decisão humana, não um REPLACE.
DO $pre$
DECLARE v_fora int;
BEGIN
  SELECT count(*) INTO v_fora
    FROM public.tint_formulas f
   WHERE f.desativada_motivo = 'fase5_geracao_legada'
     AND NOT EXISTS (SELECT 1 FROM public.tint_subcolecoes s
                      WHERE s.id = f.subcolecao_id AND s.account = f.account
                        AND s.id_subcolecao_sayersystem = '1');
  IF v_fora > 0 THEN
    RAISE EXCEPTION 'ENDURECIMENTO ABORTADO: % linha(s) carimbada(s) fase5 fora da geração ''1'' da própria conta — o REPLACE mudaria o rótulo delas; decida antes', v_fora;
  END IF;
END
$pre$;

CREATE OR REPLACE VIEW public.v_tint_formula_canonica
WITH (security_invoker = on)
AS
SELECT
  f.id,
  f.account,
  f.sku_id,
  f.cor_id,
  f.nome_cor,
  f.preco_final_sayersystem,
  f.subcolecao_id,
  f.personalizada,
  f.updated_at,
  rf.is_sl,
  rf.tem_receita,
  rf.receita_valida,
  -- 13ª — RÓTULO ("Tabela (versão anterior)"): allowlist da geração '1'
  -- (20260724130000, semântica preservada) + [FASE 5] a linha CARIMBADA por
  -- esta fase segue contando mesmo desativada. Linha desativada por OUTRO
  -- motivo (a fonte retirou a chave — 16.958 hoje, 1.704 em chave com SL
  -- ativa) continua FORA.
  lg.csv_legado AS preco_csv_legado,
  -- 14ª — PISO do gate de submit: conservadorismo, NÃO proveniência.
  CASE
    WHEN lg.csv_legado IS NULL THEN NULL
    ELSE GREATEST(lg.csv_legado, COALESCE(lg.max_ativo, lg.csv_legado))
  END AS preco_piso_legado
FROM public.tint_formulas f
CROSS JOIN LATERAL (
  -- rank de preferência da PRÓPRIA linha (bloco gêmeo do rank da gêmea, abaixo)
  SELECT v.is_sl,
         v.tem_receita,
         (v.tem_receita AND v.corantes_ok) AS receita_valida,
         CASE WHEN v.is_sl AND v.tem_receita AND v.corantes_ok THEN 0
              WHEN v.tem_receita AND v.corantes_ok             THEN 1
              WHEN v.is_sl                                     THEN 2
              ELSE 3 END AS rank_pref
  FROM (
    SELECT
      EXISTS (SELECT 1 FROM public.tint_subcolecoes s
              WHERE s.id = f.subcolecao_id
                AND s.account = f.account
                AND s.id_subcolecao_sayersystem = 'SL') AS is_sl,
      EXISTS (SELECT 1 FROM public.tint_formula_itens fi
              WHERE fi.formula_id = f.id) AS tem_receita,
      -- [MIRROR get_tint_prices.corantes_completos] todo item precisa de corante
      -- com omie valor>0 + ativo + volume>0; item órfão de corante conta como ruim.
      NOT EXISTS (
        SELECT 1
        FROM public.tint_formula_itens fi
        LEFT JOIN public.tint_corantes c  ON c.id = fi.corante_id
        LEFT JOIN public.omie_products op ON op.id = c.omie_product_id
        WHERE fi.formula_id = f.id
          AND NOT (COALESCE(op.valor_unitario, 0) > 0
                   AND COALESCE(op.ativo, false)
                   AND c.volume_total_ml IS NOT NULL
                   AND c.volume_total_ml > 0)
      ) AS corantes_ok
  ) v
) rf
CROSS JOIN LATERAL (
  -- CSV legado (uma única vez) + max das ATIVAS. Depende de rf.is_sl, por isso
  -- vem depois do LATERAL rf.
  SELECT
    (SELECT max(g2.preco_final_sayersystem)
       FROM public.tint_formulas g2
      WHERE g2.account = f.account
        AND g2.sku_id  = f.sku_id
        AND g2.cor_id  = f.cor_id
        -- [ENDURECIMENTO 20261016140000] o carimbo sozinho NÃO basta: a linha
        -- tombstoned só entra se for da geração '1' da MESMA conta. No ramo
        -- não-SL a allowlist abaixo nem dispara (NOT rf.is_sl), então antes
        -- daqui uma linha carimbada de QUALQUER geração alimentaria o rótulo.
        AND (g2.desativada_em IS NULL
             OR (g2.desativada_motivo = 'fase5_geracao_legada' AND EXISTS (SELECT 1 FROM public.tint_subcolecoes s3 WHERE s3.id = g2.subcolecao_id AND s3.account = g2.account AND s3.id_subcolecao_sayersystem = '1')))
        AND (NOT rf.is_sl
             OR EXISTS (SELECT 1 FROM public.tint_subcolecoes s2
                        WHERE s2.id = g2.subcolecao_id
                          AND s2.account = g2.account
                          AND s2.id_subcolecao_sayersystem = '1'))) AS csv_legado,
    (SELECT max(g3.preco_final_sayersystem)
       FROM public.tint_formulas g3
      WHERE g3.account = f.account
        AND g3.sku_id  = f.sku_id
        AND g3.cor_id  = f.cor_id
        AND g3.desativada_em IS NULL) AS max_ativo
) lg
-- NÃO relaxa: só linha ATIVA é candidata a canônica. Relaxar aqui ressuscitaria
-- no catálogo exatamente o que esta fase tira dele.
WHERE f.desativada_em IS NULL
  AND f.sku_id IS NOT NULL
  AND NOT EXISTS (
    -- existe gêmea MELHOR na mesma chave? (rank menor; empate → menor id vence)
    SELECT 1
    FROM public.tint_formulas g
    CROSS JOIN LATERAL (
      -- rank de preferência da GÊMEA — bloco gêmeo verbatim do rank acima
      SELECT CASE WHEN w.is_sl AND w.tem_receita AND w.corantes_ok THEN 0
                  WHEN w.tem_receita AND w.corantes_ok             THEN 1
                  WHEN w.is_sl                                     THEN 2
                  ELSE 3 END AS rank_pref
      FROM (
        SELECT
          EXISTS (SELECT 1 FROM public.tint_subcolecoes s
                  WHERE s.id = g.subcolecao_id
                    AND s.account = g.account
                    AND s.id_subcolecao_sayersystem = 'SL') AS is_sl,
          EXISTS (SELECT 1 FROM public.tint_formula_itens fi
                  WHERE fi.formula_id = g.id) AS tem_receita,
          NOT EXISTS (
            SELECT 1
            FROM public.tint_formula_itens fi
            LEFT JOIN public.tint_corantes c  ON c.id = fi.corante_id
            LEFT JOIN public.omie_products op ON op.id = c.omie_product_id
            WHERE fi.formula_id = g.id
              AND NOT (COALESCE(op.valor_unitario, 0) > 0
                       AND COALESCE(op.ativo, false)
                       AND c.volume_total_ml IS NOT NULL
                       AND c.volume_total_ml > 0)
          ) AS corantes_ok
      ) w
    ) rg
    WHERE g.account = f.account
      AND g.sku_id  = f.sku_id
      AND g.cor_id  = f.cor_id
      -- NÃO relaxa, mesmo motivo do filtro de candidata acima
      AND g.desativada_em IS NULL
      AND g.id <> f.id
      AND (rg.rank_pref < rf.rank_pref
           OR (rg.rank_pref = rf.rank_pref AND g.id < f.id))
  );

COMMENT ON VIEW public.v_tint_formula_canonica IS
  'Fase 2 tintométrico: 1 fórmula canônica por (account, sku_id, cor_id) — '
  'preferência SL válida, fallback SAYERLACK/personalizada; não desativa nada. '
  'receita_valida espelha corantes_completos da RPC get_tint_prices (validade '
  'POR FÓRMULA; base_disponivel fica fora — gêmeas compartilham o SKU). '
  'preco_csv_legado = RÓTULO "Tabela (versão anterior)" (allowlist da geração '
  '''1'' quando a canônica é SL — precisão de PROVENIÊNCIA). '
  'preco_piso_legado = PISO do gate de submit (CONSERVADORISMO) = '
  'GREATEST(csv, COALESCE(max das ATIVAS, csv)) — I1 ((csv NULL) ⟺ (piso '
  'NULL)) e I2 (piso >= csv) por CONSTRUÇÃO, não por convenção textual. '
  'FASE 5 (2026-07-27): o CSV aceita também a linha DESATIVADA carimbada '
  'desativada_motivo=''fase5_geracao_legada'' — sobrevive à desativação da '
  'geração ''1'' (decisão do founder, opção B); linha desativada por OUTRO '
  'motivo (fonte retirou a chave) segue FORA, senão o rótulo afirmaria '
  'proveniência de dado aposentado e o piso cairia junto. O max do PISO lê só '
  'ATIVAS. O filtro de CANDIDATA a canônica NÃO foi relaxado. '
  'ENDURECIMENTO 2026-10-16: a linha carimbada só entra se for da geração '
  '''1'' da MESMA conta — o carimbo sozinho não prova proveniência. '
  'security_invoker=on: repetir o WITH em todo replace (#1375).';

-- Grants inalterados (REPLACE preserva ACL); re-afirmados por idempotência.
REVOKE ALL ON public.v_tint_formula_canonica FROM PUBLIC;
REVOKE ALL ON public.v_tint_formula_canonica FROM anon;
GRANT SELECT ON public.v_tint_formula_canonica TO authenticated;
GRANT SELECT ON public.v_tint_formula_canonica TO service_role;

-- ── PÓS-CONDIÇÃO: shape, security_invoker e o predicado novo de fato no ar.
DO $pos$
DECLARE v_cols text; v_def text;
BEGIN
  SELECT string_agg(a.attname, ',' ORDER BY a.attnum) INTO v_cols
    FROM pg_attribute a
   WHERE a.attrelid = 'public.v_tint_formula_canonica'::regclass
     AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_cols IS DISTINCT FROM 'id,account,sku_id,cor_id,nome_cor,preco_final_sayersystem,subcolecao_id,personalizada,updated_at,is_sl,tem_receita,receita_valida,preco_csv_legado,preco_piso_legado' THEN
    RAISE EXCEPTION 'pós-condição: shape da view mudou: %', v_cols;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.v_tint_formula_canonica'::regclass
                    AND reloptions @> ARRAY['security_invoker=on']) THEN
    RAISE EXCEPTION 'pós-condição: a view PERDEU security_invoker=on (#1375)';
  END IF;
  -- Trecho CONTÍGUO da definição reconstruída (sem 'public.', espaço normalizado):
  -- trava de uma vez o AGRUPAMENTO (ativa OR (carimbada AND geração)), a correlação
  -- por id, o guard de CONTA e o literal '1'. Uma substring solta (só o literal)
  -- aceitava a view sem o guard de conta — achado do challenge Codex 2026-10-16.
  -- O trecho inclui as FRONTEIRAS: começa na correlação da chave (`g2.cor_id = f.cor_id
  -- AND (`) e termina na allowlist (`) AND (NOT rf.is_sl`). Sem elas, tirar os
  -- parênteses externos — `chave AND ativa OR carimbada…` — mantinha o miolo contíguo
  -- e, pela precedência, deixava tombstone de OUTRA chave entrar no max (2ª rodada do
  -- challenge Codex). quote_all_identifiers fixado: ligado, o deparse sai com aspas e a
  -- view CORRETA seria reprovada.
  PERFORM set_config('quote_all_identifiers', 'off', true);
  v_def := regexp_replace(replace(pg_get_viewdef('public.v_tint_formula_canonica'::regclass, true), 'public.', ''), '\s+', ' ', 'g');
  IF position('g2.cor_id = f.cor_id AND (g2.desativada_em IS NULL OR g2.desativada_motivo = ''fase5_geracao_legada''::text AND (EXISTS ( SELECT 1 FROM tint_subcolecoes s3 WHERE s3.id = g2.subcolecao_id AND s3.account = g2.account AND s3.id_subcolecao_sayersystem = ''1''::text))) AND (NOT rf.is_sl' IN v_def) = 0 THEN
    RAISE EXCEPTION 'pós-condição: o endurecimento do carimbo não está na view (agrupamento, correlação, conta ou literal)';
  END IF;
END
$pos$;

