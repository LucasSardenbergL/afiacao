-- ============================================================
-- Clientes MEI: o CPF do titular é GRAVADO mascarado no nome do cliente
-- Decisão do founder (2026-11-10), medição em docs/historico/clientes-mei-cpf-no-nome-medicao-2026-11-10.md.
--
-- O nome de MEI que vem do Omie termina no CPF do titular ('FULANO DE TAL 12345678901'). Em prod: 1.888 linhas de
-- profiles.name e 685 de venda_items_history.cliente_razao_social. O nome sai em ~73 telas de staff, em prompts de
-- LLM, no MCP, em link de WhatsApp e em impressão; o CPF não serve a nenhuma operação do app (profiles.document já
-- guarda o CNPJ do MEI).
--
-- Mesmo padrão do pacote J do Radar: um trigger BEFORE mascara na ENTRADA, para qualquer escritor (edge omie-cliente,
-- cadastro, tela de perfil, sync de itens), e o backfill regrava o que já está no banco. A máscara é a
-- private.radar_razao_mascarada (formato do QSA da RFB, dígitos 4 a 9 visíveis, CPF com ou sem separador em qualquer
-- posição). SEM cópia crua: a razão fiscal vive no próprio Omie e o app nunca a regrava (não há AlterarCliente). O
-- IncluirCliente das duas edges recusa a razão mascarada (_shared/razao-fiscal.ts): as edges omie-sync v1.11 e
-- omie-vendas-sync v1.34 TÊM de estar no ar ANTES desta migration.
--
-- O vínculo do Radar (private.radar_vinculos_base) aceita o nome do perfil cru ou mascarado
-- (private.radar_titular_mascara), então decide igual depois do backfill.
--
-- Caminho: SQL Editor (envelope BEGIN/COMMIT abaixo). Idempotente: re-colar não muda nada.
-- ============================================================

BEGIN;

-- TRAVA: nenhum escritor entra entre o trigger e o backfill.
LOCK TABLE public.profiles, public.venda_items_history IN SHARE ROW EXCLUSIVE MODE;

-- PRE: a máscara de que isto depende é a do formato livre (20261112100000), provada por EXECUÇÃO.
DO $pre$
BEGIN
  IF to_regprocedure('private.radar_razao_mascarada(text)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_razao_mascarada(text) não existe — aplique antes a 20261111150000 e a 20261112100000';
  END IF;
  IF private.radar_razao_mascarada('FULANO DE TAL 12345678901') IS DISTINCT FROM 'FULANO DE TAL ***456789**'
     OR private.radar_razao_mascarada('FULANO DE TAL 123.456.789-01') IS DISTINCT FROM 'FULANO DE TAL ***.456.789-**'
     OR private.radar_razao_mascarada('FULANO 12345678901 ME') IS DISTINCT FROM 'FULANO ***456789** ME'
     OR private.radar_razao_mascarada('ACME LTDA 12345678000195') IS DISTINCT FROM 'ACME LTDA 12345678000195' THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_razao_mascarada não é a do formato livre (20261112100000) — reconcilie antes';
  END IF;
END
$pre$;

-- ------------------------------------------------------------
-- 1. Os triggers de entrada
-- ------------------------------------------------------------
-- SECURITY DEFINER: o cliente que edita o próprio perfil (role authenticated) não tem USAGE em private nem EXECUTE na
-- máscara; a função só reescreve NEW, sem ler nada.
CREATE OR REPLACE FUNCTION private.cliente_nome_sem_cpf()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $f$
BEGIN
  NEW.name := private.radar_razao_mascarada(NEW.name);
  RETURN NEW;
END
$f$;

CREATE OR REPLACE FUNCTION private.venda_item_razao_sem_cpf()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $f$
BEGIN
  NEW.cliente_razao_social := private.radar_razao_mascarada(NEW.cliente_razao_social);
  RETURN NEW;
END
$f$;

REVOKE ALL ON FUNCTION private.cliente_nome_sem_cpf() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.venda_item_razao_sem_cpf() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_profiles_nome_sem_cpf ON public.profiles;
CREATE TRIGGER trg_profiles_nome_sem_cpf
  BEFORE INSERT OR UPDATE OF name ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION private.cliente_nome_sem_cpf();

DROP TRIGGER IF EXISTS trg_venda_items_history_razao_sem_cpf ON public.venda_items_history;
CREATE TRIGGER trg_venda_items_history_razao_sem_cpf
  BEFORE INSERT OR UPDATE OF cliente_razao_social ON public.venda_items_history
  FOR EACH ROW EXECUTE FUNCTION private.venda_item_razao_sem_cpf();

-- ------------------------------------------------------------
-- 2. Backfill: regrava o que já está no banco (o trigger mascara de novo, idempotente)
-- ------------------------------------------------------------
-- profiles.updated_at sobe nas linhas regravadas (update_profiles_updated_at); nada no repo o lê.
UPDATE public.profiles
   SET name = private.radar_razao_mascarada(name)
 WHERE name ~ '(?<![0-9])[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{2}(?![0-9])';

UPDATE public.venda_items_history
   SET cliente_razao_social = private.radar_razao_mascarada(cliente_razao_social)
 WHERE cliente_razao_social ~ '(?<![0-9])[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{2}(?![0-9])';

-- ------------------------------------------------------------
-- PÓS: nenhum CPF sobra, os triggers mordem (provado por execução, desfeito por savepoint) e nada abriu ao JWT
-- ------------------------------------------------------------
DO $pos$
DECLARE
  v_re constant text := '(?<![0-9])[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{2}(?![0-9])';
  v_n bigint;
  v_obtido text;
BEGIN
  SELECT count(*) INTO v_n FROM public.profiles WHERE name ~ v_re;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALHOU: ainda há % linha(s) de profiles com CPF no name', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.venda_items_history WHERE cliente_razao_social ~ v_re;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'FALHOU: ainda há % linha(s) de venda_items_history com CPF na cliente_razao_social', v_n;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_profiles_nome_sem_cpf'
                   AND tgrelid = 'public.profiles'::regclass AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_venda_items_history_razao_sem_cpf'
                   AND tgrelid = 'public.venda_items_history'::regclass AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'FALHOU: trigger de máscara ausente ou desligado — o próximo escritor gravaria o CPF';
  END IF;

  -- O trigger morde de verdade: escreve um CPF e lê o que ficou. P0099 desfaz o savepoint; qualquer outro erro sobe.
  IF EXISTS (SELECT 1 FROM public.profiles) THEN
    BEGIN
      UPDATE public.profiles SET name = 'PROVA DA MIGRATION 123.456.789-01'
       WHERE id = (SELECT id FROM public.profiles ORDER BY id LIMIT 1)
      RETURNING name INTO v_obtido;
      RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = coalesce(v_obtido, '<nulo>');
    EXCEPTION WHEN SQLSTATE 'P0099' THEN
      v_obtido := SQLERRM;
    END;
    IF v_obtido IS DISTINCT FROM 'PROVA DA MIGRATION ***.456.789-**' THEN
      RAISE EXCEPTION 'FALHOU: o trigger de profiles não mascarou (gravou %)', v_obtido;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.venda_items_history) THEN
    BEGIN
      UPDATE public.venda_items_history SET cliente_razao_social = 'PROVA DA MIGRATION 12345678901'
       WHERE ctid = (SELECT ctid FROM public.venda_items_history LIMIT 1)
      RETURNING cliente_razao_social INTO v_obtido;
      RAISE EXCEPTION USING ERRCODE = 'P0099', MESSAGE = coalesce(v_obtido, '<nulo>');
    EXCEPTION WHEN SQLSTATE 'P0099' THEN
      v_obtido := SQLERRM;
    END;
    IF v_obtido IS DISTINCT FROM 'PROVA DA MIGRATION ***456789**' THEN
      RAISE EXCEPTION 'FALHOU: o trigger de venda_items_history não mascarou (gravou %)', v_obtido;
    END IF;
  END IF;

  IF has_function_privilege('anon', 'private.cliente_nome_sem_cpf()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.cliente_nome_sem_cpf()', 'EXECUTE')
     OR has_function_privilege('anon', 'private.venda_item_razao_sem_cpf()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.venda_item_razao_sem_cpf()', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALHOU: função de trigger executável pelo JWT';
  END IF;
END
$pos$;

COMMIT;

SELECT 'CLIENTES_MEI_CPF_MASCARADO_OK' AS fim;
