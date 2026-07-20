-- ╔══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║  FU4-E — capability de ESCRITA em compras  [money-path / autorização]                     ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════╝
-- Spec:  docs/superpowers/specs/2026-07-19-authz-fu4e-cap-compras-escrever-design.md
-- Prova: db/test-authz-cap-compras-escrever.sh (PG17, SET ROLE authenticated, com falsificação)
-- Fecha o FU4-E registrado no cabeçalho da 20260718190000 (E2/FU4, PR #1434).
--
-- ── A INCOERÊNCIA QUE ISTO FECHA ───────────────────────────────────────────────────────────
-- O #1434 tira do papel `gerencial` a LEITURA da telemetria do motor de compras (9 tabelas
-- `reposicao_*` → `private.cap_compras_ler`, master-only), mas deixa 3 RPCs de ESCRITA no gate
-- antigo `pode_ver_carteira_completa`. Resultado: quem não lê o estado do motor ainda pode
-- MUTÁ-LO. Não é vazamento de custo/preço/crédito — é coerência interna de compras.
--   · public.despinar_parametro(text,text)   → DELETE em reposicao_param_pin
--   · public.reverter_parametro_auto(uuid)   → reverte parâmetro aplicado (UPDATE sku_parametros
--                                              + INSERT param_pin + UPDATE param_auto_log)
--   · public.reverter_run_auto(uuid)         → reverte um run inteiro (chama a anterior em loop)
--
-- ── POR QUE ESCRITA ≠ LEITURA (spec §4.2 do #1434) ─────────────────────────────────────────
-- `cap_compras_escrever` NÃO reusa `cap_compras_ler`, mesmo concedendo hoje ao mesmo conjunto
-- (master). Funções separadas são o que permite apertar/afrouxar um lado depois sem reabrir o
-- outro, mexendo em 1 função em vez de caçar policies e RPCs.
--
-- ── ROBUSTA À ORDEM DE APLICAÇÃO (medido: o #1434 NÃO está aplicado) ───────────────────────
-- Medido em prod via psql-ro 2026-07-19: o schema `private` tem só `carteira_visivel_para`,
-- `is_super_admin` e `pode_ver_carteira_completa` — ZERO `cap_*`. O #1434 segue em DRAFT e a
-- migration dele nunca foi colada. (Já o #1427/20260718180000 FOI aplicado, ao contrário do que
-- o cabeçalho do #1434 afirma: `private.pode_ver_carteira_completa` existe e as 9 policies
-- `reposicao_*` apontam para ela.)
-- Por isso esta migration NÃO referencia `private.cap_compras_ler` em lugar nenhum: a capability
-- nova lê `has_role` direto. Aplica-se ANTES, DEPOIS ou SEM o #1434, em qualquer ordem — mesma
-- propriedade que o #1434 adotou depois da falha do #1423 (caller órfão). Nenhum estado
-- intermediário fica pior que hoje: se só ESTA for aplicada, o gerencial passa a ler a
-- telemetria mas não a mutar (mais restritivo que o status quo).
--
-- ── O QUE NÃO MUDA, DE PROPÓSITO ───────────────────────────────────────────────────────────
-- Mensagem 'sem permissão', ausência de ERRCODE explícito (⇒ SQLSTATE P0001), SECURITY DEFINER,
-- SET search_path, assinatura, corpo e ACL. `CREATE OR REPLACE` preserva os privilégios de uma
-- função existente (≠ DROP+CREATE, que reaplicaria o default privilege do Supabase). Trocar SÓ o
-- gate é exatamente o que a substituição programática da §2 garante.
--
-- ⚠️ Migration MANUAL (Lovable não aplica nome custom) — colar no SQL Editor.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 0) PRECONDIÇÕES — aborta se o banco vivo divergir do medido
-- ════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_alvos      text[] := ARRAY['public.despinar_parametro(text,text)',
                               'public.reverter_parametro_auto(uuid)',
                               'public.reverter_run_auto(uuid)'];
  v_a          text;
  v_gerenciais int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'private') THEN
    RAISE EXCEPTION 'FU4-E: schema private ausente — aplique o #1421 (20260718150000) antes'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF to_regprocedure('public.has_role(uuid, public.app_role)') IS NULL THEN
    RAISE EXCEPTION 'FU4-E: public.has_role(uuid,app_role) ausente — banco divergente, abortando'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- por ASSINATURA, não por proname: um overload futuro seria escolhido arbitrariamente.
  FOREACH v_a IN ARRAY v_alvos LOOP
    IF to_regprocedure(v_a) IS NULL THEN
      RAISE EXCEPTION 'FU4-E: funcao % nao encontrada — banco divergente do medido', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;

  -- A troca é segura HOJE porque ninguém vive sob papel gerencial (medido 2026-07-19: 2 farmer
  -- + 1 master, zero gerencial/estrategico/super_admin). Se alguém foi promovido entre a escrita
  -- e a aplicação, a troca TIRARIA acesso de uma pessoa viva sem aviso — melhor abortar.
  IF to_regclass('public.commercial_roles') IS NULL THEN
    RAISE EXCEPTION 'FU4-E: tabela commercial_roles ausente — banco divergente, abortando'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT count(*) INTO v_gerenciais FROM public.commercial_roles
   WHERE commercial_role IN ('gerencial','estrategico','super_admin');
  IF v_gerenciais > 0 THEN
    RAISE EXCEPTION 'FU4-E: % papel(is) gerencial(is) vivo(s) — a troca muda o acesso deles. Revise antes de aplicar.', v_gerenciais
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 1) A CAPABILITY — ESCREVER na telemetria do motor de compras
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Master-only, igual à de leitura: o enum `commercial_role` não tem papel de compras, e inventar
-- um aqui seria fabricar contrato. Ninguém perde acesso hoje (só o master passava no gate antigo).
-- Fail-closed: `_uid` nulo ⇒ false, sem depender de NULL propagar como falso.
CREATE OR REPLACE FUNCTION private.cap_compras_escrever(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$function$;

COMMENT ON FUNCTION private.cap_compras_escrever(uuid) IS
  'FU4-E — ESCREVER na telemetria do motor de compras (despinar_parametro, reverter_parametro_auto, '
  'reverter_run_auto). MASTER-ONLY. Separada de cap_compras_ler de propósito (spec §4.2): mesmo '
  'concedendo hoje ao mesmo conjunto, é o que permite apertar um lado sem reabrir o outro.';

-- O objeto NASCE ABERTO: o default privilege do Supabase concede EXECUTE em toda função nova
-- (database.md §62). GRANT só acrescenta — o REVOKE tem de vir antes, e por NOME (revogar de
-- PUBLIC não tira anon/authenticated).
REVOKE ALL ON FUNCTION private.cap_compras_escrever(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_compras_escrever(uuid) TO authenticated, service_role;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 2) AS 3 RPCs — troca do gate por substituição programática GUARDADA
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- POR QUE PROGRAMÁTICO E NÃO VERBATIM: o repo diverge de prod em `CREATE OR REPLACE` (apply
-- manual), e a última a recriar VENCE. Colar o corpo daqui arriscaria sobrescrever prod com uma
-- versão velha do repo. Reescrevemos a partir do corpo VIVO (`pg_get_functiondef`), trocando só
-- o gate. O guard é o que torna isto seguro: se o padrão não casar — função já migrada, ou corpo
-- diferente do medido — a migration ABORTA em vez de aplicar no-op silencioso.
--
-- ⚠️ DIFERENÇA em relação à §3 do #1434: lá o replace fixava `auth.uid()` no padrão. Aqui NÃO
-- pode — `reverter_parametro_auto` chama o gate com a variável `v_uid`, não com `auth.uid()`
-- (medido). Trocamos apenas NOME + abre-parêntese, preservando o argumento verbatim; assim o
-- mesmo bloco serve às três sem hardcodar o que cada uma passa.
DO $$
DECLARE
  v_alvos text[] := ARRAY['public.despinar_parametro(text,text)',
                          'public.reverter_parametro_auto(uuid)',
                          'public.reverter_run_auto(uuid)'];
  v_a     text;
  v_oid   regprocedure;
  v_def   text;
  v_novo  text;
  v_ocorr int;
  -- Chamada do gate antigo, tolerante a qualificação e espaçamento. O alternador aceita
  -- `private.` porque a PROD tem as DUAS formas (wrapper em public + implementação em private,
  -- pelo #1427): casar só `public.` deixaria passar uma reescrita futura, e o guard mentiria.
  c_re_antigo constant text := '(public\.|private\.)?pode_ver_carteira_completa\s*\(';
  c_re_novo   constant text := 'private\.cap_compras_escrever\s*\(';
BEGIN
  FOREACH v_a IN ARRAY v_alvos LOOP
    v_oid := to_regprocedure(v_a);   -- existência já garantida na §0
    v_def := pg_get_functiondef(v_oid);

    -- IDEMPOTENTE: já migrada ⇒ segue. Migration custom deste repo tem de poder ser re-aplicada
    -- (o dono cola à mão; um erro de rede no meio não pode travar a 2ª tentativa).
    IF v_def ~ c_re_novo AND v_def !~ c_re_antigo THEN
      CONTINUE;
    END IF;

    -- exatamente 1 chamada do gate antigo — medido em prod 2026-07-19. Mais de uma significa
    -- corpo diferente do que esta migration foi escrita para tratar.
    SELECT count(*) INTO v_ocorr FROM regexp_matches(v_def, c_re_antigo, 'g');
    IF v_ocorr <> 1 THEN
      RAISE EXCEPTION 'FU4-E: esperava 1 chamada do gate antigo em %, encontrei % — inspecione pg_get_functiondef antes de prosseguir', v_a, v_ocorr
        USING ERRCODE = 'raise_exception';
    END IF;

    -- troca NOME + abre-parêntese; o argumento (auth.uid() ou v_uid) fica intacto.
    v_novo := regexp_replace(v_def, c_re_antigo, 'private.cap_compras_escrever(', 'g');

    IF v_novo = v_def THEN
      RAISE EXCEPTION 'FU4-E: padrao do gate nao casou em % — nao aplicar no-op silencioso', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
    IF v_novo ~ c_re_antigo THEN
      RAISE EXCEPTION 'FU4-E: sobrou chamada ao gate antigo em % apos a troca', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
    IF v_novo !~ c_re_novo THEN
      RAISE EXCEPTION 'FU4-E: o gate NOVO nao aparece em % apos a troca', v_a
        USING ERRCODE = 'raise_exception';
    END IF;

    EXECUTE v_novo;

    -- pós-check POSITIVO no objeto final: o guard textual acima valida a string que vamos
    -- executar; isto valida o que o catálogo realmente guardou.
    IF pg_get_functiondef(to_regprocedure(v_a)) !~ c_re_novo THEN
      RAISE EXCEPTION 'FU4-E: pos-check falhou — % nao ficou com o gate novo', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
    IF pg_get_functiondef(to_regprocedure(v_a)) ~ c_re_antigo THEN
      RAISE EXCEPTION 'FU4-E: pos-check falhou — % ainda referencia o gate antigo', v_a
        USING ERRCODE = 'raise_exception';
    END IF;
  END LOOP;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO PÓS-APPLY (rodar DEPOIS do COMMIT; 4 linhas, todas devem vir `t`)
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- SELECT 'cap existe + master-only' AS check,
--        private.cap_compras_escrever(NULL) IS FALSE
--        AND to_regprocedure('private.cap_compras_escrever(uuid)') IS NOT NULL AS ok
-- UNION ALL
-- SELECT 'as 3 RPCs com o gate NOVO',
--        count(*) = 3 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--         WHERE n.nspname='public'
--           AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
--           AND pg_get_functiondef(p.oid) ~ 'private\.cap_compras_escrever\s*\('
-- UNION ALL
-- SELECT 'nenhuma das 3 no gate ANTIGO',
--        count(*) = 0 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--         WHERE n.nspname='public'
--           AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
--           AND pg_get_functiondef(p.oid) ~ '(public\.|private\.)?pode_ver_carteira_completa\s*\('
-- UNION ALL
-- SELECT 'ACL: authenticated executa, anon não',
--        has_function_privilege('authenticated','private.cap_compras_escrever(uuid)','EXECUTE')
--        AND NOT has_function_privilege('anon','private.cap_compras_escrever(uuid)','EXECUTE');
