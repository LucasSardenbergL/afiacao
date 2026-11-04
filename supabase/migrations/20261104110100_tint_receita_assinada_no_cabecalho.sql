-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- Tintométrico — receita ASSINADA no cabeçalho de tint_formulas (programa Mini, M1)
--
-- O CUSTO (run 9fdaaee4, 03/11, psql-ro): 24 stagings, 140.864 chaves comparadas e puladas pelo diff
-- (20261103093424) — e, para comparar, o _pulados leu a receita de cada uma em tint_formula_itens:
-- 2,4 GB do disco (itens: 837 MB heap + 845 MB índice). Janela de controle sem run: 0 bloco.
--
-- A CORREÇÃO: tint_formulas ganha receita_assinatura (sha256 da MESMA string que o _pulados monta hoje
-- dos itens) e receita_desde (min(created_at) dos itens = o frescor). O _pulados compara a staging com
-- a assinatura e só lê os itens quando ela é NULL (não calculada ou invalidada).
--   · ÚNICO ASSINADOR: o gatilho BEFORE ROW trg_tint_formulas_assinatura. Gravar QUALQUER valor não-nulo
--     em receita_* pede assinatura: ele recalcula dos itens (linha já travada pelo UPDATE; leitura num
--     comando novo, READ COMMITTED) e sobrescreve — valor do chamador nunca é aceito. INSERT, tombstone
--     da Fase 5 ou isolamento acima de READ COMMITTED → NULL.
--   · INVALIDAÇÃO: toda escrita em tint_formula_itens (INSERT/UPDATE/DELETE por comando, TRUNCATE) zera a
--     assinatura das fórmulas tocadas, TRAVANDO o cabeçalho antes (ordem de id): um assinador em voo que
--     não viu o item novo termina antes e é zerado depois.
--   · Funções SECURITY DEFINER, search_path pg_catalog, public, pg_temp, relações qualificadas (pg_temp
--     não desvia). Privilégio TRIGGER revogado de quem não é dono (service_role tinha: CREATE TRIGGER
--     neutralizaria o assinador). Dono e executor de migration = superfície de confiança declarada.
--   · O promote: upsert grava receita_*=NULL; depois dos itens, assina até c_teto_assinar (metade p/ as
--     reescritas, o resto p/ as puladas ainda sem assinatura) — sem backfill nem cron: cada par converge
--     nos runs que o tocam. Pulado sem assinatura continua comparado pelos itens, como hoje.
-- Direção de falha: assinatura NULL = caminho de hoje (custa I/O). Falso "igual" exigiria uma assinatura
-- não-nula que não é a dos itens — o que a invalidação travada e o assinador único fecham.
--
-- 10 trocas ancoradas no promote (cada âncora casa exatamente 1 vez) no molde TRAVA → PRE → EXECUTE →
-- PÓS (md5 = este) → REVOKE → postcondição relida do catálogo. Re-aplicar é no-op.
-- APLICAR (fora de uma promoção em curso): bun run db:aplicar supabase/migrations/20261104061910_tint_receita_assinada_no_cabecalho.sql
-- (sem BEGIN/COMMIT: o db:aplicar fornece a transação).
-- Prova: db/test-tint-receita-assinada.sh (LOCALE_TESTE=C e LOCALE_TESTE=pt_BR.UTF-8)
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

-- O ADD COLUMN pede ACCESS EXCLUSIVE em tint_formulas (o balcão lê): não esperar atrás de leitura longa.
SET LOCAL lock_timeout = '3s';

-- TRAVA antes de ler: ALTER sem efeito (a volatilidade VIVA é VOLATILE) prende a função até o fim da
-- transação — outra sessão não troca o corpo entre a PRE e o EXECUTE.
DO $trava$
BEGIN
  IF to_regprocedure('public.tint_promote_sync_run(uuid)') IS NOT NULL THEN
    ALTER FUNCTION public.tint_promote_sync_run(uuid) VOLATILE;
  END IF;
END
$trava$;

-- ── 1. colunas (só catálogo: sem default) ────────────────────────────────────────────────────────
ALTER TABLE public.tint_formulas
  ADD COLUMN IF NOT EXISTS receita_assinatura bytea,
  ADD COLUMN IF NOT EXISTS receita_desde timestamptz;

COMMENT ON COLUMN public.tint_formulas.receita_assinatura IS
  'sha256 da receita (corante|ordem|qtd por corante) — escrita SÓ pelo gatilho trg_tint_formulas_assinatura; NULL = não calculada/invalidada';
COMMENT ON COLUMN public.tint_formulas.receita_desde IS
  'min(created_at) dos itens quando assinada (-infinity se algum NULL; NULL se sem item)';

-- ── 2. o assinador (único) ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tint_formulas_assina_receita()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_sig   bytea;
  v_n     bigint;
  v_nulos bigint;
  v_desde timestamptz;
BEGIN
  -- INSERT (antes da resolução de conflito do upsert), tombstone da Fase 5 e invalidação → NULL.
  IF TG_OP = 'INSERT'
     OR NEW.desativada_motivo IS NOT DISTINCT FROM 'fase5_geracao_legada'
     OR NEW.receita_assinatura IS NULL THEN
    NEW.receita_assinatura := NULL;
    NEW.receita_desde := NULL;
    RETURN NEW;
  END IF;
  -- UPDATE que não mexe na assinatura (E4, desativação do apply): mantém a que já foi calculada.
  IF NEW.id = OLD.id
     AND NEW.receita_assinatura = OLD.receita_assinatura
     AND NEW.receita_desde IS NOT DISTINCT FROM OLD.receita_desde THEN
    RETURN NEW;
  END IF;
  -- Fora de READ COMMITTED o snapshot da transação pode não ver o item que outra já commitou.
  IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
    NEW.receita_assinatura := NULL;
    NEW.receita_desde := NULL;
    RETURN NEW;
  END IF;
  -- A MESMA string que o _pulados do promote monta dos itens (ordem nativa do uuid; numeric pelo texto).
  SELECT sha256(convert_to(COALESCE(string_agg(fi.corante_id::text || '|' || fi.ordem::text || '|' || fi.qtd_ml::text, ','
                                               ORDER BY fi.corante_id), ''), 'UTF8')),
         count(*), count(*) FILTER (WHERE fi.created_at IS NULL), min(fi.created_at)
    INTO v_sig, v_n, v_nulos, v_desde
    FROM public.tint_formula_itens fi
   WHERE fi.formula_id = NEW.id;
  NEW.receita_assinatura := v_sig;
  NEW.receita_desde := CASE WHEN v_n = 0 THEN NULL
                            WHEN v_nulos > 0 THEN '-infinity'::timestamptz
                            ELSE v_desde END;
  RETURN NEW;
END
$fn$;

-- Nome em ordem alfabética ANTES do guard do tombstone (os BEFORE ROW disparam por nome).
CREATE OR REPLACE TRIGGER trg_tint_formulas_assinatura
  BEFORE INSERT OR UPDATE ON public.tint_formulas
  FOR EACH ROW
  WHEN (NEW.receita_assinatura IS NOT NULL OR NEW.receita_desde IS NOT NULL)
  EXECUTE FUNCTION public.tint_formulas_assina_receita();

-- ── 3. a invalidação (toda escrita de item) ──────────────────────────────────────────────────────
-- TRAVA o cabeçalho ANTES de filtrar por "assinada": um UPDATE filtrado por IS NOT NULL pularia a linha
-- que um assinador em voo (sem commit, sem ver este item) está assinando — e a assinatura velha ficaria.
CREATE OR REPLACE FUNCTION public.tint_formula_itens_invalida_assinatura()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    -- ACCESS EXCLUSIVE nos itens: nenhum assinador está lendo-os agora.
    UPDATE public.tint_formulas f
       SET receita_assinatura = NULL, receita_desde = NULL
     WHERE f.receita_assinatura IS NOT NULL
       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada';
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM public.tint_formulas f
     WHERE f.id IN (SELECT n.formula_id FROM novos n)
       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada'
     ORDER BY f.id
     FOR NO KEY UPDATE OF f;
    UPDATE public.tint_formulas f
       SET receita_assinatura = NULL, receita_desde = NULL
     WHERE f.id IN (SELECT n.formula_id FROM novos n)
       AND f.receita_assinatura IS NOT NULL
       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada';
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM public.tint_formulas f
     WHERE f.id IN (SELECT o.formula_id FROM antigos o)
       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada'
     ORDER BY f.id
     FOR NO KEY UPDATE OF f;
    UPDATE public.tint_formulas f
       SET receita_assinatura = NULL, receita_desde = NULL
     WHERE f.id IN (SELECT o.formula_id FROM antigos o)
       AND f.receita_assinatura IS NOT NULL
       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada';
  ELSE
    -- UPDATE: as duas pontas (o item pode mudar de fórmula).
    PERFORM 1 FROM public.tint_formulas f
     WHERE f.id IN (SELECT o.formula_id FROM antigos o UNION SELECT n.formula_id FROM novos n)
       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada'
     ORDER BY f.id
     FOR NO KEY UPDATE OF f;
    UPDATE public.tint_formulas f
       SET receita_assinatura = NULL, receita_desde = NULL
     WHERE f.id IN (SELECT o.formula_id FROM antigos o UNION SELECT n.formula_id FROM novos n)
       AND f.receita_assinatura IS NOT NULL
       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada';
  END IF;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE TRIGGER trg_tint_formula_itens_invalida_ins
  AFTER INSERT ON public.tint_formula_itens
  REFERENCING NEW TABLE AS novos
  FOR EACH STATEMENT EXECUTE FUNCTION public.tint_formula_itens_invalida_assinatura();
CREATE OR REPLACE TRIGGER trg_tint_formula_itens_invalida_del
  AFTER DELETE ON public.tint_formula_itens
  REFERENCING OLD TABLE AS antigos
  FOR EACH STATEMENT EXECUTE FUNCTION public.tint_formula_itens_invalida_assinatura();
CREATE OR REPLACE TRIGGER trg_tint_formula_itens_invalida_upd
  AFTER UPDATE ON public.tint_formula_itens
  REFERENCING OLD TABLE AS antigos NEW TABLE AS novos
  FOR EACH STATEMENT EXECUTE FUNCTION public.tint_formula_itens_invalida_assinatura();
CREATE OR REPLACE TRIGGER trg_tint_formula_itens_invalida_trunc
  AFTER TRUNCATE ON public.tint_formula_itens
  FOR EACH STATEMENT EXECUTE FUNCTION public.tint_formula_itens_invalida_assinatura();

REVOKE EXECUTE ON FUNCTION public.tint_formulas_assina_receita() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.tint_formula_itens_invalida_assinatura() FROM PUBLIC, anon, authenticated;

-- ── 4. ninguém além do dono cria gatilho nas duas tabelas ────────────────────────────────────────
DO $acl$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.oid::regclass AS tab,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END AS quem
      FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE c.oid IN ('public.tint_formulas'::regclass, 'public.tint_formula_itens'::regclass)
       AND a.privilege_type = 'TRIGGER'
       AND a.grantee <> c.relowner
  LOOP
    EXECUTE format('REVOKE TRIGGER ON %s FROM %s', r.tab, r.quem);
  END LOOP;
END
$acl$;

-- ── 5. o promote compara pela assinatura e assina o que tocou ────────────────────────────────────
DO $mig$
DECLARE
  -- md5(prosrc) do corpo vivo em 2026-11-04 (psql-ro, xmin 13787158; = o que 20261104110000 produziu)
  -- e do corpo que esta migration produz.
  c_pred constant text := '97d4424225edab7caff792b852afb371';
  c_este constant text := 'bbd219afff819b3d2401f8e33a8a4010';
  -- (busca, troca): cada busca tem de casar exatamente 1 vez no corpo vivo.
  c_trocas constant text[][] := ARRAY[
    -- A1: contadores.
    ARRAY[
$a1$  v_puladas        int := 0;$a1$,
$s1$  v_assinadas      int := 0;    -- (20261104061910) receitas assinadas no cabeçalho por este run
  v_assinar_reesc  int := 0;    -- (20261104061910) quantas das reescritas entraram no teto
  c_teto_assinar   constant int := 20000;  -- (20261104061910) teto por run: metade reescritas, resto puladas
  v_puladas        int := 0;$s1$],
    -- A2: o _pulados leva a assinatura (e "sem assinatura" para o fim do run); desativada_em sai da projeção.
    ARRAY[
$a2$  SELECT eu.staging_formula_id, eu.emb_id, f.id AS formula_id
  FROM _expand_uniq eu
  JOIN tint_staging_formulas sf ON sf.id = eu.staging_formula_id
  CROSS JOIN LATERAL (
    SELECT tf.id, tf.updated_at, tf.desativada_em, tf.nome_cor, tf.sku_id, tf.volume_final_ml,
           tf.preco_final_sayersystem, tf.personalizada
    FROM tint_formulas tf$a2$,
$s2$  SELECT eu.staging_formula_id, eu.emb_id, f.id AS formula_id,
         (f.receita_assinatura IS NULL) AS sem_assinatura
  FROM _expand_uniq eu
  JOIN tint_staging_formulas sf ON sf.id = eu.staging_formula_id
  CROSS JOIN LATERAL (
    SELECT tf.id, tf.updated_at, tf.nome_cor, tf.sku_id, tf.volume_final_ml,
           tf.preco_final_sayersystem, tf.personalizada, tf.receita_assinatura, tf.receita_desde
    FROM tint_formulas tf$s2$],
    -- A3: ativa DENTRO do LATERAL (desativada → sem linha → não pulada → reescrita, como o WHERE de hoje).
    ARRAY[
$a3$      AND tf.embalagem_id = eu.emb_id
    LIMIT 1$a3$,
$s3$      AND tf.embalagem_id = eu.emb_id
      AND tf.desativada_em IS NULL
    LIMIT 1$s3$],
    -- A4: assinada → os itens não são lidos (filtro de uma vez sobre o parâmetro externo).
    ARRAY[
$a4$    WHERE fi.formula_id = f.id
  ) atual$a4$,
$s4$    WHERE fi.formula_id = f.id
      AND f.receita_assinatura IS NULL
  ) atual$s4$],
    -- A5: o "ativo" já foi exigido no LATERAL.
    ARRAY[
$a5$  WHERE f.desativada_em IS NULL
    AND f.updated_at > sf.created_at$a5$,
$s5$  WHERE f.updated_at > sf.created_at$s5$],
    -- A6: receita e frescor pela assinatura quando há; senão pelos itens, verbatim.
    ARRAY[
$a6$    AND atual.receita IS NOT DISTINCT FROM novo.receita
    AND COALESCE(atual.fresca, true);$a6$,
$s6$    AND CASE WHEN f.receita_assinatura IS NOT NULL
             THEN f.receita_assinatura = sha256(convert_to(COALESCE(novo.receita, ''), 'UTF8'))
                  AND (f.receita_desde IS NULL OR f.receita_desde > sf.created_at)
             ELSE atual.receita IS NOT DISTINCT FROM novo.receita
                  AND COALESCE(atual.fresca, true)
        END;$s6$],
    -- A7: a receita vai ser reescrita — a assinatura velha sai no próprio upsert.
    ARRAY[
$a7$      desativada_em           = NULL
    RETURNING$a7$,
$s7$      desativada_em           = NULL,
      receita_assinatura      = NULL,
      receita_desde           = NULL
    RETURNING$s7$],
    -- A8: assina depois dos itens (antes do E4, que não mexe em receita).
    ARRAY[
$a8$  ORDER BY pr.formula_id, co.id, si.ordem DESC, si.qtd_ml DESC, si.id DESC;$a8$,
$s8$  ORDER BY pr.formula_id, co.id, si.ordem DESC, si.qtd_ml DESC, si.id DESC;

  -- ══════════════════════════════════════════════════════════════════════════
  -- [ASSINATURA] (20261104061910) a receita assinada no CABEÇALHO: o próximo run compara sem ler os
  -- itens. Pedir = gravar '' em receita_assinatura; o gatilho trg_tint_formulas_assinatura (o ÚNICO
  -- assinador) recalcula dos itens com a linha travada e sobrescreve — e só em READ COMMITTED.
  -- Teto por run: até a metade para as reescritas (itens quentes), o resto para as puladas ainda sem
  -- assinatura. O que passar fica NULL e é comparado pelos itens (correto) até um run o assinar.
  -- Trava em ordem de id antes (a mesma ordem do gatilho de invalidação dos itens).
  -- ══════════════════════════════════════════════════════════════════════════
  IF current_setting('transaction_isolation') = 'read committed' THEN
    CREATE TEMP TABLE _assinar ON COMMIT DROP AS
    SELECT pm.formula_id FROM _promoted pm ORDER BY pm.formula_id LIMIT c_teto_assinar / 2;
    SELECT count(*) INTO v_assinar_reesc FROM _assinar;
    INSERT INTO _assinar
    SELECT pu.formula_id FROM _pulados pu
     WHERE pu.sem_assinatura
     ORDER BY pu.formula_id
     LIMIT c_teto_assinar - v_assinar_reesc;
    PERFORM 1 FROM public.tint_formulas f
     WHERE f.id IN (SELECT a.formula_id FROM _assinar a)
       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada'
     ORDER BY f.id
     FOR NO KEY UPDATE OF f;
    UPDATE public.tint_formulas f
       SET receita_assinatura = ''::bytea
      FROM _assinar a
     WHERE f.id = a.formula_id
       AND f.desativada_motivo IS DISTINCT FROM 'fase5_geracao_legada';
    GET DIAGNOSTICS v_assinadas = ROW_COUNT;
  END IF;$s8$],
    -- A9: rastro durável no run.
    ARRAY[
$a9$'formulas_identicas_puladas', v_puladas)$a9$,
$s9$'formulas_identicas_puladas', v_puladas, 'receitas_assinadas', v_assinadas)$s9$],
    -- A10: retorno.
    ARRAY[
$a10$    'formulas_identicas_puladas', v_puladas,$a10$,
$s10$    'formulas_identicas_puladas', v_puladas,
    'receitas_assinadas', v_assinadas,$s10$]
  ];
  v_oid  oid;
  v_src  text;
  v_md5  text;
  v_def  text;
  i      int;
BEGIN
  v_oid := to_regprocedure('public.tint_promote_sync_run(uuid)')::oid;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'receita-assinada ABORTADA: public.tint_promote_sync_run(uuid) nao existe';
  END IF;
  SELECT prosrc INTO v_src FROM pg_catalog.pg_proc WHERE oid = v_oid;
  v_md5 := md5(v_src);

  IF v_md5 = c_este THEN
    RAISE NOTICE 'receita-assinada: promote ja compara pela assinatura - no-op';
    RETURN;
  END IF;
  IF v_md5 <> c_pred THEN
    RAISE EXCEPTION 'receita-assinada ABORTADA: corpo vivo do promote (md5 %) nao e o predecessor revisado (%) nem este (%) - alguem o recriou depois do pre-voo; refaca as trocas sobre o corpo novo', v_md5, c_pred, c_este;
  END IF;

  v_def := pg_get_functiondef(v_oid);
  FOR i IN 1 .. array_length(c_trocas, 1) LOOP
    IF (length(v_src) - length(replace(v_src, c_trocas[i][1], ''))) / length(c_trocas[i][1]) <> 1
       OR (length(v_def) - length(replace(v_def, c_trocas[i][1], ''))) / length(c_trocas[i][1]) <> 1 THEN
      RAISE EXCEPTION 'receita-assinada ABORTADA: a ancora % nao casa exatamente 1 vez no corpo vivo', i;
    END IF;
    v_def := replace(v_def, c_trocas[i][1], c_trocas[i][2]);
  END LOOP;
  EXECUTE v_def;

  SELECT md5(prosrc) INTO v_md5 FROM pg_catalog.pg_proc WHERE oid = v_oid;
  IF v_md5 <> c_este THEN
    RAISE EXCEPTION 'receita-assinada ABORTADA: pos-troca o md5 do promote e % (esperado %)', v_md5, c_este;
  END IF;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.tint_promote_sync_run(uuid) FROM PUBLIC, anon, authenticated;

-- ── PÓS-CONDIÇÃO (relida do catálogo) ────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_src  text;
  v_cfg  text[];
  v_n    int;
BEGIN
  -- P1: colunas com o tipo certo.
  SELECT count(*) INTO v_n FROM pg_catalog.pg_attribute
   WHERE attrelid = 'public.tint_formulas'::regclass AND NOT attisdropped
     AND ((attname = 'receita_assinatura' AND atttypid = 'bytea'::regtype)
       OR (attname = 'receita_desde' AND atttypid = 'timestamptz'::regtype));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'P1 FALHOU: tint_formulas sem receita_assinatura bytea / receita_desde timestamptz';
  END IF;

  -- P2: os 5 gatilhos, habilitados, com o tipo (tgtype: 1 linha, 2 before, 4 insert, 8 delete,
  -- 16 update, 32 truncate), as tabelas de transição e a função certos.
  SELECT count(*) INTO v_n FROM pg_catalog.pg_trigger t
   WHERE t.tgenabled = 'O' AND NOT t.tgisinternal
     AND ((t.tgname = 'trg_tint_formulas_assinatura' AND t.tgrelid = 'public.tint_formulas'::regclass
           AND t.tgtype = 1 + 2 + 4 + 16 AND t.tgqual IS NOT NULL
           AND t.tgfoid = 'public.tint_formulas_assina_receita()'::regprocedure)
       OR (t.tgrelid = 'public.tint_formula_itens'::regclass
           AND t.tgfoid = 'public.tint_formula_itens_invalida_assinatura()'::regprocedure
           AND t.tgqual IS NULL
           AND ((t.tgname = 'trg_tint_formula_itens_invalida_ins' AND t.tgtype = 4
                 AND t.tgnewtable = 'novos' AND t.tgoldtable IS NULL)
             OR (t.tgname = 'trg_tint_formula_itens_invalida_del' AND t.tgtype = 8
                 AND t.tgoldtable = 'antigos' AND t.tgnewtable IS NULL)
             OR (t.tgname = 'trg_tint_formula_itens_invalida_upd' AND t.tgtype = 16
                 AND t.tgoldtable = 'antigos' AND t.tgnewtable = 'novos')
             OR (t.tgname = 'trg_tint_formula_itens_invalida_trunc' AND t.tgtype = 32))));
  IF v_n <> 5 THEN
    RAISE EXCEPTION 'P2 FALHOU: % de 5 gatilhos da assinatura no estado certo (habilitado, tipo, transicao, funcao)', v_n;
  END IF;

  -- P3: as 2 funções são definer, com search_path fixo, e têm o que as torna corretas.
  SELECT count(*) INTO v_n FROM pg_catalog.pg_proc p
   WHERE p.prosecdef
     AND ('search_path=pg_catalog, public, pg_temp' = ANY (p.proconfig)) IS TRUE
     AND ((p.oid = 'public.tint_formulas_assina_receita()'::regprocedure
           AND position('transaction_isolation' in p.prosrc) > 0
           AND position('FROM public.tint_formula_itens fi' in p.prosrc) > 0
           AND position('fase5_geracao_legada' in p.prosrc) > 0)
       OR (p.oid = 'public.tint_formula_itens_invalida_assinatura()'::regprocedure
           AND (length(p.prosrc) - length(replace(p.prosrc, 'FOR NO KEY UPDATE OF f', '')))
               / length('FOR NO KEY UPDATE OF f') = 3));
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'P3 FALHOU: assinador/invalidador sem SECURITY DEFINER, search_path fixo, isolamento ou trava antes do filtro';
  END IF;

  -- P4: o promote com o corpo desta migration.
  SELECT prosrc, proconfig INTO v_src, v_cfg FROM pg_catalog.pg_proc
   WHERE oid = 'public.tint_promote_sync_run(uuid)'::regprocedure;
  IF position('AND f.receita_assinatura IS NULL' in v_src) = 0
     OR position('THEN f.receita_assinatura = sha256(convert_to(COALESCE(novo.receita, ''''), ''UTF8''))' in v_src) = 0
     OR position('SET receita_assinatura = ''''::bytea' in v_src) = 0
     OR position('''receitas_assinadas'', v_assinadas)' in v_src) = 0
     OR position('pg_advisory_xact_lock(hashtext(''tint_formulas_account:'' || v_account))' in v_src) = 0
     OR position('DELETE FROM tint_formula_itens fi USING _promoted pr WHERE fi.formula_id = pr.formula_id;' in v_src) = 0 THEN
    RAISE EXCEPTION 'P4 FALHOU: o promote nao compara pela assinatura, nao assina, perdeu o lock por account ou o caminho de reescrita';
  END IF;
  IF ('search_path=public' = ANY (v_cfg)) IS NOT TRUE OR ('statement_timeout=300s' = ANY (v_cfg)) IS NOT TRUE THEN
    RAISE EXCEPTION 'P4 FALHOU: o promote perdeu search_path/statement_timeout (proconfig %)', v_cfg;
  END IF;

  -- P5: só o dono tem TRIGGER nas duas tabelas.
  SELECT count(*) INTO v_n FROM pg_catalog.pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
   WHERE c.oid IN ('public.tint_formulas'::regclass, 'public.tint_formula_itens'::regclass)
     AND a.privilege_type = 'TRIGGER' AND a.grantee <> c.relowner;
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'P5 FALHOU: % concessao(oes) de TRIGGER a quem nao e dono em tint_formulas/tint_formula_itens', v_n;
  END IF;

  -- P6: ACL das funções.
  IF has_function_privilege('anon', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_promote_sync_run(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tint_formulas_assina_receita()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_formulas_assina_receita()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tint_formula_itens_invalida_assinatura()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tint_formula_itens_invalida_assinatura()', 'EXECUTE') THEN
    RAISE EXCEPTION 'P6 FALHOU: anon/authenticated executam o promote ou as funcoes da assinatura';
  END IF;
  RAISE NOTICE 'receita-assinada: colunas, 5 gatilhos, assinador/invalidador definer, promote trocado, TRIGGER so do dono, ACL fechada';
END
$post$;
