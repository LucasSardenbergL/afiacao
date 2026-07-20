-- ╔══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║  FU4-H — as 2 tabelas de compras que ficaram FORA da matriz  [money-path / autorização]    ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════╝
-- Prova: db/test-authz-cap-compras-ler-alertas-fu4h.sh (PG17, SET ROLE authenticated, com falsificação)
-- Continuação do E2/FU4 (#1434), FU4-E (#1462) e FU4-G (#1472) — todos aplicados.
-- Achado da revisão adversária retroativa via Codex (2026-07-20), confirmado em prod via psql-ro.
--
-- ── O FURO (medido em prod, 2026-07-20) ────────────────────────────────────────────────────
-- O #1434 fechou NOVE tabelas `reposicao_*` em `private.cap_compras_ler` (master-only). Existem
-- TREZE. Duas das quatro restantes carregam exatamente a classe de dado que a matriz protege:
--   · reposicao_alerta_pedido_minimo → fornecedor_nome, valor_alertado, valor_ultimo, pedido_id
--   · reposicao_auto_aprovacao_log   → fornecedor_nome, valor_total, valor_anterior, delta_pct
-- Ambas com policy de SELECT para `employee OR master`. O #1472 fechou `reposicao_pos_candidatos`
-- JUSTAMENTE porque ela projetava `valor_total` e `fornecedor_nome` — os mesmos campos, a mesma
-- decisão, outra porta. Fechar 9 tabelas e deixar o mesmo dado legível em 2 vizinhas não é uma
-- matriz de autorização, é uma matriz com exceção não declarada.
--
-- ── EXPOSIÇÃO REAL, NÃO LATENTE (≠ FU4-E/FU4-G) ────────────────────────────────────────────
-- Medido 2026-07-20: `reposicao_alerta_pedido_minimo` tem 24 LINHAS VIVAS (última 2026-07-08);
-- `reposicao_auto_aprovacao_log` está vazia (exposição latente). E há POPULAÇÃO: os 2 usuários
-- `farmer` têm app_role `employee` (medido) e ZERO deles passa em `cap_compras_ler`. São
-- precisamente as pessoas que a matriz barra nas 9 tabelas, lendo o mesmo dado nesta.
-- Diferente do FU4-E/FU4-G (onde a troca não retirava acesso de ninguém vivo), esta RETIRA — e é
-- exatamente o que se decidiu: farmer não vê valor de compra (decisão do founder, 2026-07-20).
--
-- ── POR QUE ISTO NÃO QUEBRA NADA (verificado, não presumido) ────────────────────────────────
-- · LEITURA: `grep` em `src/` e `supabase/functions/` — NENHUM consumidor lê as duas tabelas.
--   Não há tela, hook ou edge que as consulte. Fechar o SELECT não derruba UX alguma.
-- · ESCRITA: as duas são escritas SÓ por `public.reposicao_alerta_pedido_minimo_tick()` —
--   SECURITY DEFINER, `has_function_privilege(authenticated)=false` (service-role-only), chamada
--   pela edge `gerar-pedidos-diario`. SECDEF bypassa RLS ⇒ trocar a policy de SELECT não a toca.
-- · Esta migration mexe em UMA policy por tabela, de comando SELECT (`polcmd='r'`). Não há policy
--   de INSERT/UPDATE/DELETE nas duas (medido) — nada de escrita é criado nem alterado aqui.
--
-- ── POR QUE RENOMEAR A POLICY (e não só trocar o USING) ────────────────────────────────────
-- Os nomes atuais são "Staff lê alertas de pedido mínimo" e "Staff lê log de auto-aprovação".
-- Depois da troca elas NÃO são mais staff-readable — são master-only. Manter o nome deixaria no
-- catálogo uma afirmação FALSA sobre quem lê, que é a mesma dívida que o #1472 pagou ao corrigir
-- um comentário em vez de deixá-lo mentir. Os nomes novos seguem o padrão das 9 (`<tabela>_sel`).
--
-- ⚠️ Migration MANUAL (Lovable não aplica nome custom) — colar no SQL Editor.

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 0) PRECONDIÇÕES — aborta se o banco vivo divergir do medido
-- ════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_gerenciais int;
BEGIN
  IF to_regclass('public.reposicao_alerta_pedido_minimo') IS NULL
     OR to_regclass('public.reposicao_auto_aprovacao_log') IS NULL THEN
    RAISE EXCEPTION 'FU4-H: tabela(s) alvo ausente(s) — banco divergente, abortando'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- DEPENDÊNCIA REAL: o gate de destino é a capability do #1434. Sem ela, a policy nasceria
  -- referenciando função inexistente e TODA leitura das duas tabelas quebraria em runtime
  -- (inclusive para o master). Precondição explícita em vez de caller órfão (a falha do #1423).
  IF to_regprocedure('private.cap_compras_ler(uuid)') IS NULL THEN
    RAISE EXCEPTION 'FU4-H: private.cap_compras_ler(uuid) ausente — aplique o #1434 (20260718190000) antes'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF to_regclass('public.commercial_roles') IS NULL THEN
    RAISE EXCEPTION 'FU4-H: tabela commercial_roles ausente — banco divergente, abortando'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Coerência com FU4-E/FU4-G: um papel gerencial vivo mudaria o acesso dele sem aviso.
  SELECT count(*) INTO v_gerenciais FROM public.commercial_roles
   WHERE commercial_role IN ('gerencial','estrategico','super_admin');
  IF v_gerenciais > 0 THEN
    RAISE EXCEPTION 'FU4-H: % papel(is) gerencial(is) vivo(s) — revise antes de aplicar', v_gerenciais
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 1) A TROCA — policy de SELECT sai de "staff" e entra em cap_compras_ler
-- ════════════════════════════════════════════════════════════════════════════════════════════
-- Guardada: só dropa o que RECONHECE. Se a policy de SELECT viva não for a medida (outra
-- migration a reescreveu), aborta em vez de destruir uma regra que não conhece.
DO $$
DECLARE
  r          record;
  v_qual     text;
  v_n_sel    int;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('reposicao_alerta_pedido_minimo', 'reposicao_alerta_pedido_minimo_sel'),
      ('reposicao_auto_aprovacao_log',   'reposicao_auto_aprovacao_log_sel')
    ) AS t(tabela, pol_nova)
  LOOP
    -- IDEMPOTENTE: já migrada ⇒ segue. O dono cola à mão; queda de rede não pode travar a 2ª vez.
    IF EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
                JOIN pg_namespace n ON n.oid = c.relnamespace
               WHERE n.nspname = 'public' AND c.relname = r.tabela AND p.polname = r.pol_nova) THEN
      RAISE NOTICE 'FU4-H: %.% já migrada — nada a fazer', r.tabela, r.pol_nova;
      CONTINUE;
    END IF;

    -- exatamente UMA policy de SELECT (polcmd='r') — mais de uma significa desenho diferente do
    -- medido, e dropar "a primeira" seria arbitrário.
    SELECT count(*) INTO v_n_sel
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = r.tabela AND p.polcmd = 'r';
    IF v_n_sel <> 1 THEN
      RAISE EXCEPTION 'FU4-H: esperava 1 policy de SELECT em %, encontrei % — inspecione pg_policy antes de prosseguir', r.tabela, v_n_sel
        USING ERRCODE = 'raise_exception';
    END IF;

    -- e ela tem de ser a policy "staff" MEDIDA (lê user_roles e concede a employee). Se o USING
    -- for outro, esta migration não sabe o que está substituindo.
    SELECT pg_get_expr(p.polqual, p.polrelid) INTO v_qual
      FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = r.tabela AND p.polcmd = 'r';
    IF v_qual !~ 'user_roles' OR v_qual !~ 'employee' THEN
      RAISE EXCEPTION 'FU4-H: a policy de SELECT de % não é a staff medida (USING=%) — abortando', r.tabela, v_qual
        USING ERRCODE = 'raise_exception';
    END IF;

    -- dropa a antiga PELO NOME REAL lido do catálogo (os nomes têm espaço e acento; nunca
    -- hardcodar string literal aqui — %I cita corretamente o que o catálogo devolveu).
    EXECUTE (
      SELECT format('DROP POLICY %I ON public.%I', p.polname, r.tabela)
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = r.tabela AND p.polcmd = 'r'
    );

    -- `(SELECT ...)` envolvendo a chamada: initplan, avaliado UMA vez por query em vez de por
    -- linha — é o padrão das 9 policies do #1434.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ((SELECT private.cap_compras_ler((SELECT auth.uid()))))',
      r.pol_nova, r.tabela);
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- 2) PÓS-CHECK POSITIVO no catálogo (dentro da transação — falha ⇒ ROLLBACK)
-- ════════════════════════════════════════════════════════════════════════════════════════════
DO $$
DECLARE v_ok int; v_velha int;
BEGIN
  SELECT count(*) INTO v_ok
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
     AND p.polcmd = 'r'
     AND pg_get_expr(p.polqual, p.polrelid) ~ 'cap_compras_ler';
  IF v_ok <> 2 THEN
    RAISE EXCEPTION 'FU4-H: pos-check falhou — % de 2 policies no gate novo', v_ok
      USING ERRCODE = 'raise_exception';
  END IF;

  -- e NENHUMA das duas pode ter sobrado no gate staff
  SELECT count(*) INTO v_velha
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
     AND p.polcmd = 'r'
     AND pg_get_expr(p.polqual, p.polrelid) ~ 'user_roles';
  IF v_velha <> 0 THEN
    RAISE EXCEPTION 'FU4-H: pos-check falhou — % policy(s) ainda no gate staff', v_velha
      USING ERRCODE = 'raise_exception';
  END IF;

  -- RLS tem de seguir ligada nas duas: policy nova com RLS desligada seria decorativa.
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relname IN ('reposicao_alerta_pedido_minimo','reposicao_auto_aprovacao_log')
                AND NOT c.relrowsecurity) THEN
    RAISE EXCEPTION 'FU4-H: pos-check falhou — RLS desligada em alguma das 2 tabelas'
      USING ERRCODE = 'raise_exception';
  END IF;
END $$;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO PÓS-APPLY → db/valida-fu4h-alertas-compras.sql (só catálogo; roda de qualquer role).
-- Não repetida aqui: uma query que SELECIONA das tabelas mentiria de duas formas (o superuser do
-- SQL Editor bypassa RLS ⇒ "vejo tudo" não prova nada; e 0 linhas pode ser tabela vazia, não
-- policy funcionando). database.md, §validação pós-apply.
-- ════════════════════════════════════════════════════════════════════════════════════════════
