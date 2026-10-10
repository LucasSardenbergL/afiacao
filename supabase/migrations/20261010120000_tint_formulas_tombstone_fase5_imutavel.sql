-- Tombstone da Fase 5 IMUTÁVEL — tint_formulas carimbada 'fase5_geracao_legada' [money-path]
--
-- Resíduo medido via psql-ro em 2026-10-10: as 463.995 linhas que a Fase 5 (#1549, migration
-- 20260727120000) desativou e carimbou com desativada_motivo = 'fase5_geracao_legada' guardam o
-- preco_final_sayersystem que a v_tint_formula_canonica lê como preco_csv_legado (rótulo do balcão)
-- e preco_piso_legado (piso do tint_gate_revalida). Nenhum writer legítimo toca essas linhas: o
-- tint_promote_sync_run tira a chave carimbada do _expand_uniq antes do upsert (5b#1,
-- 20260924120000), o tint_apply_keys_snapshot só desativa linhas com desativada_em IS NULL e o app só
-- faz SELECT em tint_formulas. A única RPC que mexia no preço (import_tint_formulas) foi dropada em
-- 20260806223407.
--
-- Mesmo assim o tombstone NÃO era imutável: relacl authenticated=arwdDxtm + policy "Staff can manage
-- tint_formulas" (polcmd '*', employee|master) ⇒ um PATCH /rest/v1/tint_formulas de qualquer staff
-- muda o preço da linha carimbada; um INSERT de outra linha carimbada com o mesmo (account, sku_id,
-- cor_id) e preço maior move o max() da view; um DELETE derruba o piso. Não havia trigger, e
-- updated_at não é mantido automaticamente ⇒ a mutação fica PERMANENTE (nenhum writer a corrige) e
-- SEM RASTRO. ⚠️ information_schema.role_table_grants não serve para medir isso: use relacl /
-- has_table_privilege.
--
-- Desenho:
--   * 3 triggers BEFORE (INSERT/UPDATE/DELETE) FOR EACH ROW, cada um com cláusula WHEN no motivo:
--     o caminho quente (promote, snapshot) tem desativada_motivo NULL no OLD e no NEW ⇒ o WHEN é
--     avaliado no executor e a função plpgsql NÃO é chamada. Custo zero no promote, que já sofreu
--     com timeout de gateway.
--   * Linha carimbada vira imutável por INTEIRO (qualquer coluna: o max() da view chaveia em
--     account/sku_id/cor_id + subcoleção '1', e trocar a chave move o piso tanto quanto trocar o
--     preço). UPDATE no-op (NEW = OLD) passa.
--   * Carimbar linha nova (INSERT ou UPDATE com NEW.desativada_motivo = 'fase5_geracao_legada')
--     também é barrado: só a Fase 5 carimbava, e ela é one-shot.
--   * Escape de manutenção (reversão documentada da Fase 5 ou re-carimbo deliberado): na MESMA
--     transação, SET LOCAL afiacao.tint_tombstone_manutencao = 'on', e só vale fora das roles da API
--     (anon/authenticated). O PostgREST não consegue setar GUC arbitrário, e a checagem de role
--     fecha a porta mesmo que algum dia consiga.
--   * SQLSTATE 42501 (o PostgREST devolve 403) com o prefixo tint_tombstone_fase5_imutavel.
--   * 2º vetor, fora de tint_formulas: a view só lê o tombstone se a subcoleção dele tem
--     id_subcolecao_sayersystem = '1'. tint_subcolecoes tem a mesma policy "Staff can manage" cmd '*'
--     ⇒ UM PATCH renomeando a linha '1' (ou trocando o account dela) tirava os 463.995 tombstones do
--     max() de uma vez. Trigger BEFORE UPDATE barra essa troca (mesmo escape). O DELETE já é barrado
--     pela FK NO ACTION de tint_formulas.subcolecao_id. Único writer: o promote, com ON CONFLICT DO
--     NOTHING (nunca atualiza).
--
-- Aplicar: colar no SQL Editor do Lovable (nome custom não é aplicado automaticamente). É idempotente
-- (CREATE OR REPLACE + DROP TRIGGER IF EXISTS) e transacional. A pós-condição, além do catálogo,
-- EXECUTA um UPDATE real numa linha carimbada e exige o 42501; o subbloco reverte, nenhum dado muda.
-- Prova: db/test-tint-tombstone-fase5-imutavel.sh.

BEGIN;

-- CREATE TRIGGER pega SHARE ROW EXCLUSIVE em tint_formulas (conflita com os writers do promote). Se
-- um promote estiver rodando, falha rápido em vez de enfileirar; basta colar de novo.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.tint_formulas_guard_tombstone_fase5()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- Escape de manutenção: GUC explícito na transação E fora das roles da API.
  IF current_setting('afiacao.tint_tombstone_manutencao', true) = 'on'
     AND current_user NOT IN ('anon', 'authenticated') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  -- UPDATE que não muda nada não mexe no piso.
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'tint_tombstone_fase5_imutavel: % barrado em tint_formulas (id %)',
                  TG_OP, CASE WHEN TG_OP = 'INSERT' THEN NEW.id ELSE OLD.id END
    USING ERRCODE = '42501',
          DETAIL  = 'Linha carimbada desativada_motivo=fase5_geracao_legada: o preco_final_sayersystem dela é o piso do tint_gate_revalida e o rótulo do balcão.',
          HINT    = 'Manutenção deliberada: ver docs/agent/tintometrico.md (tombstone da Fase 5).';
END
$fn$;

COMMENT ON FUNCTION public.tint_formulas_guard_tombstone_fase5() IS
  'Tombstone da Fase 5 imutável (20261010120000): barra INSERT/UPDATE/DELETE de linha tint_formulas carimbada fase5_geracao_legada. Escape: SET LOCAL afiacao.tint_tombstone_manutencao=on fora de anon/authenticated.';

-- Função de trigger não precisa de EXECUTE para disparar; fecha a chamada direta pelas duas pontas.
REVOKE ALL ON FUNCTION public.tint_formulas_guard_tombstone_fase5() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tint_formulas_guard_tombstone_fase5() FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_tint_formulas_tombstone_fase5_ins ON public.tint_formulas;
DROP TRIGGER IF EXISTS trg_tint_formulas_tombstone_fase5_upd ON public.tint_formulas;
DROP TRIGGER IF EXISTS trg_tint_formulas_tombstone_fase5_del ON public.tint_formulas;

CREATE TRIGGER trg_tint_formulas_tombstone_fase5_ins
  BEFORE INSERT ON public.tint_formulas
  FOR EACH ROW
  WHEN (NEW.desativada_motivo = 'fase5_geracao_legada')
  EXECUTE FUNCTION public.tint_formulas_guard_tombstone_fase5();

CREATE TRIGGER trg_tint_formulas_tombstone_fase5_upd
  BEFORE UPDATE ON public.tint_formulas
  FOR EACH ROW
  WHEN (OLD.desativada_motivo = 'fase5_geracao_legada' OR NEW.desativada_motivo = 'fase5_geracao_legada')
  EXECUTE FUNCTION public.tint_formulas_guard_tombstone_fase5();

CREATE TRIGGER trg_tint_formulas_tombstone_fase5_del
  BEFORE DELETE ON public.tint_formulas
  FOR EACH ROW
  WHEN (OLD.desativada_motivo = 'fase5_geracao_legada')
  EXECUTE FUNCTION public.tint_formulas_guard_tombstone_fase5();

CREATE OR REPLACE FUNCTION public.tint_subcolecoes_guard_tombstone_fase5()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF current_setting('afiacao.tint_tombstone_manutencao', true) = 'on'
     AND current_user NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'tint_tombstone_fase5_imutavel: rename da subcoleção ''1'' barrado em tint_subcolecoes (id %)', OLD.id
    USING ERRCODE = '42501',
          DETAIL  = 'A v_tint_formula_canonica só lê o tombstone da Fase 5 na subcoleção id_subcolecao_sayersystem=1: renomeá-la derruba o piso de todas as linhas carimbadas.',
          HINT    = 'Manutenção deliberada: ver docs/agent/tintometrico.md (tombstone da Fase 5).';
END
$fn$;

COMMENT ON FUNCTION public.tint_subcolecoes_guard_tombstone_fase5() IS
  'Tombstone da Fase 5 (20261010120000): barra trocar id_subcolecao_sayersystem/account da subcoleção ''1''. Escape: SET LOCAL afiacao.tint_tombstone_manutencao=on fora de anon/authenticated.';

REVOKE ALL ON FUNCTION public.tint_subcolecoes_guard_tombstone_fase5() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tint_subcolecoes_guard_tombstone_fase5() FROM anon, authenticated;

DROP TRIGGER IF EXISTS trg_tint_subcolecoes_tombstone_fase5_upd ON public.tint_subcolecoes;

CREATE TRIGGER trg_tint_subcolecoes_tombstone_fase5_upd
  BEFORE UPDATE ON public.tint_subcolecoes
  FOR EACH ROW
  WHEN (OLD.id_subcolecao_sayersystem = '1'
        AND (NEW.id_subcolecao_sayersystem IS DISTINCT FROM OLD.id_subcolecao_sayersystem
             OR NEW.account IS DISTINCT FROM OLD.account))
  EXECUTE FUNCTION public.tint_subcolecoes_guard_tombstone_fase5();

-- Pós-condição: catálogo + EXECUÇÃO (plpgsql é late-bound; trigger criado não prova trigger que morde).
DO $pos$
DECLARE
  v_trg int;
  v_id  uuid;
BEGIN
  SELECT count(*) INTO v_trg
    FROM pg_trigger
   WHERE tgrelid = 'public.tint_formulas'::regclass
     AND tgname IN ('trg_tint_formulas_tombstone_fase5_ins',
                    'trg_tint_formulas_tombstone_fase5_upd',
                    'trg_tint_formulas_tombstone_fase5_del')
     AND tgenabled = 'O';
  IF v_trg <> 3 THEN
    RAISE EXCEPTION 'pós-condição: esperava 3 triggers do tombstone habilitados, achei %', v_trg;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.tint_subcolecoes'::regclass
                    AND tgname = 'trg_tint_subcolecoes_tombstone_fase5_upd' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'pós-condição: trigger da subcoleção ''1'' ausente ou desabilitado';
  END IF;

  IF has_function_privilege('anon', 'public.tint_formulas_guard_tombstone_fase5()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_formulas_guard_tombstone_fase5()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tint_subcolecoes_guard_tombstone_fase5()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_subcolecoes_guard_tombstone_fase5()', 'EXECUTE') THEN
    RAISE EXCEPTION 'pós-condição: função de trigger executável por anon/authenticated';
  END IF;

  SELECT id INTO v_id FROM public.tint_formulas
   WHERE desativada_motivo = 'fase5_geracao_legada' LIMIT 1;
  IF v_id IS NULL THEN
    RAISE NOTICE 'pós-condição: nenhuma linha carimbada neste banco — teste de execução pulado';
    RETURN;
  END IF;

  BEGIN
    UPDATE public.tint_formulas
       SET preco_final_sayersystem = preco_final_sayersystem + 1
     WHERE id = v_id;
    RAISE EXCEPTION 'pós-condição: UPDATE no tombstone % PASSOU — o trigger não morde', v_id;
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE 'tint_tombstone_fase5_imutavel:%' THEN RAISE; END IF;
  END;
END
$pos$;

COMMIT;

SELECT 'TINT_TOMBSTONE_FASE5_IMUTAVEL_OK' AS marcador;
