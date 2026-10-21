-- ============================================================
-- Radar de Clientes — selo de FILIAL na fila: outros estabelecimentos da mesma empresa (raiz do CNPJ).
--
-- Medido em 2026-10-21 (psql-ro): 5,4 % do top 1.000 da fila por score é a 2ª/3ª filial de uma raiz que já
-- aparece acima, e 25 leads têm a mesma raiz de um estabelecimento que JÁ É CLIENTE (o recruzamento casa
-- pelo CNPJ completo, então essas filiais pontuam como prospecção fria). Decisão do founder: SINALIZAR na
-- linha e na ficha — sem esconder lead e sem mexer em score/ordem (docs/historico/radar-score-lead.md).
--
-- Entrega:
--   • Índice `idx_radar_empresas_raiz` em left(cnpj, 8) — a raiz do CNPJ (8 posições, vale para o
--     alfanumérico RFB jul/2026: 12 alfanuméricos + 2 DVs).
--   • `radar_irmaos_por_raiz(p_cnpjs text[])` — para cada CNPJ pedido (uma página da fila, ≤ 200):
--       irmaos_na_fila   outros leads da mesma raiz (não-cliente, não-descartado) — o "+N da mesma empresa"
--       irmaos_clientes  documentos de CLIENTE da mesma raiz, exceto o próprio — fonte única
--                        `radar_docs_clientes()` (profiles + Omie não vinculado, mesma normalização do
--                        recruzamento, CNPJ alfanumérico incluso) ∪ `radar_empresas.ja_cliente`
--       cliente_nome     um nome de cliente da raiz (para a ficha dizer DE QUEM é filial)
--     Só contagens e um nome de cliente — que o mesmo staff já vê na carteira. Gate = o MESMO da leitura da
--     fila (policy `radar_empresas_select_gestor`: `private.cap_carteira_ler`), fail-closed com 42501.
--     SECURITY DEFINER porque `radar_docs_clientes()` é fechada (só postgres/service_role); o gate fica na
--     fronteira. CNPJ fora do formato é ignorado (não ecoa); mais de 200 recusa com 22023.
--
-- DONO: aplicar como `postgres` (owner de radar_empresas; `claude_rw` não é). Idempotente: CREATE INDEX IF NOT
-- EXISTS + CREATE OR REPLACE + REVOKE/GRANT nomeando as roles. Postcondição no fim (md5 do corpo).
-- Prova: db/test-radar-irmaos-por-raiz.sh (PG17, gate sob SET ROLE + GUC, --falsificar).
-- ============================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_radar_empresas_raiz
  ON public.radar_empresas (left(cnpj, 8));

CREATE OR REPLACE FUNCTION public.radar_irmaos_por_raiz(p_cnpjs text[])
 RETURNS TABLE(cnpj text, irmaos_na_fila integer, irmaos_clientes integer, cliente_nome text)
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT COALESCE(private.cap_carteira_ler(auth.uid()), false) THEN
    RAISE EXCEPTION 'forbidden: carteira' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(cardinality(p_cnpjs), 0) > 200 THEN
    RAISE EXCEPTION 'radar_irmaos_por_raiz: no máximo 200 CNPJs por chamada (veio %)', cardinality(p_cnpjs)
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH pedidos AS (
    SELECT DISTINCT x AS cnpj, left(x, 8) AS raiz
      FROM unnest(p_cnpjs) AS u(x)
     WHERE x ~ '^[0-9A-Z]{12}[0-9]{2}$'
  ),
  clientes AS (
    SELECT d.doc, d.nome FROM public.radar_docs_clientes() d
     WHERE left(d.doc, 8) IN (SELECT raiz FROM pedidos)
    UNION
    SELECT r.cnpj, r.razao_social FROM public.radar_empresas r
     WHERE r.ja_cliente AND left(r.cnpj, 8) IN (SELECT raiz FROM pedidos)
  )
  SELECT
    p.cnpj,
    (SELECT count(*)::integer FROM public.radar_empresas r
      WHERE left(r.cnpj, 8) = p.raiz AND r.cnpj <> p.cnpj
        AND NOT r.ja_cliente AND r.prospeccao_status <> 'descartado'),
    (SELECT count(DISTINCT c.doc)::integer FROM clientes c
      WHERE left(c.doc, 8) = p.raiz AND c.doc <> p.cnpj),
    (SELECT c.nome FROM clientes c
      WHERE left(c.doc, 8) = p.raiz AND c.doc <> p.cnpj AND c.nome IS NOT NULL
      ORDER BY c.doc LIMIT 1)
  FROM pedidos p
  ORDER BY p.cnpj;
END;
$function$;

-- Chamada pelo front (staff logado): authenticated executa; o gate de carteira decide dentro.
REVOKE ALL ON FUNCTION public.radar_irmaos_por_raiz(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_irmaos_por_raiz(text[]) TO authenticated, service_role;

DO $post$
DECLARE
  v_md5 text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_radar_empresas_raiz' AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: idx_radar_empresas_raiz ausente ou inválido — cada página da fila varreria 550 mil linhas por raiz';
  END IF;
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.radar_irmaos_por_raiz(text[])');
  IF v_md5 IS DISTINCT FROM '15d1e7035c3deb7c44ffc6430f03021e' THEN
    RAISE EXCEPTION 'A2 FALHOU: radar_irmaos_por_raiz vivo (md5 %) não é o corpo deste arquivo', v_md5;
  END IF;
  IF has_function_privilege('anon', 'public.radar_irmaos_por_raiz(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon executa radar_irmaos_por_raiz';
  END IF;
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = to_regprocedure('public.radar_irmaos_por_raiz(text[])')) THEN
    RAISE EXCEPTION 'A4 FALHOU: radar_irmaos_por_raiz sem SECURITY DEFINER — radar_docs_clientes() negaria o acesso';
  END IF;
  RAISE NOTICE 'radar: índice por raiz e radar_irmaos_por_raiz (gate de carteira, ACL) provados';
END
$post$;

COMMIT;
