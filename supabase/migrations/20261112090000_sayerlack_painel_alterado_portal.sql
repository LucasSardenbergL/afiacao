-- 6.11 (revisão 2 do portal Sayerlack): o card "Pedidos do portal Sayerlack" mostra o pedido ALTERADO NO PORTAL.
-- Plano: docs/superpowers/plans/2026-11-08-sayerlack-revisao-2.md (6.11) · a 5.2 (20261111150000) criou a divergência.
--
-- Recria public.sayerlack_painel_portal() a partir do v2 (20261109100000; pré-voo 2026-11-09: prosrc de prod idêntico
-- ao do repo). CREATE OR REPLACE: a assinatura () não muda e o ACL é preservado; o REVOKE é reemitido nomeando as roles.
-- Contrato continua `versao` 2 e só ACRESCENTA chaves (o front publicado antes desta migration segue lendo):
--
--  6.11 `alterado_portal` (teto 50) + `total_alterado_portal`: pedido com divergência portal × app ABERTA
--       (`pedido_compra_sugerido.portal_divergencia_aberta_id` → `sayerlack_portal_divergencia` sem `resolvida_em`),
--       com ou sem pedido de compra, com as diferenças. É o que trava o re-disparo (gate da 5.2) e se resolve no
--       pedido ("Aceitar o portal"). Entra em `pendentes_unicos`, e a falha da varredura do mesmo protocolo vai na
--       linha dele (dedupe 6.4).
--       `sem_po[].divergencia_aberta`: a linha sem pedido de compra diz que o re-disparo está travado pela divergência
--       (o botão "Criar pedido de compra" seria recusado) — o card troca o botão por "Abrir o pedido".
--
-- Gate: private.cap_compras_ler (o mesmo do v1/v2). SECURITY DEFINER, STABLE, só leitura.
-- Idempotente; postcondição EXECUTA a função como um usuário de compras e confere o contrato.

CREATE OR REPLACE FUNCTION public.sayerlack_painel_portal()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $painel$
DECLARE
  v_sp timestamp := now() AT TIME ZONE 'America/Sao_Paulo';
  v_exigida timestamptz;
  v_efetiva jsonb;
  v_ultima jsonb;
  v_ef_em timestamptz;
BEGIN
  -- Gate de capacidade de compras (o mesmo das RPCs de leitura de reposição; ver scripts/authz-manifest.ts).
  IF auth.uid() IS NULL OR NOT private.cap_compras_ler(auth.uid()) THEN
    RAISE EXCEPTION 'Acesso negado: requer capacidade de compras' USING ERRCODE = '42501';
  END IF;

  -- Mesma régua do vigia (20261107220000): seg–sex a partir das 14:00 exige rodada de hoje; antes disso e no fim de
  -- semana, do dia útil anterior.
  v_exigida := (CASE WHEN extract(isodow FROM v_sp) BETWEEN 1 AND 5 AND v_sp::time >= time '14:00' THEN v_sp::date
                     WHEN extract(isodow FROM v_sp) = 1 THEN v_sp::date - 3
                     WHEN extract(isodow FROM v_sp) = 7 THEN v_sp::date - 2
                     ELSE v_sp::date - 1 END)::timestamp AT TIME ZONE 'America/Sao_Paulo';

  -- Contagem de lista no resumo: lista → tamanho; ausente/não-lista → null (ausente ≠ zero).
  SELECT COALESCE(ae.finalizado_em, ae.iniciado_em),
         jsonb_build_object(
           'id', ae.id,
           'em', COALESCE(ae.finalizado_em, ae.iniciado_em),
           'status', ae.status,
           'lidos', CASE WHEN jsonb_typeof(ae.detalhes -> 'lidos') = 'number' THEN (ae.detalhes ->> 'lidos')::numeric END,
           'importados', CASE WHEN jsonb_typeof(ae.detalhes -> 'importados') = 'array' THEN jsonb_array_length(ae.detalhes -> 'importados') END,
           'falhas', CASE WHEN jsonb_typeof(ae.detalhes -> 'falhas') = 'array' THEN jsonb_array_length(ae.detalhes -> 'falhas') END,
           'adiados', CASE WHEN jsonb_typeof(ae.detalhes -> 'adiados') = 'array' THEN jsonb_array_length(ae.detalhes -> 'adiados') END,
           'indeterminados', CASE WHEN jsonb_typeof(ae.detalhes -> 'indeterminados') = 'array' THEN jsonb_array_length(ae.detalhes -> 'indeterminados') END,
           'carencia_presa', CASE WHEN jsonb_typeof(ae.detalhes -> 'carencia_presa') = 'array' THEN jsonb_array_length(ae.detalhes -> 'carencia_presa') END,
           'carencia', CASE WHEN jsonb_typeof(ae.detalhes -> 'contagem') = 'object' THEN
               (CASE WHEN jsonb_typeof(ae.detalhes -> 'contagem' -> 'carencia_primeira_vista') = 'number'
                     THEN (ae.detalhes -> 'contagem' ->> 'carencia_primeira_vista')::numeric ELSE 0 END)
             + (CASE WHEN jsonb_typeof(ae.detalhes -> 'contagem' -> 'carencia_aguarda_sync') = 'number'
                     THEN (ae.detalhes -> 'contagem' ->> 'carencia_aguarda_sync')::numeric ELSE 0 END)
             END
         )
    INTO v_ef_em, v_efetiva
    FROM public.acoes_execucoes ae
   WHERE ae.acao = 'reposicao.varrer_portal_sayerlack'
     AND COALESCE(ae.detalhes ->> 'modo', 'importar') = 'importar'
     AND (ae.detalhes ->> 'prova_leitura' = 'ok'
          OR (ae.detalhes ->> 'prova_leitura' IS NULL AND ae.status = 'sucesso'
              AND ae.detalhes ->> 'pulado' IS NULL
              AND COALESCE(ae.detalhes ->> 'lidos', '') ~ '^[0-9]+$'
              AND (ae.detalhes ->> 'lidos')::bigint > 0))
   ORDER BY COALESCE(ae.finalizado_em, ae.iniciado_em) DESC, ae.iniciado_em DESC
   LIMIT 1;

  -- Última rodada do modo importar com desfecho (sucesso/erro), inclusive pulada: o card diz "a última falhou".
  SELECT jsonb_build_object(
           'id', d.id,
           'em', COALESCE(d.finalizado_em, d.iniciado_em),
           'status', d.status,
           'pulado', d.detalhes ->> 'pulado',
           'prova_leitura', d.detalhes ->> 'prova_leitura',
           'causa', d.detalhes ->> 'causa_pre_protocolo',
           'erro', left(d.detalhes ->> 'erro', 300))
    INTO v_ultima
    FROM public.acoes_execucoes d
   WHERE d.acao = 'reposicao.varrer_portal_sayerlack'
     AND COALESCE(d.detalhes ->> 'modo', 'importar') = 'importar'
     AND d.status IN ('sucesso', 'erro')
   ORDER BY d.iniciado_em DESC
   LIMIT 1;

  RETURN (
    WITH base AS (
      -- Pedido do portal (importado OU originado no app) com protocolo e sem pedido de compra no Omie.
      SELECT p.id, p.portal_protocolo AS protocolo, p.status, p.importado_portal_em, p.enviado_portal_em,
             COALESCE(p.importado_portal_em, p.enviado_portal_em) AS desde,
             p.portal_situacao_codigo AS situacao_codigo, p.portal_situacao_texto AS situacao_texto,
             p.portal_situacao_em AS situacao_em, p.omie_pedido_compra_numero AS omie_numero,
             (p.omie_pedido_compra_id IS NULL OR btrim(p.omie_pedido_compra_id::text) IN ('', '0')) AS sem_po,
             p.portal_divergencia_aberta_id AS divergencia_id
        FROM public.pedido_compra_sugerido p
       WHERE p.portal_protocolo IS NOT NULL
         AND p.status NOT IN ('cancelado', 'rejeitado', 'expirado_sem_aprovacao', 'cancelado_humano')
    ),
    sem_po AS (
      SELECT b.* FROM base b
       WHERE b.sem_po AND b.situacao_codigo IS DISTINCT FROM '6'
         AND (b.desde IS NULL OR b.desde < now() - interval '1 hour')
    ),
    aguardando AS (
      SELECT b.* FROM base b
       WHERE b.sem_po AND b.situacao_codigo IS DISTINCT FROM '6' AND b.desde >= now() - interval '1 hour'
    ),
    cancelado_sem_po AS (SELECT b.* FROM base b WHERE b.sem_po AND b.situacao_codigo = '6'),
    cancelado_com_po AS (SELECT b.* FROM base b WHERE NOT b.sem_po AND b.situacao_codigo = '6'),
    -- 6.11: divergência portal × app ABERTA (a 5.2 grava; o JOIN exige a linha ainda sem resolução).
    alterado AS (
      SELECT b.*, d.detectada_em, d.diferencas
        FROM base b
        JOIN public.sayerlack_portal_divergencia d ON d.id = b.divergencia_id AND d.resolvida_em IS NULL
    ),
    falhas AS (SELECT f.* FROM public.sayerlack_varredura_falha f WHERE f.resolvido_em IS NULL),
    -- Protocolos que já aparecem numa linha de pedido: a pendência deles vai DENTRO da linha (6.4).
    com_linha AS (
      SELECT protocolo FROM sem_po UNION SELECT protocolo FROM aguardando
      UNION SELECT protocolo FROM cancelado_sem_po UNION SELECT protocolo FROM cancelado_com_po
      UNION SELECT protocolo FROM alterado
    ),
    pend AS (SELECT f.* FROM falhas f WHERE f.protocolo NOT IN (SELECT protocolo FROM com_linha)),
    importados AS (
      SELECT p.* FROM public.pedido_compra_sugerido p WHERE p.importado_portal_em >= now() - interval '14 days'
    ),
    aliq AS (
      SELECT count(DISTINCT s.id) AS skus,
             COALESCE(jsonb_agg(DISTINCT regexp_replace(op.ncm, '[^0-9]', '', 'g')) FILTER (WHERE op.ncm IS NOT NULL), '[]'::jsonb) AS ncms
        FROM public.sku_fornecedor_externo s
        JOIN public.omie_products op ON op.omie_codigo_produto::text = s.sku_omie AND op.account = lower(s.empresa)
        LEFT JOIN public.ipi_aliquota_ncm a ON a.ncm = regexp_replace(op.ncm, '[^0-9]', '', 'g')
       WHERE s.ativo AND s.empresa = 'OBEN' AND s.fornecedor_nome ILIKE '%sayer%' AND a.ncm IS NULL
    )
    SELECT jsonb_build_object(
      'versao', 2,
      'consultado_em', now(),
      'rodada', jsonb_build_object(
        'ultima_efetiva', v_efetiva,
        'ultima', v_ultima,
        'exigida_desde', v_exigida,
        'em_dia', (v_ef_em IS NOT NULL AND v_ef_em >= v_exigida)),
      'pendencias', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('protocolo', x.protocolo, 'mensagem', x.mensagem, 'tentativas', x.tentativas,
                                            'primeira_em', x.primeira_em, 'ultima_em', x.ultima_em) ORDER BY x.ultima_em DESC)
          FROM (SELECT * FROM pend ORDER BY ultima_em DESC LIMIT 50) x), '[]'::jsonb),
      'total_pendencias', (SELECT count(*) FROM pend),
      'sem_po', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('pedido_id', x.id, 'protocolo', x.protocolo, 'status', x.status,
                                            'importado_em', x.importado_portal_em, 'desde', x.desde,
                                            'origem', CASE WHEN x.importado_portal_em IS NOT NULL THEN 'importado' ELSE 'app' END,
                                            'pendencia_mensagem', f.mensagem, 'pendencia_tentativas', f.tentativas,
                                            'divergencia_aberta', EXISTS (SELECT 1 FROM alterado a WHERE a.id = x.id))
                         ORDER BY x.desde DESC NULLS LAST, x.id DESC)
          FROM (SELECT * FROM sem_po ORDER BY desde DESC NULLS LAST, id DESC LIMIT 50) x
          LEFT JOIN falhas f ON f.protocolo = x.protocolo), '[]'::jsonb),
      'total_sem_po', (SELECT count(*) FROM sem_po),
      'aguardando_disparo', jsonb_build_object(
        'total', (SELECT count(*) FROM aguardando),
        'mais_antigo_em', (SELECT min(desde) FROM aguardando)),
      'cancelado_sem_po', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('pedido_id', x.id, 'protocolo', x.protocolo, 'status', x.status,
                                            'situacao_texto', x.situacao_texto, 'situacao_em', x.situacao_em)
                         ORDER BY x.situacao_em DESC NULLS LAST, x.id DESC)
          FROM (SELECT * FROM cancelado_sem_po ORDER BY situacao_em DESC NULLS LAST, id DESC LIMIT 50) x), '[]'::jsonb),
      'total_cancelado_sem_po', (SELECT count(*) FROM cancelado_sem_po),
      'cancelado_com_po', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('pedido_id', x.id, 'protocolo', x.protocolo, 'status', x.status,
                                            'omie_numero', x.omie_numero, 'situacao_texto', x.situacao_texto,
                                            'situacao_em', x.situacao_em)
                         ORDER BY x.situacao_em DESC NULLS LAST, x.id DESC)
          FROM (SELECT * FROM cancelado_com_po ORDER BY situacao_em DESC NULLS LAST, id DESC LIMIT 50) x), '[]'::jsonb),
      'total_cancelado_com_po', (SELECT count(*) FROM cancelado_com_po),
      'alterado_portal', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('pedido_id', x.id, 'protocolo', x.protocolo, 'status', x.status,
                                            'omie_numero', CASE WHEN x.sem_po THEN NULL ELSE x.omie_numero END,
                                            'sem_po', x.sem_po, 'detectada_em', x.detectada_em,
                                            'diferencas', x.diferencas,
                                            'pendencia_mensagem', f.mensagem, 'pendencia_tentativas', f.tentativas)
                         ORDER BY x.detectada_em DESC, x.id DESC)
          FROM (SELECT * FROM alterado ORDER BY detectada_em DESC, id DESC LIMIT 50) x
          LEFT JOIN falhas f ON f.protocolo = x.protocolo), '[]'::jsonb),
      'total_alterado_portal', (SELECT count(*) FROM alterado),
      'pendentes_unicos', (
        SELECT count(DISTINCT protocolo) FROM (
          SELECT protocolo FROM pend UNION ALL SELECT protocolo FROM sem_po
          UNION ALL SELECT protocolo FROM cancelado_sem_po UNION ALL SELECT protocolo FROM cancelado_com_po
          UNION ALL SELECT protocolo FROM alterado) u),
      'importados', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('pedido_id', x.id, 'protocolo', x.portal_protocolo, 'omie_numero', x.omie_pedido_compra_numero,
                                            'valor_total', x.valor_total, 'importado_em', x.importado_portal_em,
                                            'origem', CASE WHEN x.importado_portal_por IS NULL THEN 'cron' ELSE 'botao' END)
                         ORDER BY x.importado_portal_em DESC)
          FROM (SELECT * FROM importados ORDER BY importado_portal_em DESC LIMIT 50) x), '[]'::jsonb),
      'total_importados', (SELECT count(*) FROM importados),
      'sem_aliquota', (SELECT jsonb_build_object('skus', a.skus, 'ncms', a.ncms) FROM aliq a)
    )
  );
END;
$painel$;

REVOKE ALL ON FUNCTION public.sayerlack_painel_portal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_painel_portal() FROM anon;
GRANT EXECUTE ON FUNCTION public.sayerlack_painel_portal() TO authenticated, service_role;

-- Postcondição: fechada para anon/PUBLIC, aberta para authenticated, e o corpo VIVO executa (PL/pgSQL é late-bound)
-- devolvendo o contrato v2 com as chaves do v1.
DO $post$
DECLARE
  v_uid uuid;
  v_r jsonb;
  v_chave text;
BEGIN
  IF has_function_privilege('anon', 'public.sayerlack_painel_portal()', 'EXECUTE') THEN
    RAISE EXCEPTION 'P1 FALHOU: painel do portal executável por anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = 'public.sayerlack_painel_portal()'::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'P2 FALHOU: painel do portal executável por PUBLIC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.sayerlack_painel_portal()', 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: authenticated sem EXECUTE — o card não leria';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.sayerlack_painel_portal()'::regprocedure) THEN
    RAISE EXCEPTION 'P4 FALHOU: painel deixou de ser SECURITY DEFINER';
  END IF;
  -- Executa como alguém de compras (se houver) para provar o corpo e o contrato.
  SELECT ur.user_id INTO v_uid FROM public.user_roles ur
   WHERE private.cap_compras_ler(ur.user_id) ORDER BY ur.user_id LIMIT 1;
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'P5 FALHOU: nenhum usuário com cap_compras_ler para executar a prova do corpo';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', v_uid::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_uid, 'role', 'authenticated')::text, true);
  PERFORM set_config('test.uid', v_uid::text, true);
  v_r := public.sayerlack_painel_portal();
  FOREACH v_chave IN ARRAY ARRAY['versao', 'consultado_em', 'rodada', 'pendencias', 'total_pendencias', 'sem_po',
                                  'total_sem_po', 'aguardando_disparo', 'cancelado_sem_po', 'total_cancelado_sem_po',
                                  'cancelado_com_po', 'total_cancelado_com_po', 'pendentes_unicos', 'importados',
                                  'total_importados', 'sem_aliquota', 'alterado_portal', 'total_alterado_portal'] LOOP
    IF NOT v_r ? v_chave THEN
      RAISE EXCEPTION 'P6 FALHOU: contrato v2 sem a chave %', v_chave;
    END IF;
  END LOOP;
  IF (v_r ->> 'versao') <> '2' OR jsonb_typeof(v_r -> 'pendencias') <> 'array' OR jsonb_typeof(v_r -> 'sem_po') <> 'array'
     OR jsonb_typeof(v_r -> 'importados') <> 'array' OR jsonb_typeof(v_r -> 'alterado_portal') <> 'array'
     OR NOT (v_r -> 'rodada') ? 'em_dia' THEN
    RAISE EXCEPTION 'P7 FALHOU: forma do contrato v2 inesperada: %', left(v_r::text, 300);
  END IF;
  RAISE NOTICE 'sayerlack_painel_portal v2 + alterado_portal OK';
END
$post$;
