-- =============================================================================
-- REDESIGN "VISITAS EM CAMPO" — Sub-PR 1 (fix): carteira casa city no formato
-- "NOME (UF)". Os endereços gravam a cidade como 'DIVINOPOLIS (MG)' (UF embutido
-- entre parênteses, sem acento) — o cruzamento da 20260614160000 normalizava
-- acento/caixa mas mantinha o sufixo ' (MG)', então não casava o município RFB
-- ('DIVINÓPOLIS') → 0 clientes em prod (smoke real). Aqui o cruzamento remove o
-- sufixo ' (…)' final antes de normalizar (idempotente: city sem parênteses não muda).
-- Spec: docs/superpowers/specs/2026-06-14-roteirizador-visitas-campo-redesign-design.md
-- ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor do Lovable. CREATE OR REPLACE — a última
-- recriação vence; norm_cidade e radar_prospects_para_rota (160000) ficam como estão.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.carteira_por_municipio(p_municipio_codigo text)
RETURNS TABLE(
  user_id uuid, name text, phone text,
  street text, number text, neighborhood text, city text, state text, zip_code text, complement text,
  business_hours_open text, business_hours_close text,
  ultima_visita timestamptz, dias_desde_visita integer
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
DECLARE
  v_nome text;
  v_uf   text;
BEGIN
  IF NOT COALESCE(public.pode_ver_carteira_completa((SELECT auth.uid())), false) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only';
  END IF;
  IF p_municipio_codigo IS NULL OR btrim(p_municipio_codigo) = '' THEN
    RAISE EXCEPTION 'municipio_codigo obrigatório';
  END IF;

  SELECT re.municipio_nome, re.uf INTO v_nome, v_uf
    FROM public.radar_empresas re
   WHERE re.municipio_codigo = p_municipio_codigo
   LIMIT 1;
  IF v_nome IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH alvo AS (
    SELECT a.user_id, a.street, a.number, a.neighborhood, a.city, a.state,
           a.zip_code, a.complement, a.is_default
      FROM public.addresses a
     WHERE public.norm_cidade(regexp_replace(a.city, '\s*\([^)]*\)\s*$', '')) = public.norm_cidade(v_nome)
       AND upper(btrim(a.state)) = upper(btrim(v_uf))
  ),
  ende AS (
    SELECT DISTINCT ON (user_id)
           user_id, street, number, neighborhood, city, state, zip_code, complement
      FROM alvo
     ORDER BY user_id, is_default DESC NULLS LAST
  ),
  ult AS (
    SELECT rv.customer_user_id, max(rv.check_in_at) AS ultima
      FROM public.route_visits rv
     WHERE rv.customer_user_id IN (SELECT e.user_id FROM ende e)
       AND rv.check_in_at IS NOT NULL
     GROUP BY rv.customer_user_id
  )
  SELECT e.user_id, p.name, p.phone,
         e.street, e.number, e.neighborhood, e.city, e.state, e.zip_code, e.complement,
         p.business_hours_open, p.business_hours_close,
         u.ultima,
         CASE WHEN u.ultima IS NULL THEN NULL
              ELSE floor(extract(epoch FROM (now() - u.ultima)) / 86400)::int END
    FROM ende e
    JOIN public.profiles p ON p.user_id = e.user_id
    LEFT JOIN ult u ON u.customer_user_id = e.user_id
   WHERE COALESCE(p.is_employee, false) = false;
END $$;

REVOKE ALL ON FUNCTION public.carteira_por_municipio(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.carteira_por_municipio(text) TO authenticated;

-- Validação pós-apply (colar junto; cliente_norm e rfb_norm devem ser 'divinopolis')
SELECT 'CARTEIRA SUFIXO UF OK' AS status,
  public.norm_cidade(regexp_replace('DIVINOPOLIS (MG)', '\s*\([^)]*\)\s*$', '')) AS cliente_norm,
  public.norm_cidade('DIVINÓPOLIS') AS rfb_norm;
