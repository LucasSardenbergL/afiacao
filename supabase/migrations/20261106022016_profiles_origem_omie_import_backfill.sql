-- ============================================================
-- C7 do plano v7 (APROV-FANTASMA): marca prospect_source = 'omie_import' nos profiles criados pela
-- edge omie-cliente junto de um usuário Auth PLACEHOLDER. Só dados, sem DDL.
--
-- POR QUÊ: o import no servidor (#3496/#3501/#3511) e o `criar_perfil_local` inseriam o profile SEM
--   origem. A fila de aprovações (AdminApprovals.tsx) e o KPI da home (useSistemaZone.ts) excluem o
--   fantasma por `prospect_source = 'omie_import'`, então contavam 16.070 clientes importados como
--   cadastro pendente (psql-ro, 2026-11-05). Na fila (sem .range(), created_at desc), os 1.000
--   primeiros eram fantasmas e um pedido real de conta ficava fora da janela.
--   A edge v1.7-perfil-placeholder-com-origem já grava a origem no profile que cria. Este arquivo
--   corrige os que nasceram antes dela.
--
-- CRITÉRIO = PROCEDÊNCIA, não data nem o mapa Omie. O mapa prova vínculo comercial, e o próprio
--   import vincula profiles PREEXISTENTES por documento (omie-cliente/index.ts, `profileByDoc`).
--   Quem prova "nasceu do import" é o usuário Auth que a edge cria junto: e-mail
--   `omie_<codigo>@placeholder.local` E `raw_user_meta_data.is_placeholder = true`. Por cima disso,
--   as travas de "pessoa real": nunca logou (last_sign_in_at nulo), não aprovado, não funcionário e
--   sem papel diferente de customer. O que ficar fora (divergência) continua na fila e é
--   contado no NOTICE, para tratar à parte.
--
-- O QUE NÃO FAZ: não toca is_approved, papéis (user_roles), auth.users nem os aliases fiscais
--   (placeholders SEM profile, CLAUDE.md §aliases fiscais). Só preenche origem NULA: re-rodar é no-op.
--   O UPDATE só dispara `update_profiles_updated_at` (updated_at = now()). Os triggers de papel
--   (UPDATE OF is_employee, document) e de aprovação (UPDATE OF is_approved) não disparam.
--
-- APLICAÇÃO: `bun run db:aplicar` (o executor abre e fecha a transação; sem BEGIN/COMMIT aqui).
--   O executor roda como postgres, que lê auth.users. O claude_ro não lê, por isso a validação
--   por fora mede o efeito em public.profiles.
-- ============================================================

DO $c7$
DECLARE
  v_pend_antes  integer;
  v_marcados    integer;
  v_nao_placeh  integer;
  v_logou       integer;
  v_staff       integer;
BEGIN
  SELECT count(*) INTO v_pend_antes
    FROM public.profiles
   WHERE is_approved = false AND prospect_source IS NULL;

  UPDATE public.profiles p
     SET prospect_source = 'omie_import'
    FROM auth.users u
   WHERE u.id = p.user_id
     AND p.prospect_source IS NULL
     AND p.is_approved = false
     AND p.is_employee IS NOT TRUE
     AND u.email LIKE 'omie\_%@placeholder.local'
     AND u.raw_user_meta_data ->> 'is_placeholder' = 'true'
     AND u.last_sign_in_at IS NULL
     AND NOT EXISTS (
           SELECT 1 FROM public.user_roles r
            WHERE r.user_id = p.user_id AND r.role <> 'customer'::public.app_role);
  GET DIAGNOSTICS v_marcados = ROW_COUNT;

  -- Divergências: pendentes sem origem que NÃO entraram. Ficam na fila, como deve ser.
  SELECT count(*) FILTER (WHERE u.id IS NULL
                             OR u.email NOT LIKE 'omie\_%@placeholder.local'
                             OR COALESCE(u.raw_user_meta_data ->> 'is_placeholder', '') <> 'true'),
         count(*) FILTER (WHERE u.last_sign_in_at IS NOT NULL),
         count(*) FILTER (WHERE p.is_employee IS TRUE OR EXISTS (
                            SELECT 1 FROM public.user_roles r
                             WHERE r.user_id = p.user_id AND r.role <> 'customer'::public.app_role))
    INTO v_nao_placeh, v_logou, v_staff
    FROM public.profiles p
    LEFT JOIN auth.users u ON u.id = p.user_id
   WHERE p.is_approved = false AND p.prospect_source IS NULL;

  RAISE NOTICE 'C7: pendentes sem origem antes=% · marcados omie_import=% · restam: nao_placeholder=% ja_logou=% staff=%',
    v_pend_antes, v_marcados, v_nao_placeh, v_logou, v_staff;
END
$c7$;

DO $post$
BEGIN
  -- P1 (cobertura): nenhum profile que casa o critério ficou sem origem.
  IF EXISTS (
       SELECT 1 FROM public.profiles p JOIN auth.users u ON u.id = p.user_id
        WHERE p.prospect_source IS NULL
          AND p.is_approved = false
          AND p.is_employee IS NOT TRUE
          AND u.email LIKE 'omie\_%@placeholder.local'
          AND u.raw_user_meta_data ->> 'is_placeholder' = 'true'
          AND u.last_sign_in_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM public.user_roles r
                           WHERE r.user_id = p.user_id AND r.role <> 'customer'::public.app_role)) THEN
    RAISE EXCEPTION 'C7 P1 FALHOU: sobrou placeholder do import sem origem — a fila continuaria contando fantasma';
  END IF;

  -- P2 (precisão): TODO profile com omie_import é placeholder do import, nunca logou e não está
  -- aprovado. Um perfil real marcado sumiria da fila sem ninguém ver.
  IF EXISTS (
       SELECT 1 FROM public.profiles p LEFT JOIN auth.users u ON u.id = p.user_id
        WHERE p.prospect_source = 'omie_import'
          AND (u.id IS NULL
               OR u.email NOT LIKE 'omie\_%@placeholder.local'
               OR COALESCE(u.raw_user_meta_data ->> 'is_placeholder', '') <> 'true'
               OR u.last_sign_in_at IS NOT NULL
               OR p.is_approved IS TRUE
               OR p.is_employee IS TRUE)) THEN
    RAISE EXCEPTION 'C7 P2 FALHOU: omie_import em profile que não é placeholder intocado — perfil real escondido da fila';
  END IF;

  -- P3 (papel): nenhum omie_import com papel de staff.
  IF EXISTS (
       SELECT 1 FROM public.profiles p JOIN public.user_roles r ON r.user_id = p.user_id
        WHERE p.prospect_source = 'omie_import' AND r.role <> 'customer'::public.app_role) THEN
    RAISE EXCEPTION 'C7 P3 FALHOU: omie_import em usuário com papel diferente de customer';
  END IF;
END
$post$;
