-- ============================================================
-- gamification_scores — o cliente deixa de gravar o próprio score
-- Scanner Lovable Security, lote 6 (docs/historico/scanner-lovable-rescan-lote6.md):
-- "Any signed-in user can inflate their gamification score" (Critical).
--
-- O score é calculado no navegador (src/hooks/useGamificationScore.ts) e as duas policies abaixo
-- deixavam o próprio usuário gravar a linha dele: qualquer logado escrevia o score que quisesse
-- direto pela API. O upsert do hook saiu no mesmo PR. Ficam as policies de leitura (a do dono e a
-- do staff) e a "Staff can manage all gamification scores".
--
-- Idempotente (DROP ... IF EXISTS). Colar no SQL Editor: o envelope BEGIN/COMMIT é do arquivo.
-- ============================================================
BEGIN;

DROP POLICY IF EXISTS "Users can upsert their own score" ON public.gamification_scores;
DROP POLICY IF EXISTS "Users can update their own score" ON public.gamification_scores;

DO $post$
DECLARE
  v_escrita_do_cliente int;
  v_restantes int;
BEGIN
  -- Nenhuma policy de INSERT/UPDATE/ALL pode sobrar além da de staff.
  SELECT count(*) INTO v_escrita_do_cliente
    FROM pg_policy p
   WHERE p.polrelid = 'public.gamification_scores'::regclass
     AND p.polcmd IN ('a', 'w', 'd', '*')
     AND p.polname <> 'Staff can manage all gamification scores';
  IF v_escrita_do_cliente IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'A1 FALHOU: % policy(ies) de escrita fora da de staff em gamification_scores — o cliente ainda grava o proprio score', v_escrita_do_cliente;
  END IF;
  -- As 3 que ficam: leitura do dono, leitura do staff, gestao do staff.
  SELECT count(*) INTO v_restantes
    FROM pg_policy p
   WHERE p.polrelid = 'public.gamification_scores'::regclass
     AND p.polname IN ('Users can view their own gamification score',
                       'Staff can view all gamification scores',
                       'Staff can manage all gamification scores');
  IF v_restantes IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'A2 FALHOU: esperava as 3 policies que ficam, achei % — algo alem do previsto foi removido', v_restantes;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.gamification_scores'::regclass) THEN
    RAISE EXCEPTION 'A3 FALHOU: RLS desligada em gamification_scores';
  END IF;
END
$post$;

COMMIT;
