-- 20260718170000_register_carteira_member.sql
-- P0-B-bis Fatia 4 (money-path) — a via de entrada de membro na carteira sai do espelho `omie_clientes`.
-- ADITIVA: nada a chama até os writers migrarem (edges + Publish vêm DEPOIS desta migration).
--
-- POR QUE ESTA RPC EXISTE
--   Até aqui o único caminho de admissão de membro novo era: writer INSERT em `omie_clientes` →
--   trigger `trg_omie_clientes_to_ledger` (AFTER INSERT, Fatia 0) → `carteira_membership_ledger`.
--   A Fatia 5 dropa `omie_clientes` e o trigger cai junto — sem esta RPC, NENHUM cliente novo entraria
--   na carteira depois do DROP: sem vendedor, sem comissão, silenciosamente. Medido em 18/07 por psql-ro:
--   ledger = 6909 linhas, TODAS `source='backfill'` — zero 'trigger'. A via de admissão já está inerte
--   (2 INSERTs no espelho em 4 meses); esta RPC é quem a substitui, agora explícita e provada.
--
-- SECURITY INVOKER — DELIBERADO, NÃO ESQUECIMENTO
--   A tentação era SECURITY DEFINER + gate interno. Seria falha ABERTA: hoje a RLS de `omie_clientes`
--   só concede ALL a staff (`has_role master|employee`), e é por isso que o writer do signup
--   (`Auth.tsx:133`) NUNCA gravou uma linha — 0 de 6909 têm a assinatura `APP_%` que só ele produz;
--   o `insert` não checava `error`, então falhava em silêncio desde março. Um DEFINER "migrando" aquele
--   writer teria ABERTO um caminho de escrita que a RLS hoje fecha, deixando um customer anexar-se a um
--   código Omie arbitrário. Com INVOKER, a autorização é exatamente a de hoje, sem gate custom:
--     · edges (`service_role`) → BYPASSRLS, funcionam;
--     · `AdminApprovals` (staff autenticado) → policy "Staff can manage ..." nas DUAS tabelas, funciona;
--     · customer comum / anon → RLS nega, como já negava. Fail-closed preservado.
--   Por isso `Auth.tsx:133` é REMOVIDO nesta fatia, não migrado (writer morto; migrar = abrir superfície).
--
-- AS DUAS PONTAS (e por que os ON CONFLICT são diferentes)
--   ledger = membership, fato histórico ACUMULADOR → ON CONFLICT DO NOTHING. Nunca sobrescreve
--     `first_seen_at` (a data REAL do vínculo, que `analytics-sync:1566` consome) e — o invariante que
--     mais importa — NUNCA rebaixa `identity_state`: um membro `ambiguous`/`conflict` (quarantinado pela
--     Fatia 2: vendedor null, eligible=false, zero comissão) NÃO volta a `verified` por uma re-chamada.
--     Ressuscitar um quarantinado devolveria comissão sobre um cliente cuja identidade não sabemos.
--   proof = projeção account-correta, revogável → ON CONFLICT (user_id, account) DO UPDATE com
--     `source='manual'`. `manual` já é a autoridade mais forte do sistema: o delete de ambíguos do sync
--     (`analytics-sync:461`) é escopado a `source='document'` justamente para preservar override humano.
--
-- FAIL-CLOSED DELIBERADO: a UNIQUE `uq_ocam_codigo_account` NÃO é tratada por ON CONFLICT. Se o código
--   Omie já pertence a OUTRO user na mesma conta, o INSERT levanta 23505 e a chamada FALHA. É o
--   comportamento correto no money-path: roubar o vínculo do outro user mandaria o pedido para o cliente
--   errado. Precisão > recall.
--
-- `source='sync'` é ADITIVO ao CHECK do ledger: o bulk `omie-analytics-sync` passa a inserir membros
--   direto (em massa, não via esta RPC — N+1 de 5239 chamadas seria a armadilha de enumeração pesada do
--   CLAUDE.md). Ampliar o domínio de um CHECK é seguro; nenhuma linha existente viola.

-- ── 1. Domínio de `source` ganha 'sync' (aditivo — o bulk escreve o ledger direto, em massa) ──
ALTER TABLE public.carteira_membership_ledger
  DROP CONSTRAINT IF EXISTS carteira_membership_ledger_source_check;

ALTER TABLE public.carteira_membership_ledger
  ADD CONSTRAINT carteira_membership_ledger_source_check
  CHECK (source IN ('backfill', 'trigger', 'rpc', 'sync'));

-- ── 2. A RPC ──
CREATE OR REPLACE FUNCTION public.register_carteira_member(
  p_user_id              uuid,
  p_account              text,
  p_omie_codigo_cliente  bigint,
  p_omie_codigo_vendedor bigint DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
BEGIN
  IF p_user_id IS NULL OR p_omie_codigo_cliente IS NULL THEN
    RAISE EXCEPTION 'register_carteira_member: user_id e omie_codigo_cliente são obrigatórios'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  -- Membership (acumulador). DO NOTHING preserva first_seen_at E identity_state de quem já é membro.
  INSERT INTO public.carteira_membership_ledger (user_id, identity_state, first_seen_at, source, updated_at)
  VALUES (p_user_id, 'verified', now(), 'rpc', now())
  ON CONFLICT (user_id) DO NOTHING;

  -- Proof account-correta. `p_account` é validado pelo CHECK `chk_ocam_account` da tabela
  -- ('oben'|'colacor'|'colacor_sc') — fonte única de verdade. O slug INTERNO do sync ('vendas',
  -- 'servicos', 'colacor_vendas') NÃO é aceito aqui: passá-lo levanta 23514 em vez de gravar conta
  -- errada. Vendedor ausente NUNCA é fabricado como 0 — COALESCE preserva o vendedor já conhecido.
  INSERT INTO public.omie_customer_account_map (
    user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, updated_at
  )
  VALUES (
    p_user_id, p_account, p_omie_codigo_cliente, p_omie_codigo_vendedor, 'manual', now()
  )
  ON CONFLICT (user_id, account) DO UPDATE SET
    omie_codigo_cliente  = EXCLUDED.omie_codigo_cliente,
    omie_codigo_vendedor = COALESCE(EXCLUDED.omie_codigo_vendedor, omie_customer_account_map.omie_codigo_vendedor),
    source               = 'manual',
    updated_at           = now();
END
$fn$;

COMMENT ON FUNCTION public.register_carteira_member(uuid, text, bigint, bigint) IS
  'P0-B-bis Fatia 4: admite membro na carteira escrevendo ledger (membership acumuladora) + '
  'omie_customer_account_map (proof account-correta, source=manual). Substitui os writers de '
  'omie_clientes. SECURITY INVOKER de propósito: a RLS staff-only das duas tabelas é o gate — '
  'DEFINER abriria escrita que a RLS hoje fecha. Nunca rebaixa identity_state (não ressuscita '
  'quarantinado); UNIQUE(codigo,account) fail-closed contra roubo de vínculo cross-user.';

-- ── 3. Superfície de execução ──
-- A função nasce com EXECUTE p/ PUBLIC (default do Postgres). Revoga e concede por NOME: no Supabase,
-- REVOKE FROM PUBLIC não tira grant explícito de anon/authenticated (armadilha do CLAUDE.md).
REVOKE ALL ON FUNCTION public.register_carteira_member(uuid, text, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_carteira_member(uuid, text, bigint, bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_carteira_member(uuid, text, bigint, bigint)
  TO authenticated, service_role;
