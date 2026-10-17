-- ============================================================
-- recebimento_associacao_sombra — proposta de associação NF↔PO em SOMBRA (nada é escrito no Omie)
-- Pedido do founder (2026-10-17): NF concluída → PO encerrado total (tudo faturado) ou parcial (falta item). A API do
-- Omie não encerra PO; o caminho é a associação nativa item NF ↔ item PO. Decisões 2026-10-16: sombra + piloto antes de
-- escrever, quantidade exata, órfã/duplicidade/item sem par → fila humana. Classificador: edge
-- omie-sync-nfes-recebidas/associacao.ts (versão em versao_classificador). 1 linha por NF (empresa, nid_receb).
-- 1 writer: a edge, via RPC SECURITY DEFINER com compare-and-set por observado_em (run atrasado não sobrescreve
-- evidência mais nova — parecer Codex 2026-10-16, achado 9). Leitura: staff. A linha é PROPOSTA auditável, não
-- autorização: a escrita futura reconsulta NF e POs.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.recebimento_associacao_sombra (
  empresa text NOT NULL CONSTRAINT recebimento_associacao_sombra_empresa_check CHECK (empresa IN ('OBEN', 'COLACOR')),
  nid_receb bigint NOT NULL CONSTRAINT recebimento_associacao_sombra_nid_check CHECK (nid_receb > 0),
  numero_nfe text,
  chave_nfe text,
  fornecedor_codigo_omie bigint,
  estado_nf text NOT NULL
    CONSTRAINT recebimento_associacao_sombra_estado_check CHECK (estado_nf IN ('pendente', 'concluida', 'cancelada', 'ilegivel')),
  vinculo text NOT NULL
    CONSTRAINT recebimento_associacao_sombra_vinculo_check CHECK (vinculo IN ('nenhum', 'parcial', 'completo')),
  classe text NOT NULL
    CONSTRAINT recebimento_associacao_sombra_classe_check
    CHECK (classe IN ('associavel', 'ambigua', 'orfa', 'ja_vinculada', 'fora_de_alcance')),
  motivos text[] NOT NULL,
  contratos text[] NOT NULL,
  pares jsonb NOT NULL,
  pedidos jsonb NOT NULL,
  versao_classificador text NOT NULL,
  observado_em timestamptz NOT NULL,
  primeira_observacao_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa, nid_receb),
  -- associável ⇔ sem motivo, NF pendente, sem vínculo, com par e pedido; o resto não carrega proposta.
  CONSTRAINT recebimento_associacao_sombra_proposta_check CHECK (
    jsonb_typeof(pares) = 'array' AND jsonb_typeof(pedidos) = 'array' AND
    CASE WHEN classe = 'associavel'
      THEN cardinality(motivos) = 0 AND estado_nf = 'pendente' AND vinculo = 'nenhum'
           AND jsonb_array_length(pares) > 0 AND jsonb_array_length(pedidos) > 0
      ELSE cardinality(motivos) > 0 AND jsonb_array_length(pares) = 0 AND jsonb_array_length(pedidos) = 0
    END
  )
);

CREATE INDEX IF NOT EXISTS idx_recebimento_associacao_sombra_classe
  ON public.recebimento_associacao_sombra (empresa, classe, observado_em DESC);

ALTER TABLE public.recebimento_associacao_sombra ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.recebimento_associacao_sombra FROM PUBLIC;
REVOKE ALL ON public.recebimento_associacao_sombra FROM anon;
REVOKE ALL ON public.recebimento_associacao_sombra FROM authenticated;
-- service_role tem BYPASSRLS e ALL pelo ACL default: sem este REVOKE escreveria por fora da RPC (1 writer).
REVOKE ALL ON public.recebimento_associacao_sombra FROM service_role;
GRANT SELECT ON public.recebimento_associacao_sombra TO authenticated, service_role;

DROP POLICY IF EXISTS "recebimento_associacao_sombra_select_staff" ON public.recebimento_associacao_sombra;
CREATE POLICY "recebimento_associacao_sombra_select_staff" ON public.recebimento_associacao_sombra FOR SELECT
  USING (public.has_role((SELECT auth.uid()), 'employee'::public.app_role)
      OR public.has_role((SELECT auth.uid()), 'master'::public.app_role));
-- Sem policy de INSERT/UPDATE/DELETE de propósito: sob RLS, ausência de policy é negação. Quem escreve é a RPC.

-- Publica a classificação de UMA NF. Devolve 'gravada' ou 'leitura_velha' (já há observação igual ou mais nova).
CREATE OR REPLACE FUNCTION public.recebimento_associacao_sombra_publicar(p jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $fn$
DECLARE
  v_n integer;
BEGIN
  -- IS DISTINCT FROM: campo AUSENTE dá jsonb_typeof NULL, e "NULL <> 'array'" não dispara (viraria array vazio).
  IF jsonb_typeof(p) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p->'observado_em') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p->'motivos') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'contratos') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p->'pares') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'pedidos') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'recebimento_associacao_sombra_publicar: payload inválido' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.recebimento_associacao_sombra AS s (
    empresa, nid_receb, numero_nfe, chave_nfe, fornecedor_codigo_omie, estado_nf, vinculo, classe,
    motivos, contratos, pares, pedidos, versao_classificador, observado_em
  ) VALUES (
    p->>'empresa', (p->>'nid_receb')::bigint, p->>'numero_nfe', p->>'chave_nfe',
    (p->>'fornecedor_codigo_omie')::bigint, p->>'estado_nf', p->>'vinculo', p->>'classe',
    ARRAY(SELECT jsonb_array_elements_text(p->'motivos')), ARRAY(SELECT jsonb_array_elements_text(p->'contratos')),
    p->'pares', p->'pedidos', p->>'versao_classificador', (p->>'observado_em')::timestamptz
  )
  ON CONFLICT (empresa, nid_receb) DO UPDATE SET
    numero_nfe = EXCLUDED.numero_nfe, chave_nfe = EXCLUDED.chave_nfe,
    fornecedor_codigo_omie = EXCLUDED.fornecedor_codigo_omie, estado_nf = EXCLUDED.estado_nf,
    vinculo = EXCLUDED.vinculo, classe = EXCLUDED.classe, motivos = EXCLUDED.motivos,
    contratos = EXCLUDED.contratos, pares = EXCLUDED.pares, pedidos = EXCLUDED.pedidos,
    versao_classificador = EXCLUDED.versao_classificador, observado_em = EXCLUDED.observado_em,
    atualizado_em = now()
  WHERE s.observado_em < EXCLUDED.observado_em;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN CASE WHEN v_n = 1 THEN 'gravada' ELSE 'leitura_velha' END;
END
$fn$;

REVOKE ALL ON FUNCTION public.recebimento_associacao_sombra_publicar(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recebimento_associacao_sombra_publicar(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.recebimento_associacao_sombra_publicar(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.recebimento_associacao_sombra_publicar(jsonb) TO service_role;

DO $post$
DECLARE
  v_tab regclass := to_regclass('public.recebimento_associacao_sombra');
  v_fn regprocedure := to_regprocedure('public.recebimento_associacao_sombra_publicar(jsonb)');
  v_priv text;
BEGIN
  IF v_tab IS NULL OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = v_tab) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: tabela ausente ou sem RLS (vazaria a sombra fora do staff)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = v_tab AND convalidated
                 AND conname = 'recebimento_associacao_sombra_proposta_check'
                 AND pg_get_constraintdef(oid) LIKE '%jsonb_array_length(pares) > 0%') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: CHECK da proposta ausente (associável sem par passaria)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_tab AND polcmd = 'r'
                 AND polname = 'recebimento_associacao_sombra_select_staff'
                 AND pg_get_expr(polqual, polrelid) LIKE '%employee%' AND pg_get_expr(polqual, polrelid) LIKE '%master%')
     OR (SELECT count(*) FROM pg_policy WHERE polrelid = v_tab) <> 1 THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: policy de leitura staff ausente ou policy a mais (leitura ou escrita fora do staff)';
  END IF;
  FOREACH v_priv IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', v_tab, v_priv) OR has_table_privilege('authenticated', v_tab, v_priv)
       OR has_table_privilege('service_role', v_tab, v_priv) THEN
      RAISE EXCEPTION 'POSTCONDICAO FALHOU: % na tabela fora da RPC (1 writer)', v_priv;
    END IF;
  END LOOP;
  IF has_table_privilege('anon', v_tab, 'SELECT') OR NOT has_table_privilege('authenticated', v_tab, 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: SELECT de anon aberto ou de authenticated fechado';
  END IF;
  IF v_fn IS NULL
     OR (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM true
     OR (SELECT 'search_path=public, pg_temp' = ANY (p.proconfig) FROM pg_proc p WHERE p.oid = v_fn) IS DISTINCT FROM true
     OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid = v_fn) NOT LIKE '%WHERE s.observado_em < EXCLUDED.observado_em%'
     OR (SELECT p.prosrc FROM pg_proc p WHERE p.oid = v_fn) NOT LIKE '%IS DISTINCT FROM ''array''%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: RPC ausente, sem SECURITY DEFINER, sem search_path fixo ou sem compare-and-set';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU: EXECUTE da RPC fora de service_role';
  END IF;
  RAISE NOTICE 'POSTCONDICAO OK: recebimento_associacao_sombra — RLS, CHECK da proposta, policy staff, ACL 1-writer e RPC com compare-and-set';
END
$post$;

COMMIT;
