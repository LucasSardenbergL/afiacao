-- Reposição — De-para de fornecedor Sayerlack AUTOMÁTICO (cold-start) — money-path
-- ============================================================================
-- Problema: o motor só enxerga SKU com de-para de fornecedor (sku_fornecedor_externo:
-- sku_omie -> sku_portal, o código que a automação digita no portal Renner Sayerlack).
-- Item novo/renomeado no Omie (ex.: FOA05.6717) nasce sem de-para -> invisível pra compra.
-- 214/215 cold-start OBEN compráveis estão assim. O de-para é EXTRAÍVEL da descrição Omie
-- pelo parser determinístico src/lib/reposicao/sayerlack-sku.ts (espelho em _shared), provado
-- contra os 189 mapeamentos manuais: 185 batem, 0 divergem (100%).
--
-- Esta migration cria a INFRA SQL que a edge reposicao-depara-sayerlack-auto usa:
--   1) v_reposicao_depara_sayerlack_elegivel — universo comprável SEM de-para, espelhando
--      TODOS os guards do motor gerar_pedidos_sugeridos_ciclo (Codex: não reinventar filtros).
--   2) reposicao_depara_auto_log — auditoria (parser version, descrição, código extraído, resultado).
--   3) reposicao_aplicar_depara_sayerlack_auto(jsonb,int,uuid) — escreve o de-para de forma
--      transacional e auditável (Codex preferiu RPC ao insert solto da edge). Gates money-path:
--      (a) insert-only (nunca sobrescreve mapa manual); (b) GATE DE COLISÃO DE DESTINO (sku_portal
--      já ativo p/ OUTRO sku_omie -> rejeita); (c) re-valida elegibilidade no momento da escrita;
--      (d) ON CONFLICT DO NOTHING; (e) gate service_role (só edge/cron, não usuário via PostgREST).
--   O gate de gabarito (validarGabarito = 0 divergências) e o filtro "só seguros (1 match)" vivem
--   na EDGE (parser TS) — esta camada SQL assume candidatos já filtrados e re-valida o resto.
--
-- A descrição do Omie É a fonte da verdade do código do portal: descrição errada -> de-para
-- errado (GIGO). O gate de colisão + a auditoria mitigam; não eliminam. Precisão > recall.
-- Idempotente / re-rodável. Provado em PG17 (db/test-reposicao-depara-auto.sh). Aplicar manual
-- via SQL Editor do Lovable (Lovable NÃO auto-aplica migration custom).
-- ============================================================================
BEGIN;

-- ─── 1) View de elegibilidade (objeto NOVO; espelha os guards do motor) ───
CREATE OR REPLACE VIEW public.v_reposicao_depara_sayerlack_elegivel
WITH (security_invoker = 'on') AS
SELECT
  'OBEN'::text AS empresa,
  op.omie_codigo_produto::text AS sku_omie,
  op.descricao AS sku_descricao,
  op.familia
FROM public.omie_products op
LEFT JOIN public.sku_status_omie sso
  ON sso.empresa = 'OBEN' AND sso.sku_codigo_omie = op.omie_codigo_produto::text
LEFT JOIN public.familia_nao_comprada fnc
  ON fnc.empresa = 'OBEN' AND fnc.familia = op.familia
WHERE op.account = 'oben'
  AND op.ativo = true
  AND COALESCE(op.tipo_produto, op.metadata->>'tipo_produto', '') <> '04'   -- não fabricado
  AND COALESCE(op.valor_unitario, 0) > 0                                     -- tem preço
  AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'                          -- fracionado: só venda
  AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
  AND fnc.id IS NULL                                                         -- família comprável
  AND COALESCE(sso.ativo_no_omie, true) = true                              -- ativo no Omie
  AND NOT EXISTS (                                                           -- SEM de-para Sayerlack ativo
    SELECT 1 FROM public.sku_fornecedor_externo fe
    WHERE fe.empresa = 'OBEN' AND fe.sku_omie = op.omie_codigo_produto::text
      AND fe.ativo = true AND fe.fornecedor_nome ILIKE '%SAYERLACK%'
  );

-- ─── 2) Tabela de auditoria (toda decisão da RPC fica rastreada) ───
CREATE TABLE IF NOT EXISTS public.reposicao_depara_auto_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid,
  criado_em timestamptz NOT NULL DEFAULT now(),
  empresa text NOT NULL DEFAULT 'OBEN',
  sku_omie text NOT NULL,
  sku_descricao text,
  sku_portal_extraido text,
  parser_version int,
  resultado text NOT NULL CHECK (resultado IN ('inserido','colisao_destino','ja_existe','nao_elegivel')),
  detalhe text
);
ALTER TABLE public.reposicao_depara_auto_log ENABLE ROW LEVEL SECURITY;
-- leitura: só quem vê carteira completa (gestor/master). Escrita: engines (service_role bypassa RLS).
DROP POLICY IF EXISTS depara_auto_log_sel ON public.reposicao_depara_auto_log;
CREATE POLICY depara_auto_log_sel ON public.reposicao_depara_auto_log FOR SELECT TO authenticated
  USING ((SELECT public.pode_ver_carteira_completa((SELECT auth.uid()))));

-- ─── 3) RPC de escrita transacional e auditável ───
CREATE OR REPLACE FUNCTION public.reposicao_aplicar_depara_sayerlack_auto(
  p_candidatos jsonb,
  p_parser_version int DEFAULT NULL,
  p_run_id uuid DEFAULT NULL
) RETURNS TABLE(inseridos int, colisao_destino int, ja_existe int, nao_elegivel int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ins int := 0; v_col int := 0; v_exi int := 0; v_nel int := 0;
  c record; v_res text; v_det text;
BEGIN
  -- Gate: só service_role (edge/cron). Usuário via PostgREST é barrado (42501).
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'acesso negado: reposicao_aplicar_depara_sayerlack_auto requer service_role'
      USING ERRCODE = '42501';
  END IF;

  FOR c IN
    SELECT * FROM jsonb_to_recordset(COALESCE(p_candidatos, '[]'::jsonb))
      AS x(sku_omie text, sku_portal text, unidade_portal text, sku_descricao text)
  LOOP
    v_det := NULL;
    -- candidato inválido (sem sku_omie/sku_portal) -> não-elegível, auditado
    IF c.sku_omie IS NULL OR btrim(c.sku_omie) = '' OR c.sku_portal IS NULL OR btrim(c.sku_portal) = '' THEN
      v_res := 'nao_elegivel'; v_nel := v_nel + 1; v_det := 'candidato sem sku_omie/sku_portal';
    -- (1) já existe (ativo OU inativo) p/ o SKU -> nunca sobrescreve (mapa manual / inativo intencional)
    ELSIF EXISTS (
        SELECT 1 FROM public.sku_fornecedor_externo fe
        WHERE fe.empresa = 'OBEN' AND fe.fornecedor_nome ILIKE '%SAYERLACK%' AND fe.sku_omie = c.sku_omie
      ) THEN
      v_res := 'ja_existe'; v_exi := v_exi + 1;
    -- (2) COLISÃO DE DESTINO: o sku_portal já está ativo p/ OUTRO sku_omie (Codex P2)
    ELSIF EXISTS (
        SELECT 1 FROM public.sku_fornecedor_externo fe
        WHERE fe.empresa = 'OBEN' AND fe.fornecedor_nome ILIKE '%SAYERLACK%'
          AND fe.ativo = true
          AND upper(btrim(fe.sku_portal)) = upper(btrim(c.sku_portal))
          AND fe.sku_omie <> c.sku_omie
      ) THEN
      v_res := 'colisao_destino'; v_col := v_col + 1; v_det := 'sku_portal já mapeado p/ outro SKU';
    -- (3) re-valida elegibilidade no momento da escrita (defesa: catálogo pode ter mudado)
    ELSIF NOT EXISTS (
        SELECT 1 FROM public.v_reposicao_depara_sayerlack_elegivel e WHERE e.sku_omie = c.sku_omie
      ) THEN
      v_res := 'nao_elegivel'; v_nel := v_nel + 1; v_det := 'fora da view de elegibilidade';
    -- (4) insere
    ELSE
      INSERT INTO public.sku_fornecedor_externo
        (empresa, fornecedor_nome, sku_omie, sku_portal, unidade_portal, fator_conversao, ativo, observacoes)
      VALUES
        ('OBEN', 'RENNER SAYERLACK S/A', c.sku_omie, c.sku_portal,
         COALESCE(NULLIF(c.unidade_portal, ''), 'UN'), 1, true,
         'extraído automaticamente (parser v' || COALESCE(p_parser_version::text, '?') || ', cold-start)')
      ON CONFLICT (empresa, fornecedor_nome, sku_omie) DO NOTHING;
      IF FOUND THEN
        v_res := 'inserido'; v_ins := v_ins + 1;
      ELSE
        v_res := 'ja_existe'; v_exi := v_exi + 1;   -- corrida com outro writer
      END IF;
    END IF;

    INSERT INTO public.reposicao_depara_auto_log
      (run_id, empresa, sku_omie, sku_descricao, sku_portal_extraido, parser_version, resultado, detalhe)
    VALUES
      (p_run_id, 'OBEN', c.sku_omie, c.sku_descricao, c.sku_portal, p_parser_version, v_res, v_det);
  END LOOP;

  RETURN QUERY SELECT v_ins, v_col, v_exi, v_nel;
END $$;

REVOKE ALL ON FUNCTION public.reposicao_aplicar_depara_sayerlack_auto(jsonb, int, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_aplicar_depara_sayerlack_auto(jsonb, int, uuid)
  TO service_role;

COMMIT;

-- ── Validação pós-apply (read-only; cola no SQL Editor depois do Run) ──
SELECT 'DEPARA AUTO OK' AS status,
  (SELECT count(*) FROM pg_views  WHERE viewname = 'v_reposicao_depara_sayerlack_elegivel') AS view_ok,
  (SELECT count(*) FROM pg_tables WHERE tablename = 'reposicao_depara_auto_log') AS audit_ok,
  (SELECT count(*) FROM pg_proc   WHERE proname  = 'reposicao_aplicar_depara_sayerlack_auto') AS rpc_ok;
