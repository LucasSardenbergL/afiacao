-- Reposição — o omie-sync-estoque registra, POR EXECUÇÃO, os POs que leu no PesquisarPedCompra do "a caminho" e
-- quanto cada item CONTRIBUIU para o estoque_pendente_entrada (spec 2026-09-26-baixa-pedido-compra-nf-concluida
-- §15 item 2; Codex §16 achado 3). 1 writer: a edge omie-sync-estoque, via RPC SECURITY DEFINER. Leitura: staff.
-- A ausência de um PO aqui NUNCA significa "fechado no Omie" por si só: só vale dentro da janela de um run com
-- varredura_completa = true (quem lê decide; o classificador trata o resto como "desconhecido").
-- Um PO entra UMA vez por run: a 1ª aparição na varredura vence (a edge garante; a PK cobra). PO lido SEM itens
-- entra com 1 linha de presença (seq_item 0, campos do item NULL, contribuição 0): ausência de linha = PO não
-- devolvido pela pesquisa. `pendente_aplicado` é conferido pela RPC NO BANCO, na mesma transação: o pendente
-- gravado de cada SKU habilitado tem de ser a soma do que a observação diz que contou (Codex, adversarial do PR0).
-- Prova: PG17 em db/test-reposicao-po-observado.sh. Aplicação MANUAL (o Lovable não aplica nome custom).
BEGIN;

CREATE TABLE IF NOT EXISTS public.reposicao_po_observado_run (
  run_id uuid PRIMARY KEY,
  empresa text NOT NULL CHECK (empresa IN ('OBEN', 'COLACOR')),
  iniciado_em timestamptz NOT NULL,
  concluido_em timestamptz NOT NULL,
  janela_de date NOT NULL,
  janela_ate date NOT NULL,
  filtros jsonb NOT NULL,
  varredura_completa boolean NOT NULL,
  pendente_aplicado boolean NOT NULL,
  skus_divergentes integer NOT NULL CHECK (skus_divergentes >= 0),
  pedidos_lidos integer NOT NULL CHECK (pedidos_lidos >= 0),
  versao_edge text NOT NULL,
  gravado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (concluido_em >= iniciado_em),
  CHECK (janela_ate >= janela_de)
);
CREATE INDEX IF NOT EXISTS idx_reposicao_po_observado_run_empresa
  ON public.reposicao_po_observado_run (empresa, concluido_em DESC);

CREATE TABLE IF NOT EXISTS public.reposicao_po_observado_item (
  run_id uuid NOT NULL REFERENCES public.reposicao_po_observado_run (run_id) ON DELETE CASCADE,
  omie_codigo_pedido bigint NOT NULL,
  seq_item integer NOT NULL CHECK (seq_item >= 0),
  numero_pedido text,
  etapa text,
  id_item bigint,
  sku_codigo_omie bigint,
  quantidade numeric,
  quantidade_recebida numeric,
  contribuicao numeric NOT NULL CHECK (contribuicao >= 0),
  exclusao text,
  CONSTRAINT reposicao_po_observado_item_exclusao_conhecida
    CHECK (exclusao IN ('dedup_app', 'etapa_nao_aberta', 'repetido_na_varredura', 'item_sem_sku',
                        'sku_nao_habilitado', 'quantidade_invalida')),
  -- O que não contou não contribui: o invariante "soma das contribuições = pendente" depende disto.
  CONSTRAINT reposicao_po_observado_item_excluido_nao_contribui
    CHECK (exclusao IS NULL OR contribuicao = 0),
  -- O que contou tem dono: contribuição sem SKU ou sem as quantidades seria unidade órfã na medição por SKU.
  CONSTRAINT reposicao_po_observado_item_contado_tem_sku
    CHECK (exclusao IS NOT NULL
           OR (sku_codigo_omie IS NOT NULL AND quantidade IS NOT NULL AND quantidade_recebida IS NOT NULL)),
  PRIMARY KEY (run_id, omie_codigo_pedido, seq_item)
);
CREATE INDEX IF NOT EXISTS idx_reposicao_po_observado_item_po
  ON public.reposicao_po_observado_item (omie_codigo_pedido, run_id);

COMMENT ON TABLE public.reposicao_po_observado_run IS
  'Uma linha por execução do omie-sync-estoque (OBEN): janela, filtros e se a varredura/pendente valeram (pendente_aplicado e skus_divergentes conferidos no banco pela RPC). Writer único: reposicao_po_observado_publicar.';
COMMENT ON TABLE public.reposicao_po_observado_item IS
  'Itens dos POs lidos no conjunto aberto do Omie e o que cada um contribuiu ao estoque_pendente_entrada (0 + exclusao quando não contou). PO sem itens: 1 linha de presença (seq_item 0, campos do item NULL).';

ALTER TABLE public.reposicao_po_observado_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reposicao_po_observado_item ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.reposicao_po_observado_run FROM PUBLIC;
REVOKE ALL ON public.reposicao_po_observado_run FROM anon;
REVOKE ALL ON public.reposicao_po_observado_run FROM authenticated;
REVOKE ALL ON public.reposicao_po_observado_item FROM PUBLIC;
REVOKE ALL ON public.reposicao_po_observado_item FROM anon;
REVOKE ALL ON public.reposicao_po_observado_item FROM authenticated;
-- service_role tem BYPASSRLS e ALL pelo ACL default: sem este REVOKE escreveria por fora da RPC (1 writer).
REVOKE ALL ON public.reposicao_po_observado_run FROM service_role;
REVOKE ALL ON public.reposicao_po_observado_item FROM service_role;
GRANT SELECT ON public.reposicao_po_observado_run TO authenticated, service_role;
GRANT SELECT ON public.reposicao_po_observado_item TO authenticated, service_role;

DROP POLICY IF EXISTS "reposicao_po_observado_run_select_staff" ON public.reposicao_po_observado_run;
CREATE POLICY "reposicao_po_observado_run_select_staff" ON public.reposicao_po_observado_run FOR SELECT
  USING (public.has_role((SELECT auth.uid()), 'employee'::public.app_role)
      OR public.has_role((SELECT auth.uid()), 'master'::public.app_role));
DROP POLICY IF EXISTS "reposicao_po_observado_item_select_staff" ON public.reposicao_po_observado_item;
CREATE POLICY "reposicao_po_observado_item_select_staff" ON public.reposicao_po_observado_item FOR SELECT
  USING (public.has_role((SELECT auth.uid()), 'employee'::public.app_role)
      OR public.has_role((SELECT auth.uid()), 'master'::public.app_role));
-- Sem policy de INSERT/UPDATE/DELETE de propósito: sob RLS, ausência de policy é negação. Quem escreve é a RPC.

CREATE OR REPLACE FUNCTION public.reposicao_po_observado_publicar(p_run jsonb, p_itens jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_run_id uuid := (p_run->>'run_id')::uuid;
  v_n integer;
  v_divergentes integer;
BEGIN
  IF v_run_id IS NULL THEN
    RAISE EXCEPTION 'reposicao_po_observado_publicar: run_id ausente' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_itens) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'reposicao_po_observado_publicar: p_itens não é array' USING ERRCODE = '22023';
  END IF;

  -- A 2ª testemunha do invariante, no BANCO e na mesma transação: para cada SKU habilitado da empresa, o pendente
  -- GRAVADO tem de ser a soma do que esta observação diz que contou. Run concorrente, upsert parcial ou SKU fora do
  -- ListarPosEstoque fazem a observação não valer como "pendente aplicado" — sem tocar no pendente.
  SELECT count(*) INTO v_divergentes
  FROM public.sku_parametros sp
  LEFT JOIN public.sku_estoque_atual e ON e.empresa = sp.empresa AND e.sku_codigo_omie = sp.sku_codigo_omie::text
  LEFT JOIN (SELECT (i->>'sku_codigo_omie')::bigint AS sku, sum((i->>'contribuicao')::numeric) AS contribuicao
               FROM jsonb_array_elements(p_itens) AS i
              WHERE i->>'exclusao' IS NULL
              GROUP BY 1) s ON s.sku = sp.sku_codigo_omie
  WHERE sp.empresa = p_run->>'empresa' AND sp.habilitado_reposicao_automatica
    AND (e.estoque_pendente_entrada IS NULL OR abs(coalesce(s.contribuicao, 0) - e.estoque_pendente_entrada) > 0.001);

  INSERT INTO public.reposicao_po_observado_run
    (run_id, empresa, iniciado_em, concluido_em, janela_de, janela_ate, filtros, varredura_completa,
     pendente_aplicado, skus_divergentes, pedidos_lidos, versao_edge)
  VALUES
    (v_run_id, p_run->>'empresa', (p_run->>'iniciado_em')::timestamptz, (p_run->>'concluido_em')::timestamptz,
     (p_run->>'janela_de')::date, (p_run->>'janela_ate')::date, p_run->'filtros',
     (p_run->>'varredura_completa')::boolean,
     coalesce((p_run->>'pendente_aplicado')::boolean, false) AND v_divergentes = 0,
     v_divergentes, (p_run->>'pedidos_lidos')::integer, p_run->>'versao_edge');

  INSERT INTO public.reposicao_po_observado_item
    (run_id, omie_codigo_pedido, seq_item, numero_pedido, etapa, id_item, sku_codigo_omie, quantidade,
     quantidade_recebida, contribuicao, exclusao)
  SELECT v_run_id, (i->>'omie_codigo_pedido')::bigint, (i->>'seq_item')::integer, i->>'numero_pedido', i->>'etapa',
         (i->>'id_item')::bigint, (i->>'sku_codigo_omie')::bigint, (i->>'quantidade')::numeric,
         (i->>'quantidade_recebida')::numeric, (i->>'contribuicao')::numeric, i->>'exclusao'
  FROM jsonb_array_elements(p_itens) AS i;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  -- Retenção no MESMO writer: 14 dias bastam para as leituras de antes/depois por lote (spec §16, achado 9).
  DELETE FROM public.reposicao_po_observado_run
   WHERE empresa = p_run->>'empresa' AND concluido_em < now() - interval '14 days';

  RETURN v_n;
END
$fn$;

REVOKE ALL ON FUNCTION public.reposicao_po_observado_publicar(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_po_observado_publicar(jsonb, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.reposicao_po_observado_publicar(jsonb, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_po_observado_publicar(jsonb, jsonb) TO service_role;

-- Postcondição: aborta a transação inteira se algo não pegou. Os md5 são do CORPO da RPC, das definições dos CHECKs
-- e das policies DESTE arquivo (calculados num PG17 com a migration) — uma transcrição que mude 1 byte (aplicação
-- pelo MCP/SQL Editor), um CHECK trocado por CHECK (true) ou uma policy aberta abortam tudo em vez de terminar
-- em silêncio. Comparações com `IS DISTINCT FROM true`: NULL (proconfig ausente) nunca passa por omissão.
DO $post$
DECLARE
  v_tab text;
  v_priv text;
  v_fn regprocedure := to_regprocedure('public.reposicao_po_observado_publicar(jsonb,jsonb)');
BEGIN
  -- deparse estável dos CHECKs/policies, qualquer que seja o search_path da sessão que aplica (vale até o COMMIT)
  PERFORM set_config('search_path', 'public, pg_temp', true);
  IF (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
         AND c.relname IN ('reposicao_po_observado_run', 'reposicao_po_observado_item')) <> 2 THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: tabelas de observação ausentes ou sem RLS';
  END IF;
  IF (SELECT md5(string_agg(c.relname || '.' || k.conname || '=' || pg_get_constraintdef(k.oid), ';'
                            ORDER BY c.relname COLLATE "C", k.conname COLLATE "C"))
        FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
       WHERE k.conrelid IN ('public.reposicao_po_observado_run'::regclass, 'public.reposicao_po_observado_item'::regclass)
         AND k.contype = 'c' AND k.convalidated) IS DISTINCT FROM 'd96b3af5ad32cab4a588029faa390246' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: definicao dos CHECKs difere do arquivo (CHECK trocado, renomeado, NOT VALID ou tabela de outra forma)';
  END IF;
  IF (SELECT md5(string_agg(c.relname || '.' || p.polname || '|' || p.polcmd::text || '|' || p.polpermissive::text || '|'
                            || p.polroles::text || '|' || coalesce(pg_get_expr(p.polqual, p.polrelid), '-') || '|'
                            || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-'), ';'
                            ORDER BY c.relname COLLATE "C", p.polname COLLATE "C"))
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE p.polrelid IN ('public.reposicao_po_observado_run'::regclass, 'public.reposicao_po_observado_item'::regclass))
     IS DISTINCT FROM '7c26732332bf0eed21921bf88944e4b9' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: policies de leitura diferem do arquivo (USING trocado ou policy extra)';
  END IF;
  FOREACH v_tab IN ARRAY ARRAY['public.reposicao_po_observado_run', 'public.reposicao_po_observado_item'] LOOP
    FOREACH v_priv IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'] LOOP
      IF has_table_privilege('anon', v_tab, v_priv) THEN
        RAISE EXCEPTION 'POSTCONDICAO FALHOU: anon tem % em % (REVOKE por nome não pegou)', v_priv, v_tab;
      END IF;
      IF v_priv <> 'SELECT' AND has_table_privilege('authenticated', v_tab, v_priv) THEN
        RAISE EXCEPTION 'POSTCONDICAO FALHOU: authenticated tem % em % (só a RPC escreve)', v_priv, v_tab;
      END IF;
      IF v_priv <> 'SELECT' AND has_table_privilege('service_role', v_tab, v_priv) THEN
        RAISE EXCEPTION 'POSTCONDICAO FALHOU: service_role tem % em % (só a RPC escreve)', v_priv, v_tab;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('authenticated', v_tab, 'SELECT') THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: authenticated sem SELECT em % (o staff não leria)', v_tab;
    END IF;
  END LOOP;
  IF v_fn IS NULL
     OR (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM true
     OR (SELECT 'search_path=public, pg_temp' = ANY (p.proconfig) FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: RPC de publicação ausente, sem SECURITY DEFINER ou sem search_path fixo';
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM '1b7f4f2f24e8ea684bf248c1b2bbd2f4' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: corpo da RPC difere do arquivo da migration (transcrição?)';
  END IF;
  IF has_function_privilege('public', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: EXECUTE da RPC fora de service_role (PUBLIC/anon/authenticated abertos)';
  END IF;
  RAISE NOTICE 'POSTCONDICAO OK: reposicao_po_observado — RLS, policies, CHECKs e ACL conferidos; RPC 1-writer com o corpo do arquivo';
END
$post$;

COMMIT;
