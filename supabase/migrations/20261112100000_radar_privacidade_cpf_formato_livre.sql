-- ============================================================
-- Radar, pacote J (continuação): a máscara do CPF passa a cobrir o CPF escrito em formato livre na razão social.
--
-- O PROBLEMA (medido em prod, 2026-11-10, psql-ro, depois do backfill da 20261111150000): a máscara da J só
-- reconhecia o CPF na convenção da RFB para MEI — 11 dígitos colados no FIM, depois de um espaço
-- ('FULANO 12345678901'). 207 razões de radar_empresas ainda mostram o CPF de outro jeito, porque quem registrou
-- pôs o número no nome: '… - CPF 123.456.789-01' (152), '… 12345678901 ME' (27), '… 123456789-01' (19) e grafias
-- avulsas ('123.456.789/01', '123 456 789 01', '123.456..789-01', '123.456.789 - 01'). Essas saíam inteiras em toda
-- tela, e-mail, tarefa e CSV.
--
-- O QUE MUDA (só isto; nenhuma RPC de leitura, nenhuma regra de vínculo):
--   1. private.radar_razao_mascarada reconhece qualquer sequência 3-3-3-2 dígitos com até 3 separadores
--      (espaço . / -) entre os grupos, que não esteja colada a outro dígito, e troca os dígitos 1-3 e 10-11 por *,
--      mantendo a pontuação: '123.456.789-01' → '***.456.789-**'. A forma da RFB sai IDÊNTICA à de antes
--      ('FULANO ***456789**'). As fronteiras são lookaround (não consomem o caractere vizinho), então dois CPFs
--      seguidos são mascarados os dois.
--   2. Os 2 triggers de entrada (staging da carga e radar_empresas) guardam o cru e mascaram sempre que a máscara
--      MUDA a razão — não mais só no sufixo da RFB. O cru só é gravado de razão sem máscara nenhuma: a meio
--      mascarada (sufixo já mascarado pela J + CPF livre no nome; 0 em prod) mascara, mas não troca o cru verdadeiro. Assim o cadastro no Omie (radar_razao_social_para_cadastro, que
--      já lê COALESCE(cru, exibida)) segue recebendo a razão fiscal exata.
--   3. As razões que já estão no banco com o CPF em formato livre são regravadas aqui (UPDATE razao_social =
--      razao_social: o trigger guarda o cru e mascara). Não mexe em updated_at (nenhum trigger o toca).
--
-- POR QUE NÃO MUDA NENHUMA DECISÃO DE VÍNCULO/CRÉDITO: as regras leem só o sufixo ' ([0-9]{11}|***dddddd**)$' e o
-- prefixo '^dd.ddd.ddd ' da razão. Medido sobre as 573.021 razões de prod com a máscara nova: 0 linhas mudam
-- algum dos 2 predicados ou o sufixo capturado, 0 das 207 casa algum dos 2 (o nome extraído pelas regras também não
-- muda), e mascarar 2 vezes dá o mesmo texto (idempotente). Prova PG17: db/test-radar-privacidade-j.sh, C*.
--
-- Corpos de prod lidos em 2026-11-10 (psql-ro), iguais aos da 20261111150000: mascarada b60bfc74…,
-- carga 5dacf3ab…, empresas 9a065599…. Nenhum índice usa radar_razao_mascarada (pg_indexes, 0).
-- Molde TRAVA → PRE → CREATE → PÓS. Sem CREATE INDEX: pode rodar em horário comercial (o UPDATE toca ~207 linhas).
-- Ordem de deploy: só esta camada (o front e a edge não mudam).
-- Aplicação: `bun run db:aplicar supabase/migrations/20261112100000_radar_privacidade_cpf_formato_livre.sql`
-- (sem BEGIN/COMMIT: o executor fornece a transação).
-- ============================================================

SET LOCAL lock_timeout = '15s';

DO $trava$
BEGIN
  ALTER FUNCTION private.radar_razao_mascarada(text) SET search_path TO 'pg_catalog';
  ALTER FUNCTION private.radar_carga_privacidade() SET search_path TO 'public', 'pg_temp';
  ALTER FUNCTION private.radar_empresas_privacidade() SET search_path TO 'public', 'pg_temp';
END
$trava$;

DO $pre$
DECLARE
  v_ms text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_razao_mascarada(text)'));
  v_cg text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_carga_privacidade()'));
  v_em text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_empresas_privacidade()'));
BEGIN
  IF v_ms IS NULL OR v_ms NOT IN ('b60bfc744c57e9cb0c97a503012894c9', '6590f8d73cadbc6baab8513a6c9e1779') THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_razao_mascarada vivo (md5 %) não é o da 20261111150000 nem este — reconcilie antes', v_ms;
  END IF;
  IF v_cg IS NULL OR v_cg NOT IN ('5dacf3abbb5278903763fcc62cc41452', 'e4d716e984bf016b179d857490492dbb') THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_carga_privacidade vivo (md5 %) não é o da 20261111150000 nem este', v_cg;
  END IF;
  IF v_em IS NULL OR v_em NOT IN ('9a065599d514e04e25d4421e7ace45ee', '1eff8619d2265e12f32c67a52599d24e') THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_empresas_privacidade vivo (md5 %) não é o da 20261111150000 nem este', v_em;
  END IF;
  IF to_regclass('private.radar_razao_receita') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_razao_receita ausente — a 20261111150000 não está aplicada';
  END IF;
END
$pre$;

-- ------------------------------------------------------------
-- 1. A máscara
-- ------------------------------------------------------------
-- 'FULANO 12345678901' → 'FULANO ***456789**' (como antes); '… CPF 123.456.789-01' → '… CPF ***.456.789-**';
-- '… 12345678901 ME' → '… ***456789** ME'. Sequência colada a outro dígito (CNPJ, 12+ dígitos): intacta.
CREATE OR REPLACE FUNCTION private.radar_razao_mascarada(p text)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $f$
  SELECT regexp_replace(p, '(?<![0-9])[0-9]{3}([ ./-]{0,3}[0-9]{3}[ ./-]{0,3})([0-9]{3})([ ./-]{0,3})[0-9]{2}(?![0-9])', '***\1\2\3**', 'g')
$f$;
REVOKE ALL ON FUNCTION private.radar_razao_mascarada(text) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. Os triggers de entrada: guardam o cru e mascaram sempre que a máscara muda a razão
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.radar_carga_privacidade()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  v_escopo text;
BEGIN
  IF NEW.razao_social IS DISTINCT FROM private.radar_razao_mascarada(NEW.razao_social) THEN
    -- O cru só vem de razão SEM máscara nenhuma: a meio mascarada (sufixo da RFB já mascarado + CPF livre no nome)
    -- não sobrescreve o cru verdadeiro que o cadastro no Omie lê.
    IF NEW.razao_social !~ '\*\*\*[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}\*\*' THEN
      INSERT INTO private.radar_razao_receita AS r (cnpj, razao_social) VALUES (NEW.cnpj, NEW.razao_social)
      ON CONFLICT (cnpj) DO UPDATE SET razao_social = EXCLUDED.razao_social, atualizado_em = now()
        WHERE r.razao_social IS DISTINCT FROM EXCLUDED.razao_social;
    END IF;
    NEW.razao_social := private.radar_razao_mascarada(NEW.razao_social);
  END IF;
  SELECT x.escopo INTO v_escopo FROM public.radar_exclusoes_titular x WHERE x.raiz = left(NEW.cnpj, 8);
  IF v_escopo IS NOT NULL THEN
    NEW.socios_nomes := NULL;
    IF v_escopo = 'contato' THEN
      NEW.email := NULL; NEW.telefone1 := NULL; NEW.telefone2 := NULL;
    END IF;
  END IF;
  RETURN NEW;
END
$f$;
CREATE OR REPLACE FUNCTION private.radar_empresas_privacidade()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $f$
DECLARE
  v_escopo text;
BEGIN
  IF NEW.razao_social IS DISTINCT FROM private.radar_razao_mascarada(NEW.razao_social) THEN
    -- O cru só vem de razão SEM máscara nenhuma: a meio mascarada (sufixo da RFB já mascarado + CPF livre no nome)
    -- não sobrescreve o cru verdadeiro que o cadastro no Omie lê.
    IF NEW.razao_social !~ '\*\*\*[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}\*\*' THEN
      INSERT INTO private.radar_razao_receita AS r (cnpj, razao_social) VALUES (NEW.cnpj, NEW.razao_social)
      ON CONFLICT (cnpj) DO UPDATE SET razao_social = EXCLUDED.razao_social, atualizado_em = now()
        WHERE r.razao_social IS DISTINCT FROM EXCLUDED.razao_social;
    END IF;
    NEW.razao_social := private.radar_razao_mascarada(NEW.razao_social);
  END IF;
  SELECT x.escopo INTO v_escopo FROM public.radar_exclusoes_titular x WHERE x.raiz = left(NEW.cnpj, 8);
  IF v_escopo IS NOT NULL THEN
    NEW.socios_nomes := NULL;
    IF v_escopo = 'contato' THEN
      NEW.email := NULL; NEW.telefone1 := NULL; NEW.telefone2 := NULL;
      -- Reabrir o lead (registrar contato) também passa por aqui: a oposição não volta para a fila.
      IF NEW.prospeccao_status IS DISTINCT FROM 'virou_cliente' THEN
        NEW.prospeccao_status := 'descartado';
        NEW.descarte_motivo := 'lgpd_oposicao';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$f$;
REVOKE ALL ON FUNCTION private.radar_carga_privacidade() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.radar_empresas_privacidade() FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Regravar o que já está no banco com o CPF em formato livre (o trigger guarda o cru e mascara)
-- ------------------------------------------------------------
DO $regrava$
DECLARE
  v_cnpjs text[];
  v_n int;
BEGIN
  SELECT array_agg(cnpj) INTO v_cnpjs FROM public.radar_empresas
   WHERE razao_social IS DISTINCT FROM private.radar_razao_mascarada(razao_social);
  UPDATE public.radar_empresas SET razao_social = razao_social WHERE cnpj = ANY (v_cnpjs);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF EXISTS (SELECT 1 FROM unnest(v_cnpjs) c(cnpj)
              WHERE NOT EXISTS (SELECT 1 FROM private.radar_razao_receita r WHERE r.cnpj = c.cnpj)) THEN
    RAISE EXCEPTION 'REGRAVA FALHOU: razão mascarada sem o cru em private.radar_razao_receita — o cadastro no Omie perderia a razão fiscal';
  END IF;
  UPDATE public.radar_empresas_carga SET razao_social = razao_social
   WHERE razao_social IS DISTINCT FROM private.radar_razao_mascarada(razao_social);
  RAISE NOTICE 'regravadas % razões de radar_empresas', v_n;
END
$regrava$;

-- ------------------------------------------------------------
-- PÓS
-- ------------------------------------------------------------
DO $pos$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_razao_mascarada(text)')) IS DISTINCT FROM '6590f8d73cadbc6baab8513a6c9e1779'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_carga_privacidade()')) IS DISTINCT FROM 'e4d716e984bf016b179d857490492dbb'
     OR (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_empresas_privacidade()')) IS DISTINCT FROM '1eff8619d2265e12f32c67a52599d24e' THEN
    RAISE EXCEPTION 'PÓS FALHOU: corpo vivo de alguma das 3 funções não é o desta migration';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger
       WHERE tgname IN ('trg_radar_carga_privacidade', 'trg_radar_privacidade') AND tgenabled = 'O'
         AND tgfoid IN (to_regprocedure('private.radar_carga_privacidade()'), to_regprocedure('private.radar_empresas_privacidade()'))) <> 2 THEN
    RAISE EXCEPTION 'PÓS FALHOU: os 2 triggers de privacidade não estão ativos nas funções certas';
  END IF;
  IF private.radar_razao_mascarada('FULANO DE TAL 12345678901') IS DISTINCT FROM 'FULANO DE TAL ***456789**'
     OR private.radar_razao_mascarada('FULANO - CPF 123.456.789-01') IS DISTINCT FROM 'FULANO - CPF ***.456.789-**'
     OR private.radar_razao_mascarada('A 123.456.789-01 98765432100') IS DISTINCT FROM 'A ***.456.789-** ***654321**'
     OR private.radar_razao_mascarada('FULANO 12345678901 ME') IS DISTINCT FROM 'FULANO ***456789** ME'
     OR private.radar_razao_mascarada('12.345.678 FULANO DE TAL') IS DISTINCT FROM '12.345.678 FULANO DE TAL'
     OR private.radar_razao_mascarada('LOJA 12345678901234 LTDA') IS DISTINCT FROM 'LOJA 12345678901234 LTDA' THEN
    RAISE EXCEPTION 'PÓS FALHOU: a máscara não dá o esperado nos casos de referência';
  END IF;
  IF EXISTS (SELECT 1 FROM public.radar_empresas WHERE razao_social IS DISTINCT FROM private.radar_razao_mascarada(razao_social))
     OR EXISTS (SELECT 1 FROM public.radar_empresas_carga WHERE razao_social IS DISTINCT FROM private.radar_razao_mascarada(razao_social)) THEN
    RAISE EXCEPTION 'PÓS FALHOU: ainda há razão com CPF sem máscara (radar_empresas ou staging)';
  END IF;
  IF has_function_privilege('authenticated', 'private.radar_razao_mascarada(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.radar_razao_mascarada(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PÓS FALHOU: radar_razao_mascarada executável por JWT';
  END IF;
END
$pos$;
