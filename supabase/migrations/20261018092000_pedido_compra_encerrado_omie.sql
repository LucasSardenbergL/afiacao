-- ============================================================
-- purchase_orders_tracking.encerrado_omie_em — pedido de compra ENCERRADO no Omie (money-path, R59)
--
-- Por quê: o encerramento NÃO aparece no cabeçalho do PesquisarPedCompra (1014/1049/1032, encerrados
-- pelo founder, vêm com cEtapa="15"; até o webhook CompraProduto.Encerrada traz "15"). O único sinal
-- é o filtro lExibirPedidosEncerrados: a edge omie-sync-pedidos-compra faz uma passada SÓ de
-- encerrados depois do completo limpo e a registra aqui. O backtest do orçamento de compra (R59) tira
-- do caixa o disparado encerrado e sem NF.
--
-- Coluna DEDICADA, 1 writer: `status` já tem 2 escritores (este sync pelo cEtapa e o
-- omie-sync-nfes-recebidas com FATURADO/RECEBIDO) e sinal money-path nunca mora em coluna
-- multi-writer. O único writer é reposicao_registrar_encerrados_omie (service_role-only).
--
-- Desenho (Codex challenge 2026-10-18, 6×P1):
--  • HABILITAÇÃO: que o filtro sozinho devolve só encerrados é hipótese. Toda passada é registrada em
--    reposicao_encerrados_omie_publicacao (ids, janela, seq); enquanto `habilitado=false` ela só é
--    OBSERVADA — a coluna não muda. Os controles (positivo: encerrados conhecidos no conjunto;
--    negativo: pedido aberto fora dele) são conferidos no conjunto observado, e só então alguém liga
--    `habilitado`. O controle negativo IMPEDE a publicação, não só a denuncia.
--  • FENCING: p_seq vem de reposicao_alocar_run_seq IMEDIATAMENTE antes da coleta; publicação com seq
--    ≤ a já aceita é OBSOLETA e não toca nada (uma coleta lenta não ressuscita encerramento já limpo).
--  • COLUNA = CONJUNTO ATUAL: publicado, marca o que está no conjunto (1ª vez vista) e limpa TODO o resto
--    da empresa — inclusive marca sem cobertura (previsão nula, fora da janela). Errar a limpeza devolve
--    o pedido ao caixa, o lado conservador; manter marca não confirmada não.
--  • ATÔMICO: conjunto, marcas e o registro da publicação no MESMO commit — o backtest lê o registro.
--  • TENTATIVA (Codex 2ª rodada): toda passada abre o registro em 'coletando' (fenced) e termina em
--    'publicado'/'observado' ou 'invalidado' — uma passada que falha, se abstém ou morre no meio deixa o
--    registro fora de 'publicado', e o backtest recusa: publicação de ontem não vale depois de tentativa ruim.
--  • O backtest consome `ids` desta tabela (sem escrita para clientes) ∩ a coluna — escrita manual de staff
--    na coluna (a policy do tracking permite) não basta para tirar pedido do caixa.
-- encerrado_omie_em = quando a passada o viu encerrado pela 1ª vez (o Omie não expõe a data real).
-- ============================================================
BEGIN;

ALTER TABLE public.purchase_orders_tracking
  ADD COLUMN IF NOT EXISTS encerrado_omie_em timestamptz;

COMMENT ON COLUMN public.purchase_orders_tracking.encerrado_omie_em IS
  'Pedido no conjunto da última passada PUBLICADA de encerrados do Omie (lExibirPedidosEncerrados) — 1ª vez visto, não a data real do encerramento. 1 writer: reposicao_registrar_encerrados_omie.';

CREATE TABLE IF NOT EXISTS public.reposicao_encerrados_omie_publicacao (
  empresa public.empresa_reposicao PRIMARY KEY,
  seq bigint NOT NULL,
  coletado_em timestamptz NOT NULL,
  ids bigint[] NOT NULL,
  janela_de date,
  janela_ate date,
  status text NOT NULL CHECK (status IN ('coletando', 'observado', 'publicado', 'invalidado')),
  motivo text,
  tentativa_em timestamptz,
  novos integer,
  limpos integer,
  publicado_em timestamptz,
  -- ligado À MÃO depois dos controles do conjunto observado; a RPC nunca o escreve
  habilitado boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.reposicao_encerrados_omie_publicacao IS
  'Última tentativa de passada de encerrados do Omie por empresa (escrita só pelas RPCs reposicao_tentativa_/reposicao_registrar_encerrados_omie; habilitado é ligado à mão após os controles). O backtest R59 exige status=publicado, habilitado e recente, e consome ids daqui.';

ALTER TABLE public.reposicao_encerrados_omie_publicacao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reposicao_encerrados_omie_publicacao_select_staff" ON public.reposicao_encerrados_omie_publicacao;
CREATE POLICY "reposicao_encerrados_omie_publicacao_select_staff"
  ON public.reposicao_encerrados_omie_publicacao
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('employee'::public.app_role, 'master'::public.app_role)
    )
  );

DROP POLICY IF EXISTS "reposicao_encerrados_omie_publicacao_service_all" ON public.reposicao_encerrados_omie_publicacao;
CREATE POLICY "reposicao_encerrados_omie_publicacao_service_all"
  ON public.reposicao_encerrados_omie_publicacao
  FOR ALL
  USING (auth.role() = 'service_role');

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.reposicao_encerrados_omie_publicacao FROM PUBLIC, anon, authenticated;

-- Objeto NOVO, definido só aqui (conferido no pré-voo): DROP+CREATE deixa a re-colagem idempotente.
DROP FUNCTION IF EXISTS public.reposicao_registrar_encerrados_omie(public.empresa_reposicao, bigint, bigint[], date, date);
CREATE FUNCTION public.reposicao_registrar_encerrados_omie(
  p_empresa public.empresa_reposicao,
  p_seq bigint,
  p_ids bigint[],
  p_janela_de date,
  p_janela_ate date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_atual public.reposicao_encerrados_omie_publicacao%ROWTYPE;
  v_habilitado boolean;
  v_ausentes int;
  v_novos int;
  v_limpos int;
BEGIN
  IF p_empresa IS NULL OR p_seq IS NULL OR p_seq <= 0 OR p_ids IS NULL OR p_janela_de IS NULL
     OR p_janela_ate IS NULL OR p_janela_de > p_janela_ate THEN
    RAISE EXCEPTION 'reposicao_registrar_encerrados_omie: argumento ausente ou janela invertida'
      USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_ids) AS x(id) WHERE x.id IS NULL OR x.id <= 0) THEN
    RAISE EXCEPTION 'reposicao_registrar_encerrados_omie: nCodPed nulo ou não positivo no conjunto'
      USING ERRCODE = '22023';
  END IF;

  -- 1 publicação por empresa por vez; a ordem entre elas é o seq (fencing), não a chegada
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_registrar_encerrados_omie:' || p_empresa::text));

  SELECT * INTO v_atual FROM public.reposicao_encerrados_omie_publicacao WHERE empresa = p_empresa;
  -- obsoleta: seq menor que o aceito, ou o MESMO seq já encerrado (só a tentativa 'coletando' dele fecha)
  IF FOUND AND (p_seq < v_atual.seq OR (p_seq = v_atual.seq AND v_atual.status <> 'coletando')) THEN
    RETURN jsonb_build_object('status', 'obsoleto', 'seq_aceito', v_atual.seq);
  END IF;

  -- Todo encerrado precisa existir no espelho (o completo do MESMO run o upsertou antes). Ausente =
  -- upsert falhou ou a janela divergiu → aborta tudo.
  SELECT count(*) INTO v_ausentes
  FROM (SELECT DISTINCT x.id FROM unnest(p_ids) AS x(id)) i
  WHERE NOT EXISTS (
    SELECT 1 FROM public.purchase_orders_tracking t
    WHERE t.empresa = p_empresa AND t.omie_codigo_pedido = i.id
  );
  IF v_ausentes > 0 THEN
    RAISE EXCEPTION 'reposicao_registrar_encerrados_omie: % encerrado(s) fora do espelho — passada recusada', v_ausentes
      USING ERRCODE = 'P0002';
  END IF;

  v_habilitado := coalesce(v_atual.habilitado, false);

  IF v_habilitado THEN
    UPDATE public.purchase_orders_tracking t
       SET encerrado_omie_em = now()
     WHERE t.empresa = p_empresa
       AND t.omie_codigo_pedido = ANY (p_ids)
       AND t.encerrado_omie_em IS NULL;
    GET DIAGNOSTICS v_novos = ROW_COUNT;

    -- a coluna é o conjunto ATUAL: tudo o que não está nele volta a NULL (conservador)
    UPDATE public.purchase_orders_tracking t
       SET encerrado_omie_em = NULL
     WHERE t.empresa = p_empresa
       AND t.encerrado_omie_em IS NOT NULL
       AND NOT (t.omie_codigo_pedido = ANY (p_ids));
    GET DIAGNOSTICS v_limpos = ROW_COUNT;
  END IF;

  INSERT INTO public.reposicao_encerrados_omie_publicacao AS p
    (empresa, seq, coletado_em, ids, janela_de, janela_ate, status, novos, limpos, publicado_em, motivo)
  VALUES
    (p_empresa, p_seq, now(), (SELECT coalesce(array_agg(DISTINCT x ORDER BY x), '{}') FROM unnest(p_ids) x),
     p_janela_de, p_janela_ate,
     CASE WHEN v_habilitado THEN 'publicado' ELSE 'observado' END,
     v_novos, v_limpos, CASE WHEN v_habilitado THEN now() END, NULL)
  ON CONFLICT (empresa) DO UPDATE SET
    seq = EXCLUDED.seq, coletado_em = EXCLUDED.coletado_em, ids = EXCLUDED.ids,
    janela_de = EXCLUDED.janela_de, janela_ate = EXCLUDED.janela_ate, status = EXCLUDED.status,
    novos = EXCLUDED.novos, limpos = EXCLUDED.limpos, publicado_em = EXCLUDED.publicado_em, motivo = NULL;
    -- habilitado NÃO entra no SET: só a mão o liga ou desliga

  RETURN jsonb_build_object(
    'status', CASE WHEN v_habilitado THEN 'publicado' ELSE 'observado' END,
    'novos', v_novos, 'limpos', v_limpos);
END;
$$;

COMMENT ON FUNCTION public.reposicao_registrar_encerrados_omie(public.empresa_reposicao, bigint, bigint[], date, date) IS
  'Único writer de purchase_orders_tracking.encerrado_omie_em e de reposicao_encerrados_omie_publicacao (exceto habilitado). Fencing por seq; só publica com habilitado=true. service_role-only.';

-- Abre ('coletando', antes da 1ª página) e fecha em falha ('invalidado') a tentativa. Fenced como a de cima:
-- 'coletando' exige seq NOVO; 'invalidado' exige o seq da própria tentativa (≥ aceito) — ou seq NULL, quando
-- nem o token saiu, e então invalida sem condição (o lado conservador: o backtest recusa até a próxima boa).
-- Não mexe na coluna nem nos ids: o que deixa de valer é o STATUS, que o backtest exige 'publicado'.
DROP FUNCTION IF EXISTS public.reposicao_tentativa_encerrados_omie(public.empresa_reposicao, bigint, text, text);
CREATE FUNCTION public.reposicao_tentativa_encerrados_omie(
  p_empresa public.empresa_reposicao,
  p_seq bigint,
  p_status text,
  p_motivo text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_atual public.reposicao_encerrados_omie_publicacao%ROWTYPE;
BEGIN
  IF p_empresa IS NULL OR p_status IS NULL OR p_status NOT IN ('coletando', 'invalidado')
     OR (p_status = 'coletando' AND p_seq IS NULL) OR (p_seq IS NOT NULL AND p_seq <= 0) THEN
    RAISE EXCEPTION 'reposicao_tentativa_encerrados_omie: argumento ausente ou inválido' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('reposicao_registrar_encerrados_omie:' || p_empresa::text));
  SELECT * INTO v_atual FROM public.reposicao_encerrados_omie_publicacao WHERE empresa = p_empresa;

  IF NOT FOUND THEN
    INSERT INTO public.reposicao_encerrados_omie_publicacao (empresa, seq, coletado_em, ids, status, motivo, tentativa_em)
    VALUES (p_empresa, coalesce(p_seq, 0), now(), '{}', p_status, left(p_motivo, 300), now());
    RETURN jsonb_build_object('status', p_status);
  END IF;

  IF p_seq IS NOT NULL AND (p_seq < v_atual.seq OR (p_status = 'coletando' AND p_seq = v_atual.seq)) THEN
    RETURN jsonb_build_object('status', 'obsoleto', 'seq_aceito', v_atual.seq);
  END IF;

  UPDATE public.reposicao_encerrados_omie_publicacao
     SET seq = coalesce(p_seq, seq), status = p_status, motivo = left(p_motivo, 300), tentativa_em = now()
   WHERE empresa = p_empresa;
  RETURN jsonb_build_object('status', p_status);
END;
$$;

REVOKE ALL ON FUNCTION public.reposicao_tentativa_encerrados_omie(public.empresa_reposicao, bigint, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_tentativa_encerrados_omie(public.empresa_reposicao, bigint, text, text)
  TO service_role;

-- DROP+CREATE reseta o ACL: REVOKE nomeando as roles (PUBLIC E anon E authenticated)
REVOKE ALL ON FUNCTION public.reposicao_registrar_encerrados_omie(public.empresa_reposicao, bigint, bigint[], date, date)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_registrar_encerrados_omie(public.empresa_reposicao, bigint, bigint[], date, date)
  TO service_role;

DO $post$
DECLARE
  fn constant text := 'public.reposicao_registrar_encerrados_omie(public.empresa_reposicao,bigint,bigint[],date,date)';
  fn2 constant text := 'public.reposicao_tentativa_encerrados_omie(public.empresa_reposicao,bigint,text,text)';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'purchase_orders_tracking'
      AND column_name = 'encerrado_omie_em' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: purchase_orders_tracking.encerrado_omie_em ausente ou com tipo errado — a edge não tem onde publicar';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'reposicao_encerrados_omie_publicacao' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'A2 FALHOU: reposicao_encerrados_omie_publicacao ausente ou sem RLS';
  END IF;
  IF has_table_privilege('authenticated', 'public.reposicao_encerrados_omie_publicacao', 'UPDATE')
     OR has_table_privilege('anon', 'public.reposicao_encerrados_omie_publicacao', 'UPDATE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon/authenticated com UPDATE na publicação — um cliente ligaria habilitado';
  END IF;
  IF to_regprocedure(fn) IS NULL THEN
    RAISE EXCEPTION 'A4 FALHOU: reposicao_registrar_encerrados_omie ausente — a passada de encerrados falha a cada run';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(fn)) THEN
    RAISE EXCEPTION 'A5 FALHOU: a função virou SECURITY DEFINER — deve ser INVOKER';
  END IF;
  IF has_function_privilege('anon', fn, 'EXECUTE') OR has_function_privilege('authenticated', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'A6 FALHOU: anon/authenticated executam a função — qualquer cliente marcaria pedido como encerrado';
  END IF;
  IF NOT has_function_privilege('service_role', fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'A7 FALHOU: service_role sem EXECUTE — a edge não consegue registrar';
  END IF;
  IF to_regprocedure(fn2) IS NULL OR (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(fn2))
     OR has_function_privilege('anon', fn2, 'EXECUTE') OR has_function_privilege('authenticated', fn2, 'EXECUTE')
     OR NOT has_function_privilege('service_role', fn2, 'EXECUTE') THEN
    RAISE EXCEPTION 'A8 FALHOU: reposicao_tentativa_encerrados_omie ausente, DEFINER ou com ACL errado';
  END IF;
  RAISE NOTICE 'encerrado_omie_em + publicação (RLS) + reposicao_registrar_encerrados_omie ok (INVOKER, service_role-only)';
END
$post$;

COMMIT;
