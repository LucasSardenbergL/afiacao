-- ============================================================
-- Radar de Clientes — selo "possível sucessor / vínculo com cliente" na LISTA (antes só na ficha).
--
-- A ficha já mostra o vínculo (`radar_possiveis_vinculos(p_cnpj)`, migration 20261104201756; parecer em
-- docs/historico/radar-sucessor-viabilidade-2026-11-04.md). A lista precisa da mesma resposta para a página
-- inteira (50 leads) numa chamada só, como o selo de filial (`radar_irmaos_por_raiz`).
--
-- Por que um NÚCLEO e não "chamar a ficha 50 vezes": medido em prod (2026-11-06, psql-ro), a regra custa ~850 ms
-- POR CNPJ — quase tudo é recalcular a chave de telefone dos ~15 mil `profiles` e o CEP dos ~14,6 mil `addresses`,
-- trabalho que não depende do lead. Em laço, uma página levaria ~42 s. Em conjunto, essa parte roda uma vez por
-- página. E as regras não podem existir em duas cópias que divergem, então:
--
--   • private.radar_vinculos_nucleo(p_cnpjs, p_carteira) — A ÚNICA cópia das regras (as mesmas da 20261104201756,
--     reescritas por lead): chave exclusiva (≤ 2 raízes) · contador derruba telefone e e-mail · pessoa só no MESMO
--     município · 'forte' = pessoa ou ≥ 2 sinais · 'media' = endereço completo sozinho · mesma raiz fica de fora ·
--     cliente só-profiles só com p_carteira · nome sem o CPF do MEI · até 10 por lead, na ordem da ficha (`ordem`).
--     Sem gate: fechado para PUBLIC/anon/authenticated, só os 2 invólucros abaixo o chamam.
--   • public.radar_possiveis_vinculos(p_cnpj) — a FICHA vira invólucro: gate + validação + núcleo com 1 CNPJ.
--     Mesma assinatura, mesmas colunas, mesma ordem.
--   • public.radar_vinculos_por_cnpjs(p_cnpjs) — a LISTA: até 200 CNPJs, uma linha por lead COM vínculo:
--     força do 1º (o mais forte, pela ordem da ficha), quantos, e nomes/situações na ordem da ficha. Quem decide
--     "sucessor" (situação fora de operação) é o front, com o MESMO mapa da ficha (src/lib/radar/vinculos.ts).
--     CNPJ repetido ou fora do formato é ignorado, como em radar_irmaos_por_raiz. Lead sem linha = sem vínculo.
--
-- É PISTA, nunca veredito: calculado na leitura, nada persistido, sem CPF, nunca "parente".
-- Aplicar: `bun run db:aplicar supabase/migrations/20261106083754_radar_vinculos_em_lote.sql` (o executor fornece
-- a transação — o arquivo não leva BEGIN/COMMIT). Prova: db/test-radar-vinculos-em-lote.sh.
-- ============================================================

-- TRAVA (antes de ler): ALTER sem efeito na função viva que este arquivo recria — quem chegar depois espera.
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_possiveis_vinculos(text)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_possiveis_vinculos(text) STABLE;
  END IF;
END
$trava$;

-- PRE: o corpo vivo da ficha é o revisado (20261104201756) ou já é este.
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.radar_possiveis_vinculos(text)');
  IF v_vivo IS NULL OR v_vivo NOT IN ('797fdffd63fdc071837d2e8c906d3148', '2452f463ae9d97860a4514b81f30a3ea') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_possiveis_vinculos vivo (md5 %) não é o da 20261104201756 nem este', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION private.radar_vinculos_nucleo(p_cnpjs text[], p_carteira boolean)
 RETURNS TABLE(lead_cnpj text, ordem integer, cliente_cnpj text, cliente_nome text, cliente_situacao text,
               forca text, sinais text[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH
  regra AS (
    SELECT '@[^@]*(cont|assessor|escritorio|fiscal|mei|partner)'::text AS cont
  ),
  lead AS (
    SELECT e.cnpj, e.telefone1, e.telefone2, e.email, e.cep, e.logradouro, e.numero, e.complemento,
           e.socios_nomes, e.razao_social, e.municipio_codigo
      FROM public.radar_empresas e
     WHERE e.cnpj = ANY (p_cnpjs) AND e.ja_cliente IS NOT TRUE
  ),
  perfil AS (
    SELECT x.doc, x.nome, private.radar_tel_chave(x.phone) AS tel_k,
           CASE WHEN x.email LIKE '%@%' THEN lower(btrim(x.email)) END AS email_k, x.user_id
      FROM (SELECT regexp_replace(upper(btrim(p.document)), '[^0-9A-Z]', '', 'g') AS doc,
                   COALESCE(NULLIF(btrim(p.razao_social), ''), NULLIF(btrim(p.name), '')) AS nome,
                   p.phone, p.email, p.user_id
              FROM public.profiles p WHERE p.document IS NOT NULL) x
     WHERE x.doc ~ '^[0-9A-Z]{12}[0-9]{2}$'
  ),
  lead_tel AS (
    SELECT DISTINCT l.cnpj AS lead, v.k
      FROM lead l
     CROSS JOIN LATERAL (VALUES (private.radar_tel_chave(l.telefone1)), (private.radar_tel_chave(l.telefone2))) v(k)
     WHERE v.k IS NOT NULL
  ),
  tel_hits AS (
    SELECT t.lead, e.cnpj AS doc, e.ja_cliente AS cliente, t.k FROM lead_tel t JOIN public.radar_empresas e ON e.telefone1 = t.k
    UNION
    SELECT t.lead, e.cnpj, e.ja_cliente, t.k FROM lead_tel t JOIN public.radar_empresas e ON e.telefone2 = t.k
    UNION
    SELECT t.lead, pf.doc, true, t.k FROM lead_tel t JOIN perfil pf ON pf.tel_k = t.k
  ),
  email_hits AS (
    SELECT l.cnpj AS lead, e.cnpj AS doc, e.ja_cliente AS cliente
      FROM lead l JOIN public.radar_empresas e
        ON e.email IS NOT NULL AND lower(btrim(e.email)) = lower(btrim(l.email))
     WHERE l.email LIKE '%@%'
    UNION
    SELECT l.cnpj, pf.doc, true
      FROM lead l JOIN perfil pf ON pf.email_k = lower(btrim(l.email))
     WHERE l.email LIKE '%@%'
  ),
  lead_end AS (
    SELECT l.cnpj AS lead, l.cep, private.radar_chave_endereco(l.logradouro, l.numero, l.complemento) AS k
      FROM lead l
  ),
  end_hits AS (
    SELECT le.lead, e.cnpj AS doc, e.ja_cliente AS cliente
      FROM lead_end le JOIN public.radar_empresas e ON e.cep = le.cep
     WHERE le.k IS NOT NULL AND le.cep ~ '^[0-9]{8}$'
       AND private.radar_chave_endereco(e.logradouro, e.numero, e.complemento) = le.k
    UNION
    SELECT le.lead, pf.doc, true
      FROM lead_end le
      JOIN public.addresses a ON regexp_replace(coalesce(a.zip_code, ''), '[^0-9]', '', 'g') = le.cep
      JOIN perfil pf ON pf.user_id = a.user_id
     WHERE le.k IS NOT NULL AND le.cep ~ '^[0-9]{8}$'
       AND private.radar_chave_endereco(a.street, a.number, a.complement) = le.k
  ),
  lead_pes AS (
    SELECT DISTINCT x.lead, x.n FROM (
      SELECT l.cnpj AS lead, unnest(string_to_array(l.socios_nomes, '; ')) AS n FROM lead l
      UNION ALL
      SELECT l.cnpj, btrim(regexp_replace(regexp_replace(l.razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' [0-9]{11}$', ''))
        FROM lead l
       WHERE l.razao_social ~ ' [0-9]{11}$' OR l.razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} '
    ) x
     WHERE x.n ~ '^[A-Z]+( [A-Z]+){2,}$'
  ),
  pes_hits AS (
    SELECT l.lead, e.cnpj AS doc, e.ja_cliente AS cliente, e.municipio_codigo AS mun, l.n
      FROM lead_pes l JOIN public.radar_empresas e
        ON e.socios_nomes IS NOT NULL AND string_to_array(e.socios_nomes, '; ') @> ARRAY[l.n]
    UNION
    SELECT l.lead, e.cnpj, e.ja_cliente, e.municipio_codigo, l.n
      FROM lead_pes l JOIN public.radar_empresas e
        ON (e.razao_social ~ ' [0-9]{11}$' OR e.razao_social ~ '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ')
       AND btrim(regexp_replace(regexp_replace(e.razao_social, '^[0-9]{2}\.[0-9]{3}\.[0-9]{3} ', ''), ' [0-9]{11}$', '')) = l.n
  ),
  sinal AS (
    SELECT h.lead, h.doc, 'telefone'::text AS s FROM tel_hits h
     WHERE h.cliente
       AND (h.lead, h.k) IN (SELECT lead, k FROM tel_hits GROUP BY lead, k HAVING count(DISTINCT left(doc, 8)) <= 2)
    UNION
    SELECT h.lead, h.doc, 'email' FROM email_hits h
     WHERE h.cliente
       AND h.lead IN (SELECT lead FROM email_hits GROUP BY lead HAVING count(DISTINCT left(doc, 8)) <= 2)
    UNION
    SELECT h.lead, h.doc, 'endereco' FROM end_hits h
     WHERE h.cliente
       AND h.lead IN (SELECT lead FROM end_hits GROUP BY lead HAVING count(DISTINCT left(doc, 8)) <= 2)
    UNION
    SELECT h.lead, h.doc, 'pessoa' FROM pes_hits h JOIN lead l ON l.cnpj = h.lead
     WHERE h.cliente AND h.mun = l.municipio_codigo
       AND (h.lead, h.n) IN (SELECT lead, n FROM pes_hits GROUP BY lead, n HAVING count(DISTINCT left(doc, 8)) <= 2)
  ),
  cliente AS (
    SELECT s.lead, s.doc,
           r.razao_social AS nome_radar,
           (SELECT pf.nome FROM perfil pf WHERE pf.doc = s.doc AND pf.nome IS NOT NULL ORDER BY pf.nome LIMIT 1) AS nome_perfil,
           COALESCE((SELECT sc.situacao FROM public.radar_situacao_cadastral sc
                      WHERE sc.cnpj = s.doc ORDER BY sc.lote DESC LIMIT 1), r.rfb_situacao) AS situacao,
           (l.email ~* g.cont
            OR coalesce(r.email, '') ~* g.cont
            OR EXISTS (SELECT 1 FROM perfil pf WHERE pf.doc = s.doc AND coalesce(pf.email_k, '') ~* g.cont)) AS contador,
           array_agg(DISTINCT s.s ORDER BY s.s) AS todos
      FROM sinal s
      JOIN lead l ON l.cnpj = s.lead
     CROSS JOIN regra g
      LEFT JOIN public.radar_empresas r ON r.cnpj = s.doc AND r.ja_cliente
     WHERE left(s.doc, 8) <> left(s.lead, 8)
     GROUP BY s.lead, s.doc, l.email, g.cont, r.razao_social, r.rfb_situacao, r.email
  ),
  validos AS (
    SELECT c.lead, c.doc, c.nome_radar, c.nome_perfil, c.situacao,
           CASE WHEN c.contador THEN ARRAY(SELECT u FROM unnest(c.todos) u WHERE u NOT IN ('telefone', 'email') ORDER BY u)
                ELSE c.todos END AS s
      FROM cliente c
     WHERE c.nome_radar IS NOT NULL OR p_carteira
  ),
  final AS (
    SELECT v.lead, v.doc,
           COALESCE(regexp_replace(v.nome_radar, ' [0-9]{11}$', ''), v.nome_perfil) AS nome,  -- sem o CPF do titular de MEI
           v.situacao,
           CASE WHEN 'pessoa' = ANY (v.s) OR cardinality(v.s) >= 2 THEN 'forte' ELSE 'media' END AS forca,
           v.s
      FROM validos v
     WHERE 'pessoa' = ANY (v.s) OR cardinality(v.s) >= 2 OR v.s = ARRAY['endereco']
  ),
  ordenado AS (
    SELECT f.*, row_number() OVER (PARTITION BY f.lead
                                   ORDER BY (CASE WHEN f.forca = 'forte' THEN 0 ELSE 1 END), cardinality(f.s) DESC, f.doc)::integer AS ordem
      FROM final f
  )
  SELECT o.lead, o.ordem, o.doc, o.nome, o.situacao, o.forca, o.s
    FROM ordenado o
   WHERE o.ordem <= 10
$function$;

REVOKE ALL ON FUNCTION private.radar_vinculos_nucleo(text[], boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.radar_possiveis_vinculos(p_cnpj text)
 RETURNS TABLE(cliente_cnpj text, cliente_nome text, cliente_situacao text, forca text, sinais text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido' USING ERRCODE = '22023';
  END IF;
  -- As regras vivem SÓ no núcleo (a lista usa o mesmo). Lead ausente ou já cliente → nenhuma linha.
  RETURN QUERY
  SELECT n.cliente_cnpj, n.cliente_nome, n.cliente_situacao, n.forca, n.sinais
    FROM private.radar_vinculos_nucleo(ARRAY[p_cnpj], COALESCE(private.cap_carteira_ler((SELECT auth.uid())), false)) n
   ORDER BY n.ordem;
END;
$function$;

REVOKE ALL ON FUNCTION public.radar_possiveis_vinculos(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_possiveis_vinculos(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.radar_vinculos_por_cnpjs(p_cnpjs text[])
 RETURNS TABLE(cnpj text, forca text, clientes integer, clientes_nomes text[], clientes_situacoes text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(cardinality(p_cnpjs), 0) > 200 THEN
    RAISE EXCEPTION 'radar_vinculos_por_cnpjs: no máximo 200 CNPJs por chamada (veio %)', cardinality(p_cnpjs)
      USING ERRCODE = '22023';
  END IF;
  -- Resumo por lead do que a ficha mostraria: o 1º vínculo é o mais forte (ordem da ficha). Sem linha = sem vínculo.
  RETURN QUERY
  SELECT n.lead_cnpj,
         (array_agg(n.forca ORDER BY n.ordem))[1],
         count(*)::integer,
         array_agg(n.cliente_nome ORDER BY n.ordem),
         array_agg(n.cliente_situacao ORDER BY n.ordem)
    -- CNPJ repetido ou fora do formato não precisa de filtro: o núcleo casa por `cnpj = ANY` em radar_empresas.
    FROM private.radar_vinculos_nucleo(p_cnpjs, COALESCE(private.cap_carteira_ler((SELECT auth.uid())), false)) n
   GROUP BY n.lead_cnpj
   ORDER BY n.lead_cnpj;
END;
$function$;

REVOKE ALL ON FUNCTION public.radar_vinculos_por_cnpjs(text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_vinculos_por_cnpjs(text[]) TO authenticated, service_role;

DO $post$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.esperado,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES ('private.radar_vinculos_nucleo(text[], boolean)', 'bc00b310f4347fde61fee3a6c3b28a30'),
                   ('public.radar_possiveis_vinculos(text)',          '2452f463ae9d97860a4514b81f30a3ea'),
                   ('public.radar_vinculos_por_cnpjs(text[])',        'a9278dd0c4e9fb025743caa438b9b130')) AS x(alvo, esperado)
  LOOP
    IF r.vivo IS DISTINCT FROM r.esperado THEN
      RAISE EXCEPTION 'A1 FALHOU: % vivo (md5 %) não é o corpo deste arquivo', r.alvo, r.vivo;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.radar_vinculos_por_cnpjs(text[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.radar_possiveis_vinculos(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.radar_vinculos_por_cnpjs(text[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.radar_possiveis_vinculos(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A2 FALHOU: ACL das RPCs do vínculo errada (anon executa ou authenticated não executa)';
  END IF;
  IF has_function_privilege('anon', 'private.radar_vinculos_nucleo(text[], boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.radar_vinculos_nucleo(text[], boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: o núcleo sem gate está executável pelo JWT';
  END IF;
  IF NOT (SELECT bool_and(p.prosecdef) FROM pg_catalog.pg_proc p
           WHERE p.oid IN (to_regprocedure('public.radar_possiveis_vinculos(text)'),
                           to_regprocedure('public.radar_vinculos_por_cnpjs(text[])'))) THEN
    RAISE EXCEPTION 'A4 FALHOU: RPC do vínculo sem SECURITY DEFINER — o núcleo fechado e profiles negariam a leitura';
  END IF;
  RAISE NOTICE 'radar: núcleo do vínculo fechado, ficha e lista sobre ele (corpo, ACL, definer) provados';
END
$post$;
