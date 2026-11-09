-- ENVELOPE — apply em massa do "segurar compra" na Oben: suspende a recompra dos SKUs de giro com cobertura ≥180d
-- (365d E 90d), fora corante (Concentrados LC) e substituídos, pela RPC reposicao_compra_suspender (1 writer).
-- Spec: docs/superpowers/specs/2026-10-31-reposicao-compra-suspensa-design.md §4. Decisão do founder 2026-10-31
-- ("todos, com sensor junto"); OK para ESTA lista dado no chat ANTES de rodar (Codex P1-11: o apply compara CONJUNTOS,
-- não contagens — a lista aprovada vai literal em :skus_aprovados; quem saiu da coorte entre o relatório e o apply
-- NÃO é suspenso e é listado; quem entrou NÃO é suspenso).
--
-- Pré-requisitos: migration 20261101090000 aplicada (RPCs + motor). Pré-voo psql-ro 🟢: relatório gerado por
--   SELECT * FROM reposicao_compra_suspensa_candidatos('OBEN', 180)   (ver db/relatorio-compra-suspensa-oben.sql)
-- Como rodar:  bun run db:aplicar db/aplicar-compra-suspensa-oben-180d.sql [--ensaio]   (NÃO pelo SQL Editor: o
--   executor abre a transação, eleva via aplicar_sql e grava o recibo — as RPCs não têm EXECUTE para claude_rw cru).
--   Idempotente: re-rodar não duplica (índice único parcial). A PÓS aborta (ROLLBACK) se algum aprovado-ainda-candidato
--   ficou sem suspensão ativa. Lista aprovada pelo founder no chat em 2026-11-01 ("Aprovo os 156"), relatório em
--   db/relatorio-compra-suspensa-oben.sql rodado às 04:3x UTC do mesmo dia.
-- 2ª testemunha depois (psql-ro): SELECT count(*), round(sum(foto_valor)) FROM reposicao_compra_suspensa
--   WHERE empresa='OBEN' AND lote_id = '<lote>' AND reativado_em IS NULL;
-- Rollback (dado, não DDL):
--   SELECT * FROM reposicao_compra_reativar('OBEN',
--     (SELECT array_agg(sku_codigo_omie) FROM reposicao_compra_suspensa WHERE lote_id = '<lote>' AND reativado_em IS NULL),
--     'rollback do lote <lote>');

DO $apply$
DECLARE
  -- Lista APROVADA no chat (2026-11-01, 156 SKUs do relatório). Vazio = aborta.
  v_aprovados bigint[] := ARRAY[8689717622,8689717670,8689717862,8689718264,8689719378,8689719640,8689720013,8689720593,8689722134,8689723060,8689723220,8689723345,8689723623,8689723696,8689724694,8689725397,8689733110,8689733271,8689733285,8689733385,8689733561,8689733595,8689734049,8689734079,8689734282,8689736180,8689736649,8689737046,8689737089,8689738544,8689738594,8689743537,8689743938,8689743946,8689744001,8689744095,8689744294,8689744357,8689747305,8689748828,8689754365,8689755116,8689758598,8689767660,8689767822,8689767990,8689772792,8689774848,8689775138,8689775154,8689775976,8689776195,8689777582,8689778161,8689780900,8689781372,8689781974,8689782971,8689783019,8689783028,8689783045,8689783107,8689783601,8689783726,8689783764,8689785564,8689787091,8689787155,8689787819,8689790656,8689791806,8689792006,8689792436,8689799621,8689801756,8689830651,8689841061,8689896241,8689918326,8689920099,8689943084,8689953577,8689966291,8689966887,8689969466,8689987093,8689991839,8689998664,8690029004,8690057695,8690082066,8690108598,8693457227,8708530008,8708996871,8715462667,8724114259,8746399091,8774130334,8815856551,11805862467,11811804612,11875989549,11881176542,11881176563,11884877398,11884877433,11884877477,11890910909,11921548964,11929926261,11930978060,11965567838,11965568711,11972748911,11973921249,11973921420,11973921757,11978609369,11979982999,11980303279,11997163185,11998004546,11998009356,12009650336,12009650493,12009650552,12009650599,12042250258,12042877848,12042877863,12043706026,12044994786,12044994881,12045637008,12053035209,12053035310,12060446744,12070121951,12074056924,12085963041,12097949925,12097950432,12098385775,12101097803,12101098529,12101724546,12101724828,12121081870,12121817081,12126901999,12128274046,12151837332,12188088383,12188088411,12188292968]::bigint[];
  v_lote uuid := gen_random_uuid();
  v_motivo text := 'Leva PME Oben 2026-11: cobertura >= 180 dias (365d e 90d) na foto do apply; revisar em 90 dias';
  v_candidatos bigint[];
  v_alvo bigint[];
  v_sairam bigint[];
  v_entraram bigint[];
  v_inseridos int;
  v_recusados int;
  v_valor numeric;
BEGIN
  IF cardinality(v_aprovados) = 0 THEN
    RAISE EXCEPTION 'APPLY ABORTADO: lista aprovada vazia — cole os SKUs do relatório em v_aprovados';
  END IF;

  -- Coorte RECALCULADA agora (a RPC falha P0001 se a fonte de consumo não estiver fresca — fail-closed).
  SELECT coalesce(array_agg(c.sku_codigo_omie), ARRAY[]::bigint[]) INTO v_candidatos
    FROM public.reposicao_compra_suspensa_candidatos('OBEN', 180) c;

  -- Conjuntos: só o que foi APROVADO e AINDA é candidato é suspenso.
  SELECT coalesce(array_agg(s), ARRAY[]::bigint[]) INTO v_alvo    FROM unnest(v_aprovados) s WHERE s = ANY (v_candidatos);
  SELECT coalesce(array_agg(s), ARRAY[]::bigint[]) INTO v_sairam  FROM unnest(v_aprovados) s WHERE NOT (s = ANY (v_candidatos));
  SELECT coalesce(array_agg(s), ARRAY[]::bigint[]) INTO v_entraram FROM unnest(v_candidatos) s WHERE NOT (s = ANY (v_aprovados));
  RAISE NOTICE 'lote % · aprovados % · ainda candidatos % · sairam da coorte (NAO suspensos) % · entraram depois do relatorio (NAO suspensos) %',
    v_lote, cardinality(v_aprovados), cardinality(v_alvo), v_sairam, v_entraram;

  IF cardinality(v_alvo) = 0 THEN
    RAISE EXCEPTION 'APPLY ABORTADO: nenhum aprovado continua candidato (coorte mudou ou ja suspensa) — regenere o relatorio';
  END IF;

  SELECT count(*) FILTER (WHERE r.inserido), count(*) FILTER (WHERE NOT r.inserido)
    INTO v_inseridos, v_recusados
    FROM public.reposicao_compra_suspender('OBEN', v_alvo, v_motivo,
           ((now() AT TIME ZONE 'America/Sao_Paulo')::date + 90), 'envelope', v_lote) r;
  RAISE NOTICE 'suspender: inseridos % · recusados/ja suspensos %', v_inseridos, v_recusados;

  -- PÓS: todo aprovado-ainda-candidato tem suspensão ATIVA (deste lote ou anterior); senão ROLLBACK.
  IF EXISTS (SELECT 1 FROM unnest(v_alvo) s
              WHERE NOT EXISTS (SELECT 1 FROM public.reposicao_compra_suspensa cs
                                 WHERE cs.empresa = 'OBEN' AND cs.sku_codigo_omie = s AND cs.reativado_em IS NULL)) THEN
    RAISE EXCEPTION 'POS FALHOU: ha SKU aprovado sem suspensao ativa apos o apply — nada foi gravado';
  END IF;
  SELECT round(sum(cs.foto_valor)) INTO v_valor
    FROM public.reposicao_compra_suspensa cs WHERE cs.lote_id = v_lote AND cs.reativado_em IS NULL;
  RAISE NOTICE 'COMPRA-SUSPENSA-APPLY-OK lote % · % suspensoes novas · R$ % em estoque na foto · a suspensao vale no PROXIMO run do motor (<=2h ou Recalcular)',
    v_lote, v_inseridos, coalesce(v_valor::text, '—');
END
$apply$;
