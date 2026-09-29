-- ============================================================
-- v_reposicao_sku_fora_do_motor — pelo `db:aplicar` (SEM envelope de transação)
-- Espelha: supabase/migrations/20260929003006_reposicao_v_sku_fora_do_motor.sql
-- Corpo idêntico ao da migration a partir do CREATE, sem BEGIN/COMMIT: o db:aplicar provê a
-- transação e roda o corpo via EXECUTE, onde comando de transação é proibido. O porquê da view e
-- do recorte está no cabeçalho da migration.
-- ============================================================

CREATE OR REPLACE VIEW public.v_reposicao_sku_fora_do_motor
WITH (security_invoker = on) AS
SELECT
  sp.empresa,
  sp.sku_codigo_omie,
  sp.sku_descricao,
  sp.fornecedor_nome,
  -- Qual dos dois caminhos: evento de reativação no Omie ainda sem decisão.
  EXISTS (
    SELECT 1 FROM public.eventos_outlier e
     WHERE e.empresa = sp.empresa
       AND e.sku_codigo_omie = sp.sku_codigo_omie::text
       AND e.tipo = 'sku_reativado_omie'
       AND e.status = 'pendente'
  ) AS reativado_omie_pendente
FROM public.sku_parametros sp
LEFT JOIN public.omie_products op
       ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text
      AND op.account = lower(sp.empresa)
LEFT JOIN public.sku_status_omie sso
       ON sso.empresa = sp.empresa
      AND sso.sku_codigo_omie = sp.sku_codigo_omie::text
LEFT JOIN public.familia_nao_comprada fnc
       ON fnc.empresa = sp.empresa
      AND fnc.familia = op.familia
WHERE sp.habilitado_reposicao_automatica IS NOT TRUE             -- o filtro do motor, INVERTIDO
  AND COALESCE(sp.tipo_reposicao, 'automatica') = 'automatica'
  AND sp.fornecedor_nome IS NOT NULL
  AND btrim(sp.fornecedor_nome) <> ''
  AND fnc.id IS NULL
  AND COALESCE(op.ativo, true) = true
  AND COALESCE(sso.ativo_no_omie, true) = true
  AND COALESCE(op.descricao, '') NOT ILIKE '%450ML'                -- fracionados: vendidos, nunca comprados
  AND COALESCE(op.descricao, '') NOT ILIKE '%405ML'
  AND COALESCE(op.tipo_produto, op.metadata ->> 'tipo_produto', '') <> '04'
  AND NOT EXISTS (                                                  -- galão (fator > 1) nunca é âncora
        SELECT 1 FROM public.sku_embalagem_equivalencia eq
         WHERE eq.empresa = lower(sp.empresa)
           AND eq.ativo = true
           AND eq.fator_para_base > 1
           AND eq.sku_codigo_omie::text = sp.sku_codigo_omie::text
      )
  AND sp.ponto_pedido IS NOT NULL
  AND sp.estoque_maximo IS NOT NULL
  AND COALESCE(sp.demanda_dias_com_movimento, 0) > 0;              -- o recorte do sensor: vendeu em 90d

-- Sensor de staff: sem anon; authenticated só lê (o RLS das tabelas-base filtra o resto).
REVOKE ALL ON public.v_reposicao_sku_fora_do_motor FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_reposicao_sku_fora_do_motor TO authenticated;

-- ------------------------------------------------------------
-- Postcondição — aborta se o estado final não bater
-- ------------------------------------------------------------
DO $post$
BEGIN
  -- A1: existe E lê como quem consulta (REPLACE sem repetir a opção a RESETA → leria como OWNER).
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'v_reposicao_sku_fora_do_motor' AND c.relkind = 'v'
       AND 'security_invoker=on' = ANY (coalesce(c.reloptions, '{}'))
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: v_reposicao_sku_fora_do_motor ausente ou sem security_invoker=on (leria como OWNER, bypassando RLS)';
  END IF;

  -- A2: privilégio nos dois sentidos — anon fora, authenticated lê.
  IF has_table_privilege('anon', 'public.v_reposicao_sku_fora_do_motor', 'SELECT') THEN
    RAISE EXCEPTION 'A2 FALHOU: anon ainda tem SELECT na view';
  END IF;
  IF NOT has_table_privilege('authenticated', 'public.v_reposicao_sku_fora_do_motor', 'SELECT') THEN
    RAISE EXCEPTION 'A2 FALHOU: authenticated sem SELECT — o cockpit nao leria o sensor';
  END IF;

  -- A3 (por execução, dado real): o 405ML 8689781893 passa em TODOS os outros filtros (automatica,
  -- flag desligado DE PROPÓSITO, fornecedor, venda em 90d, ponto/máximo) — só o recorte de fracionado
  -- o tira. Se ele aparecer, a view denunciaria como "esquecido" um item desligado de propósito.
  IF EXISTS (SELECT 1 FROM public.v_reposicao_sku_fora_do_motor
              WHERE empresa = 'OBEN' AND sku_codigo_omie = 8689781893) THEN
    RAISE EXCEPTION 'A3 FALHOU: o 405ML 8689781893 apareceu no sensor — o recorte de fracionado nao pegou';
  END IF;
END
$post$;

