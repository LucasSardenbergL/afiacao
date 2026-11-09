-- Radar: o gestor/master ATRIBUI o lead a um vendedor (pedido do founder, 2026-11-06).
--
-- Reusa o dono temporário da 20261029201200 (`radar_atendimentos`, 1 aberto por CNPJ, expiração calculada na
-- leitura). Nada muda para quem só assume: `radar_definir_atendimento` NÃO é reescrita. Esta migration acrescenta:
--   1. `radar_atendimentos.atribuido_por` — quem passou o lead (NULL = o próprio dono assumiu);
--   2. o motivo de encerramento `reatribuido` (a posse anterior fecha quando o gestor passa o lead a outro);
--   3. `public.radar_atribuir_atendimento(cnpj, dono)` — o 2º escritor da tabela, só gestor/master, com as MESMAS
--      travas (advisory por CNPJ e depois por dono), a mesma definição de posse ATIVA e o mesmo teto de 100 por dono;
--   4. `public.radar_vendedores_atribuiveis()` — quem pode receber (passa em `private.cap_radar_prospectar`).
--
-- O lead atribuído expira como qualquer outro: 7 dias depois do último toque válido do NOVO dono.
-- Idempotente: re-rodar não duplica coluna, constraint nem ACL. Transacional pelo SQL Editor.

-- ── PRE: o estado que esta migration pressupõe (medido em prod via psql-ro em 2026-11-06) ────────────────────
LOCK TABLE public.radar_atendimentos IN SHARE ROW EXCLUSIVE MODE;

DO $pre$
DECLARE
  v text;
BEGIN
  IF to_regclass('public.radar_atendimentos') IS NULL
     OR to_regprocedure('public.radar_definir_atendimento(text,text)') IS NULL
     OR to_regprocedure('private.radar_atendimento_expira_em(text,uuid,timestamp with time zone,timestamp with time zone)') IS NULL
     OR to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL
     OR to_regprocedure('public.pode_ver_carteira_completa(uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: falta a base da 20261029201200 (radar_atendimentos, definir, expira_em, capabilities)';
  END IF;
  -- O CHECK de motivos é TROCADO abaixo: só troca se for o de prod (os 4 motivos) ou já o desta migration (re-rodada).
  SELECT pg_get_constraintdef(c.oid) INTO v FROM pg_constraint c
   WHERE c.conrelid = 'public.radar_atendimentos'::regclass AND c.conname = 'radar_atendimentos_motivo_chk';
  IF v IS DISTINCT FROM $$CHECK ((motivo_encerramento = ANY (ARRAY['liberado'::text, 'expirado'::text, 'gestor_liberou'::text, 'dono_sem_acesso'::text])))$$
     AND v IS DISTINCT FROM $$CHECK ((motivo_encerramento = ANY (ARRAY['liberado'::text, 'expirado'::text, 'gestor_liberou'::text, 'dono_sem_acesso'::text, 'reatribuido'::text])))$$ THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_atendimentos_motivo_chk diverge do esperado: %', COALESCE(v, '(ausente)');
  END IF;
END
$pre$;

-- ── 1. Quem atribuiu ─────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.radar_atendimentos ADD COLUMN IF NOT EXISTS atribuido_por uuid;
COMMENT ON COLUMN public.radar_atendimentos.atribuido_por IS
  'Gestor/master que passou o lead ao dono (radar_atribuir_atendimento). NULL = o próprio dono assumiu.';
ALTER TABLE public.radar_atendimentos DROP CONSTRAINT IF EXISTS radar_atendimentos_atribuicao_chk;
ALTER TABLE public.radar_atendimentos ADD CONSTRAINT radar_atendimentos_atribuicao_chk
  CHECK (atribuido_por IS DISTINCT FROM dono_user_id);

-- ── 2. Motivo novo ───────────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.radar_atendimentos DROP CONSTRAINT IF EXISTS radar_atendimentos_motivo_chk;
ALTER TABLE public.radar_atendimentos ADD CONSTRAINT radar_atendimentos_motivo_chk
  CHECK (motivo_encerramento IN ('liberado', 'expirado', 'gestor_liberou', 'dono_sem_acesso', 'reatribuido'));

COMMENT ON TABLE public.radar_atendimentos IS
  'Radar: "em atendimento por X". 1 aberto por CNPJ; expira 7 dias depois do último toque VÁLIDO do dono '
  '(calculado na leitura por private.radar_atendimento_expira_em). Escritores: public.radar_definir_atendimento '
  '(assumir/liberar) e public.radar_atribuir_atendimento (gestor/master passa o lead a um vendedor).';

-- ── 3. Atribuir ──────────────────────────────────────────────────────────────────────────────────────────────
-- Mesma disciplina do definir: trava por CNPJ e depois por DONO (o de destino: o teto de 100 é dele), relógio lido
-- DEPOIS das travas, posse ATIVA = não expirada E dono ainda na capability. A posse de outro é FECHADA como
-- `reatribuido` (encerrado_por = quem atribuiu) — o gestor já podia liberá-la; atribuir é liberar + entregar.
CREATE OR REPLACE FUNCTION public.radar_atribuir_atendimento(p_cnpj text, p_dono uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_agora timestamptz;
  v_ja_cliente boolean;
  v_aberto public.radar_atendimentos;
  v_ativo boolean := false;
  v_expira timestamptz;
  v_dono_nome text;
  v_anterior_nome text;
  v_meus integer;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only' USING ERRCODE = '42501';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido' USING ERRCODE = '22023';
  END IF;
  IF p_dono IS NULL THEN
    RAISE EXCEPTION 'radar_atribuir_atendimento: vendedor ausente' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('radar_atendimento:' || p_cnpj, 0));
  PERFORM pg_advisory_xact_lock(hashtextextended('radar_atendimento_dono:' || p_dono::text, 0));
  v_agora := clock_timestamp();

  -- Destino fora da capability: a leitura (radar_atendimentos_ativos) nem mostraria a posse — seria um lead
  -- "livre" na tela e preso no banco.
  IF NOT (COALESCE(private.cap_radar_prospectar(p_dono), false)) THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'destino_sem_acesso');
  END IF;

  SELECT e.ja_cliente INTO v_ja_cliente FROM public.radar_empresas e WHERE e.cnpj = p_cnpj;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'empresa não encontrada: %', p_cnpj USING ERRCODE = 'P0002';
  END IF;
  IF COALESCE(v_ja_cliente, false) THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'ja_cliente');
  END IF;

  SELECT p.name INTO v_dono_nome FROM public.profiles p WHERE p.user_id = p_dono;

  SELECT * INTO v_aberto FROM public.radar_atendimentos a WHERE a.cnpj = p_cnpj AND a.encerrado_em IS NULL;
  IF FOUND THEN
    v_expira := private.radar_atendimento_expira_em(v_aberto.cnpj, v_aberto.dono_user_id, v_aberto.assumido_em, v_aberto.renovado_em);
    IF v_expira <= v_agora THEN
      UPDATE public.radar_atendimentos a
         SET encerrado_em = v_expira, motivo_encerramento = 'expirado'
       WHERE a.id = v_aberto.id;
    ELSIF NOT (COALESCE(private.cap_radar_prospectar(v_aberto.dono_user_id), false)) THEN
      UPDATE public.radar_atendimentos a
         SET encerrado_em = v_agora, motivo_encerramento = 'dono_sem_acesso'
       WHERE a.id = v_aberto.id;
    ELSE
      v_ativo := true;
    END IF;
  END IF;

  -- Já é do destino: nada a fazer (renovar é toque do DONO, não do gestor).
  IF v_ativo AND v_aberto.dono_user_id = p_dono THEN
    RETURN jsonb_build_object('ok', true, 'ja_era_dono', true, 'dono_nome', v_dono_nome, 'expira_em', v_expira);
  END IF;

  SELECT count(*) INTO v_meus FROM public.radar_atendimentos a
   WHERE a.dono_user_id = p_dono AND a.encerrado_em IS NULL
     AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > v_agora;
  IF v_meus >= 100 THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'limite', 'limite', 100, 'dono_nome', v_dono_nome);
  END IF;

  IF v_ativo THEN
    SELECT p.name INTO v_anterior_nome FROM public.profiles p WHERE p.user_id = v_aberto.dono_user_id;
    UPDATE public.radar_atendimentos a
       SET encerrado_em = v_agora, encerrado_por = v_uid, motivo_encerramento = 'reatribuido'
     WHERE a.id = v_aberto.id;
  END IF;

  INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em, atribuido_por)
  VALUES (p_cnpj, p_dono, v_agora, NULLIF(v_uid, p_dono));

  RETURN jsonb_build_object('ok', true, 'ja_era_dono', false, 'dono_nome', v_dono_nome,
    'anterior_nome', v_anterior_nome, 'tirou_de_outro', v_ativo,
    'expira_em', private.radar_atendimento_expira_em(p_cnpj, p_dono, v_agora, NULL));
END
$function$;
REVOKE ALL ON FUNCTION public.radar_atribuir_atendimento(text,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_atribuir_atendimento(text,uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.radar_atribuir_atendimento(text,uuid) IS
  'Radar: gestor/master passa o lead a um vendedor (fecha a posse de outro como reatribuido). Grava atribuido_por.';

-- ── 4. Quem pode receber ─────────────────────────────────────────────────────────────────────────────────────
-- Só gestor/master lê (é a lista do seletor de atribuição). Mesma regra do destino: passa na capability do Radar.
CREATE OR REPLACE FUNCTION public.radar_vendedores_atribuiveis()
 RETURNS TABLE(user_id uuid, nome text, papel text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT u.user_id, p.name,
           CASE WHEN public.has_role(u.user_id, 'master'::public.app_role) THEN 'master'
                ELSE (SELECT cr.commercial_role::text FROM public.commercial_roles cr WHERE cr.user_id = u.user_id LIMIT 1) END
      FROM (SELECT DISTINCT ur.user_id FROM public.user_roles ur
             WHERE ur.role IN ('master'::public.app_role, 'employee'::public.app_role)) u
      LEFT JOIN public.profiles p ON p.user_id = u.user_id
     WHERE private.cap_radar_prospectar(u.user_id)
     ORDER BY p.name NULLS LAST, u.user_id;
END
$function$;
REVOKE ALL ON FUNCTION public.radar_vendedores_atribuiveis() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_vendedores_atribuiveis() TO authenticated, service_role;

-- ── PÓS: relê o catálogo; qualquer estado insuficiente aborta a transação inteira ───────────────────────────
DO $post$
DECLARE
  r record;
  v text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.radar_atendimentos'::regclass
                   AND a.attname = 'atribuido_por' AND NOT a.attisdropped AND a.atttypid = 'uuid'::regtype) THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_atendimentos.atribuido_por ausente ou com outro tipo';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('radar_atendimentos_motivo_chk', 'reatribuido'),
      ('radar_atendimentos_motivo_chk', 'dono_sem_acesso'),
      ('radar_atendimentos_atribuicao_chk', 'atribuido_por IS DISTINCT FROM dono_user_id')
    ) AS x(nome, trecho)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.radar_atendimentos'::regclass
                     AND c.conname = r.nome AND c.contype = 'c' AND c.convalidated
                     AND strpos(pg_get_constraintdef(c.oid), r.trecho) > 0) THEN
      RAISE EXCEPTION 'P2 FALHOU: constraint % sem "%"', r.nome, r.trecho;
    END IF;
  END LOOP;
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.radar_atendimentos'::regclass)
     OR has_table_privilege('authenticated', 'public.radar_atendimentos', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('anon', 'public.radar_atendimentos', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'P3 FALHOU: radar_atendimentos perdeu a RLS ou abriu para o JWT';
  END IF;
  FOR r IN SELECT * FROM (VALUES ('public.radar_atribuir_atendimento(text,uuid)'),
                                  ('public.radar_vendedores_atribuiveis()')) AS x(sig)
  LOOP
    SELECT p.prosrc INTO v FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig) AND p.prosecdef;
    IF v IS NULL OR v !~ 'IF NOT \(COALESCE\(private\.cap_radar_prospectar\('
       OR v !~ 'IF NOT \(COALESCE\(public\.pode_ver_carteira_completa\(v_uid\), false\)\) THEN' THEN
      RAISE EXCEPTION 'P4 FALHOU: % ausente, sem SECDEF ou sem os 2 gates', r.sig;
    END IF;
    IF has_function_privilege('anon', r.sig, 'EXECUTE') OR has_function_privilege('public', r.sig, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'P5 FALHOU: ACL de % (anon/PUBLIC fechados, authenticated aberto)', r.sig;
    END IF;
  END LOOP;
  RAISE NOTICE 'radar_atribuir_atendimento: coluna + 2 constraints + 2 RPCs OK';
END
$post$;
