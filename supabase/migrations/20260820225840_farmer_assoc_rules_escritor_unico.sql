-- ============================================================================
-- farmer_association_rules — ESCRITOR ÚNICO (fence no banco)
--
-- POR QUE. A tabela é GLOBAL (não tem farmer_id) e alimenta quatro consumidores:
-- `get_meu_mixgap`, `melhoria_produtos_relacionados`, a edge `recommend` (assoc_score) e
-- `useCrossSellEngine`. Ela tinha DOIS escritores com modelos e universos DIFERENTES,
-- chamando a mesma RPC, e o último a escrever vencia:
--
--   · cron `compute-association-rules-daily` (edge `omie-analytics-sync`, service_role);
--   · o BROWSER (`useBundleEngine`), quando um gestor abria a tela de bundles.
--
-- Não é risco teórico — foi MEDIDO acontecendo (psql-ro, 2026-08-20/21):
--   2026-08-20 07:30 UTC → 24 regras, sample_size 479   (cron)
--   2026-08-21 01:33 UTC →  4 regras, sample_size 21.579 (browser)
-- A MESMA coluna `sample_size` passou a significar universos diferentes conforme quem
-- escreveu por último. E o produtor server-side lia 479 de 30.259 pedidos (cap silencioso
-- de 1.000 do PostgREST): corrigi-lo sem este fence daria uma correção com meia-vida de
-- uma abertura de tela. Viola "1 escritor por slug" (CLAUDE.md).
--
-- POR QUE DUAS METADES, e nenhuma sozinha basta (medido no ACL de prod antes de escrever):
--   (1) a RPC é SECURITY DEFINER (owner postgres) ⇒ ela BYPASSA a RLS. Fechar só a policy
--       deixaria a porta da RPC aberta para `authenticated`.
--   (2) `authenticated` tem ACL de tabela `arwdDxtm` — privilégio TOTAL, gatilhado apenas
--       pela RLS. Fechar só a RPC deixaria a via PostgREST crua aberta.
-- Por isso: REVOKE do EXECUTE **e** policy de escrita restrita. (money-path §5 — o guard
-- mora na fronteira que TODA via cruza.)
--
-- O QUE NÃO MUDA (conferido em prod ANTES de aplicar):
--   · `service_role` tem `rolbypassrls = true` ⇒ a edge/cron segue escrevendo e lendo.
--   · `get_meu_mixgap` e `melhoria_produtos_relacionados` são SECURITY DEFINER ⇒ intactos.
--   · A LEITURA pelo staff no browser (`useCrossSellEngine`, `useBundleEngine`) é preservada
--     — a policy nova mantém o MESMO predicado, só restringe o comando a SELECT.
--   · `anon` continua sem nada (o predicado exige role de staff; `auth.uid()` nulo reprova).
--
-- ⚠️ A policy vigente em PROD usa `'master'`, e a migration que a criou
-- (20260223030027) dizia `'admin'` — a definição divergiu do repo em algum apply manual.
-- Este arquivo replica a definição VIVA (`pg_policy`, lida via psql-ro), não a do repo.
-- ============================================================================

-- ── Pré-flight: falhar ALTO se o alvo não for o que este arquivo assume ──────────────
DO $$
BEGIN
  IF to_regprocedure('public.farmer_association_rules_substituir(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'farmer_association_rules_substituir(jsonb) não existe — migration fora de ordem';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.farmer_association_rules'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'RLS DESLIGADA em farmer_association_rules — a policy abaixo não seria fence nenhum';
  END IF;
END $$;

-- ── Metade 1: a porta da RPC (que bypassa RLS por ser DEFINER) ───────────────────────
-- `REVOKE ... FROM PUBLIC` NÃO tira `authenticated` (o grant é explícito, CLAUDE.md/database.md):
-- revoga-se NOMEANDO a role. `service_role` permanece — é quem o cron usa.
REVOKE EXECUTE ON FUNCTION public.farmer_association_rules_substituir(jsonb) FROM authenticated;

-- ── Metade 2: a via PostgREST crua (gatilhada só pela RLS) ───────────────────────────
-- Sai a policy FOR ALL, entra a mesma condição restrita a SELECT. Sem policy de
-- INSERT/UPDATE/DELETE, a RLS nega escrita por omissão para `authenticated`/`anon`.
DROP POLICY IF EXISTS "Staff can manage association rules" ON public.farmer_association_rules;
DROP POLICY IF EXISTS "Staff can read association rules" ON public.farmer_association_rules;

CREATE POLICY "Staff can read association rules"
  ON public.farmer_association_rules FOR SELECT
  USING (has_role(auth.uid(), 'master') OR has_role(auth.uid(), 'employee'));

-- ── Pós-verificação: a migration se recusa a "passar" sem ter fechado as duas portas ──
DO $$
DECLARE
  v_execute_authenticated boolean;
  v_policies_de_escrita   integer;
  v_policy_select         integer;
BEGIN
  v_execute_authenticated := has_function_privilege(
    'authenticated', 'public.farmer_association_rules_substituir(jsonb)', 'EXECUTE');
  IF v_execute_authenticated THEN
    RAISE EXCEPTION 'FENCE INCOMPLETO: authenticated ainda tem EXECUTE na RPC de substituição';
  END IF;

  SELECT count(*) INTO v_policies_de_escrita
  FROM pg_policy WHERE polrelid = 'public.farmer_association_rules'::regclass
    AND polcmd <> 'r';  -- 'r' = SELECT; qualquer outro comando é via de escrita
  IF v_policies_de_escrita > 0 THEN
    RAISE EXCEPTION 'FENCE INCOMPLETO: % policy(ies) de escrita sobreviveram', v_policies_de_escrita;
  END IF;

  SELECT count(*) INTO v_policy_select
  FROM pg_policy WHERE polrelid = 'public.farmer_association_rules'::regclass AND polcmd = 'r';
  IF v_policy_select <> 1 THEN
    RAISE EXCEPTION 'LEITURA QUEBRADA: esperava 1 policy de SELECT, achei % — o staff perderia o MixGap', v_policy_select;
  END IF;

  RAISE NOTICE 'OK: escritor único — authenticated sem EXECUTE, zero policy de escrita, leitura do staff preservada';
END $$;
