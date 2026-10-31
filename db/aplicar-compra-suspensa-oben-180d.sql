-- ENVELOPE — apply em massa do "segurar compra" na Oben: suspende a recompra dos SKUs de giro com cobertura ≥180d
-- (365d E 90d), fora corante (Concentrados LC) e substituídos, pela RPC reposicao_compra_suspender (1 writer).
-- Spec: docs/superpowers/specs/2026-10-31-reposicao-compra-suspensa-design.md §4. Decisão do founder 2026-10-31
-- ("todos, com sensor junto"); OK para ESTA lista dado no chat ANTES de rodar (Codex P1-11: o apply compara CONJUNTOS,
-- não contagens — a lista aprovada vai literal em :skus_aprovados; quem saiu da coorte entre o relatório e o apply
-- NÃO é suspenso e é listado; quem entrou NÃO é suspenso).
--
-- Pré-requisitos: migration 20261101090000 aplicada (RPCs + motor). Pré-voo psql-ro 🟢: relatório gerado por
--   SELECT * FROM reposicao_compra_suspensa_candidatos('OBEN', 180)   (ver db/relatorio-compra-suspensa-oben.sql)
-- Como rodar (SQL Editor do Lovable, colagem inteira; idempotente — re-rodar não duplica, índice único parcial):
--   1. substitua a lista em v_aprovados pelos SKUs do relatório aprovado;
--   2. cole o arquivo inteiro; a PÓS aborta (ROLLBACK) se algum aprovado-ainda-candidato ficou sem suspensão ativa.
-- 2ª testemunha depois (psql-ro): SELECT count(*), round(sum(foto_valor)) FROM reposicao_compra_suspensa
--   WHERE empresa='OBEN' AND lote_id = '<lote>' AND reativado_em IS NULL;
-- Rollback (dado, não DDL):
--   SELECT * FROM reposicao_compra_reativar('OBEN',
--     (SELECT array_agg(sku_codigo_omie) FROM reposicao_compra_suspensa WHERE lote_id = '<lote>' AND reativado_em IS NULL),
--     'rollback do lote <lote>');

BEGIN;

DO $apply$
DECLARE
  -- ⚠️ SUBSTITUA pela lista aprovada no chat (relatório do dia). Vazio = aborta.
  v_aprovados bigint[] := ARRAY[]::bigint[];
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

COMMIT;
