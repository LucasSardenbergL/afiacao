-- 20260718200000_register_carteira_member_source_rpc.sql
-- HOTFIX da Fatia 4 (money-path) — achado A do /codex challenge retroativo (gpt-5.6-sol xhigh), VERIFICADO.
--
-- ORDEM DE APPLY: esta roda ANTES da 20260718220100 (Fatia 5, seed_targets_faltantes). O wt:preflight
-- acusou 🔴 por substring, mas os objetos são DISJUNTOS: esta recria `register_carteira_member` +
-- `chk_ocam_source`; a da Fatia 5 recria só `seed_targets_faltantes` (menciona a RPC em comentário).
-- Verificado worktree a worktree em 18/07.
--
-- O DEFEITO
--   A RPC `register_carteira_member` gravava `source='manual'` na proof. Justifiquei como "manual já é a
--   autoridade mais forte do sistema" — verdade para override HUMANO, e ERRADO para writer automatizado.
--   `manual` não é só um rótulo: é IMUNIDADE. O sync deleta vínculos de doc ambíguo escopando
--   `.eq("source","document")` (omie-analytics-sync:461) justamente para preservar override humano. Ao
--   gravar `manual`, os 5 writers automatizados passaram a produzir linhas que o fail-closed de
--   ambiguidade NUNCA alcança — um vínculo suspeito sobreviveria à detecção, com vendedor possivelmente
--   errado e comissão em cima dele. É um buraco no fail-closed, aberto pela própria fatia que o reforçou.
--
--   Pior: o aviso estava ESCRITO no repo. `db/omie_customer_account_map_fresco.sql` diz, no contrato da
--   view: "Válido enquanto o sync (edge service_role) for o ÚNICO writer — se surgir 2º writer / edição
--   manual (source='manual'), promover coluna dedicada last_seen_sync_at (NÃO antes; Codex P2)".
--   A Fatia 4 criou exatamente esse 2º writer sem ler o contrato da view que ele afeta.
--
-- A CORREÇÃO
--   `source='rpc'` — valor NOVO, aditivo ao CHECK, que diz a verdade sobre a procedência (writer
--   automatizado de admissão) e, por não ser 'manual', volta a ser alcançável pelo delete de
--   ambiguidade. O par desta migration em `omie-analytics-sync` inclui 'rpc' no filtro daquele delete —
--   sem os dois lados, a correção é meia.
--
--   Backfill das linhas já gravadas: medido por psql-ro em 18/07 — 393 linhas `manual`, TODAS criadas
--   pela RPC a partir de 19:34:31 de hoje; ZERO `manual` anteriores (não há override humano legítimo a
--   preservar). O UPDATE é escopado por data para não depender disso permanecer verdade.
--
-- RESÍDUO REGISTRADO (fora deste hotfix, de propósito): `updated_at`. O contrato da view `_fresco` define
--   `updated_at` como "última vez que o SYNC viu a linha", e a RPC também o escreve — um vínculo
--   confirmado pela RPC parece "visto pelo sync" e renova o TTL de 7d. Com `source='rpc'` a imunidade
--   acaba (o delete alcança), o que remove o dano money-path; o que resta é imprecisão semântica do
--   frescor. A correção completa é promover `last_seen_sync_at` atualizado SÓ pelo sync — mexe na view e
--   nos seus 2 consumidores de leitura, raio grande demais para um hotfix. Follow-up explícito.

-- ── 1. Domínio de `source` da proof ganha 'rpc' (aditivo) ──
ALTER TABLE public.omie_customer_account_map
  DROP CONSTRAINT IF EXISTS chk_ocam_source;

ALTER TABLE public.omie_customer_account_map
  ADD CONSTRAINT chk_ocam_source
  CHECK (source IN ('document', 'code', 'manual', 'rpc'));

-- ── 2. A RPC passa a gravar 'rpc' (o resto do corpo é idêntico ao 20260718170000) ──
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

  -- Membership (acumulador). DO NOTHING preserva first_seen_at E identity_state de quem já é membro:
  -- um quarantinado (ambiguous/conflict) NÃO volta a verified por re-chamada.
  INSERT INTO public.carteira_membership_ledger (user_id, identity_state, first_seen_at, source, updated_at)
  VALUES (p_user_id, 'verified', now(), 'rpc', now())
  ON CONFLICT (user_id) DO NOTHING;

  -- Proof account-correta. `source='rpc'` (NÃO 'manual'): diz a verdade sobre a procedência e mantém a
  -- linha alcançável pelo delete de ambiguidade do sync — 'manual' é reservado a override HUMANO, que é
  -- o único que merece imunidade ao fail-closed.
  -- `p_account` é validado pelo CHECK `chk_ocam_account` ('oben'|'colacor'|'colacor_sc'): o slug INTERNO
  -- do sync ('vendas'|'servicos'|'colacor_vendas') levanta 23514 em vez de gravar conta errada.
  -- Vendedor ausente NUNCA é fabricado como 0 — COALESCE preserva o vendedor já conhecido.
  INSERT INTO public.omie_customer_account_map (
    user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, updated_at
  )
  VALUES (
    p_user_id, p_account, p_omie_codigo_cliente, p_omie_codigo_vendedor, 'rpc', now()
  )
  ON CONFLICT (user_id, account) DO UPDATE SET
    omie_codigo_cliente  = EXCLUDED.omie_codigo_cliente,
    omie_codigo_vendedor = COALESCE(EXCLUDED.omie_codigo_vendedor, omie_customer_account_map.omie_codigo_vendedor),
    -- NÃO rebaixa um override humano: se a linha já é 'manual', permanece 'manual'.
    source               = CASE WHEN omie_customer_account_map.source = 'manual' THEN 'manual' ELSE 'rpc' END,
    updated_at           = now();
END
$fn$;

COMMENT ON FUNCTION public.register_carteira_member(uuid, text, bigint, bigint) IS
  'P0-B-bis Fatia 4 (+hotfix source=rpc): admite membro na carteira escrevendo ledger (membership '
  'acumuladora) + omie_customer_account_map (proof account-correta, source=rpc). SECURITY INVOKER de '
  'propósito: a RLS staff-only das duas tabelas é o gate — DEFINER abriria escrita que a RLS hoje fecha. '
  'source=rpc e NAO manual: manual é imune ao delete de ambiguidade do sync (reservado a override '
  'humano); writer automatizado precisa continuar alcançável pelo fail-closed. Nunca rebaixa '
  'identity_state (não ressuscita quarantinado); UNIQUE(codigo,account) fail-closed contra roubo '
  'de vínculo cross-user.';

REVOKE ALL ON FUNCTION public.register_carteira_member(uuid, text, bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_carteira_member(uuid, text, bigint, bigint) FROM anon;
GRANT EXECUTE ON FUNCTION public.register_carteira_member(uuid, text, bigint, bigint)
  TO authenticated, service_role;

-- ── 3. Backfill: as linhas que a RPC já gravou como 'manual' perdem a imunidade indevida ──
-- Escopado por data: só o que a RPC escreveu (medido: 393 linhas a partir de 18/07 19:34; zero 'manual'
-- anteriores). Idempotente — re-rodar não afeta nada além do alvo.
UPDATE public.omie_customer_account_map
   SET source = 'rpc'
 WHERE source = 'manual'
   AND created_at >= '2026-07-18 19:00:00+00';
