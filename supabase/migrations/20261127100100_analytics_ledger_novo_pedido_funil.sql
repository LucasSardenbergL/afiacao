-- ============================================================
-- analytics_ledger_registrar — allowlist ganha o FUNIL do Novo Pedido (/sales/new, rodada 3 onda 2, PR 9.1)
-- ============================================================
--   novo_pedido.iniciado · cliente_escolhido · primeiro_item       chave = jornada (uuid aleatório por pedido)
--   novo_pedido.envio_tentado · envio_falhou · envio_confirmado    chave = jornada:tentativa[:classe] | jornada:conta
--   novo_pedido.ia_analise_pedida · ia_itens_adicionados · ia_itens_descartados   chave = jornada:seq
--   novo_pedido.rascunho_restaurado · rascunho_descartado                         chave = jornada:seq
--   Props só enums e contagens (+ checkout_id do envelope, a ponte com sales_orders) — nenhum id,
--   nome ou documento de cliente. Emissor: src/hooks/unifiedOrder/sensor-funil.ts.
--   Leitura com denominador: db/sensor-novo-pedido-funil.sql.
--
-- O corpo é o VIVO de prod (= 20261121231200_analytics_ledger_clientes_ficha_acao.sql, md5(prosrc)
-- 4c6e2d58678ba00e2c1d5c14b9c2d88b lido via psql-ro em 2026-11-26). Muda SÓ a allowlist (o teste
-- src/lib/__tests__/analytics-ledger-paridade.test.ts lê ESTE arquivo). Molde TRAVA → PRE → CREATE → PÓS:
-- a PRE aborta se o corpo vivo não for o predecessor nem este. A PÓS exige os 32 eventos e anon sem EXECUTE.
--
-- Aplicação: `bun run db:aplicar supabase/migrations/20261127100100_analytics_ledger_novo_pedido_funil.sql`
-- (sem BEGIN/COMMIT: o executor fornece a transação).
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA é VOLATILE) prende a função até o fim.
DO $trava$
BEGIN
  ALTER FUNCTION public.analytics_ledger_registrar(text, text, jsonb) VOLATILE;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor revisado, este}. Ausente ABORTA.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('4c6e2d58678ba00e2c1d5c14b9c2d88b', 'b40dc0f99d2ca61d049593b67acc6d25') THEN
    RAISE EXCEPTION 'PRE FALHOU: analytics_ledger_registrar vivo (md5 %) nao e o predecessor revisado nem este - outra sessao mexeu na allowlist; reconcilie antes', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.analytics_ledger_registrar(p_evento text, p_chave text, p_props jsonb DEFAULT '{}'::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_dia  text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
BEGIN
  -- SECURITY DEFINER bypassa RLS ⇒ o gate vive AQUI, na fronteira.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: exige usuario autenticado'
      USING ERRCODE = '28000';
  END IF;

  -- Allowlist FECHADA: o ledger não é canal genérico de escrita no banco.
  IF p_evento NOT IN ('carteira.mixgap_servido', 'navegacao.rota_servida', 'dashboard.crescimento_comparavel_servido',
                      'venda.ficha_aberta', 'venda.contato_registrado', 'venda.tel_clicado', 'venda.painel_aberto',
                      'financeiro.ciclo_aberto', 'reposicao.corantes_aberta', 'reposicao.raio_x_aberta',
                      'reposicao.raio_x_decisao', 'radar.ficha_aberta',
                      'banco.extrato_importado', 'banco.extrato_conferido',
                      'clientes.lista_aberta', 'clientes.modo_trocado', 'clientes.filtro_saude',
                      'clientes.busca_usada', 'clientes.cliente_aberto', 'clientes.pagina_carregada',
                      'clientes.ficha_acao',
                      'novo_pedido.iniciado', 'novo_pedido.cliente_escolhido', 'novo_pedido.primeiro_item',
                      'novo_pedido.envio_tentado', 'novo_pedido.envio_falhou', 'novo_pedido.envio_confirmado',
                      'novo_pedido.ia_analise_pedida', 'novo_pedido.ia_itens_adicionados', 'novo_pedido.ia_itens_descartados',
                      'novo_pedido.rascunho_restaurado', 'novo_pedido.rascunho_descartado') THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: evento % fora da allowlist', p_evento
      USING ERRCODE = '22023';
  END IF;

  IF pg_column_size(coalesce(p_props, '{}'::jsonb)) > 2048 THEN
    RAISE EXCEPTION 'analytics_ledger_registrar: props acima do teto'
      USING ERRCODE = '22023';
  END IF;

  -- Teto por titular/dia — guard contra flood por chave variada. Silencioso de
  -- propósito: telemetria nunca quebra a tela de quem está trabalhando.
  IF (
    SELECT count(*) FROM public.analytics_outbox
    WHERE user_id = v_uid AND ocorrido_em > now() - interval '1 day'
  ) >= 500 THEN
    RETURN;
  END IF;

  INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup)
  VALUES (
    p_evento,
    v_uid::text,                       -- casa com identify(userId) do front
    v_uid,
    coalesce(p_props, '{}'::jsonb),
    -- left() protege o teto do CHECK e do índice B-tree; o dia fecha a janela
    -- de dedup (mesmo estado revisto amanhã é sinal NOVO, não repetição).
    'ledger:' || v_uid::text || ':' || p_evento || ':' || left(coalesce(p_chave, ''), 100) || ':' || v_dia
  )
  ON CONFLICT (chave_dedup) DO NOTHING;
END;
$function$;

-- ⚠️ CLAUDE.md: revogar NOMEANDO as roles — FROM PUBLIC não tira anon. Reemitir é idempotente.
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.analytics_ledger_registrar(text, text, jsonb) TO authenticated;

DO $post$
DECLARE
  v_oid oid := to_regprocedure('public.analytics_ledger_registrar(text,text,jsonb)')::oid;
  v_def text;
  v_ev  text;
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) IS DISTINCT FROM 'b40dc0f99d2ca61d049593b67acc6d25' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: corpo vivo nao e o desta migration';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  FOREACH v_ev IN ARRAY ARRAY['carteira.mixgap_servido', 'navegacao.rota_servida',
                              'dashboard.crescimento_comparavel_servido', 'venda.ficha_aberta',
                              'venda.contato_registrado', 'venda.tel_clicado', 'venda.painel_aberto',
                              'financeiro.ciclo_aberto', 'reposicao.corantes_aberta', 'reposicao.raio_x_aberta',
                              'reposicao.raio_x_decisao', 'radar.ficha_aberta',
                              'banco.extrato_importado', 'banco.extrato_conferido',
                              'clientes.lista_aberta', 'clientes.modo_trocado', 'clientes.filtro_saude',
                              'clientes.busca_usada', 'clientes.cliente_aberto', 'clientes.pagina_carregada',
                              'clientes.ficha_acao',
                              'novo_pedido.iniciado', 'novo_pedido.cliente_escolhido', 'novo_pedido.primeiro_item',
                              'novo_pedido.envio_tentado', 'novo_pedido.envio_falhou', 'novo_pedido.envio_confirmado',
                              'novo_pedido.ia_analise_pedida', 'novo_pedido.ia_itens_adicionados', 'novo_pedido.ia_itens_descartados',
                              'novo_pedido.rascunho_restaurado', 'novo_pedido.rascunho_descartado'] LOOP
    IF position(v_ev in v_def) = 0 THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: allowlist sem %', v_ev;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: anon executa o ledger';
  END IF;
  IF has_function_privilege('public', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: PUBLIC executa o ledger';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: authenticated perdeu EXECUTE - o sensor ficaria mudo';
  END IF;
END
$post$;
