-- ============================================================
-- Crédito: AVISO de possível vínculo com cliente que tem título VENCIDO (passo 2 do "Radar sucessor")
--
-- Decisão do founder (2026-11-06): um CNPJ (cliente do pedido ou lead da ficha do Radar) com selo de possível
-- vínculo/sucessor de um cliente nosso com título vencido em aberto recebe o AVISO "Possível vínculo com cliente
-- que possui títulos vencidos; requer conferência". É SÓ aviso: não bloqueia o pedido, não cria exceção, não
-- encurta prazo, não entra em `vencido_no_momento`. `venda_gate_credito` / gateCredito() seguem INTACTOS.
--
-- Medido em prod (2026-11-06, psql-ro): 241 pares (conta, código) com vencido, 0 sem mapa; a regra do vínculo,
-- rodada sobre os 457 CNPJs que compartilham chave com algum devedor, dá 10 sujeitos (4 forte, 6 média) — 8 deles
-- JÁ SÃO CLIENTES, que o núcleo da prospecção exclui. Só ~20% dos clientes com CNPJ (3.021 de 15.226) estão na
-- base RFB do Radar: os demais não são avaliáveis e a RPC diz isso ('fora_da_base'), nunca "sem vínculo".
--
-- O QUE MUDA:
--   1. private.radar_vinculos_base(p_cnpjs, p_carteira, p_incluir_clientes) — A ÚNICA cópia das regras (o corpo
--      da 20261106083754 sem o corte de 10 e com o filtro de já-cliente virando parâmetro). O núcleo
--      private.radar_vinculos_nucleo vira invólucro (false + ordem ≤ 10): ficha e lista não mudam.
--   2. public.credito_vinculo_aviso(p_cnpj) → jsonb — gate staff (o de venda_prazo_aviso); todos os vínculos, já
--      cliente incluído, carteira inteira avaliada; documento → titular único → códigos Omie COM PROVA documental
--      (o contrato de identidade da 20261019140000: evidência = documento do vinculado, mapa fresco de 7 d); o
--      vencido de cada código é `public.venda_prazo_aviso` — a MESMA regra do aviso de prazo (sem 3ª cópia).
--      Devolve só vínculos com vencido > 0, por credora (colacor_sc incluída), + quantos ficaram INDETERMINADOS
--      (sem código provado, título ambíguo/inválido, sync velho). Projeção = a da ficha (founder, 2026-11-06):
--      nome/CNPJ de cliente só-cadastro só para quem tem cap_carteira_ler. Nada persistido.
--   3. public.credito_vinculo_aviso_registrar — o SENSOR (único escritor de 'credito.vinculo_aviso_servido' e
--      'credito.vinculo_aviso_conferido' no analytics_outbox), validado no servidor: staff, superfície, e que o par
--      é um aviso VIGENTE. Não toca a allowlist quente de analytics_ledger_registrar (precedente:
--      venda_prazo_decisao_registrar).
--
-- Corpos vivos lidos da PROD em 2026-11-06 (psql-ro), iguais aos do repo: núcleo bc00b310f4347fde61fee3a6c3b28a30,
-- venda_prazo_aviso d2dda7d32d8a6acd34e24aa1cc1f4c96. Medido também: os 241 pares devedores têm evidência documental
-- igual ao documento do perfil, source='document', mapa < 7 d e 0 documento com 2 titulares — a prova custa 0 de recall.
-- Molde TRAVA → PRE → CREATE → PÓS. Prova PG17: db/test-credito-vinculo-aviso.sh (e --falsificar).
--
-- Aplicação: `bun run db:aplicar supabase/migrations/20261106193714_credito_aviso_vinculo_vencido.sql`
-- (sem BEGIN/COMMIT: o executor fornece a transação).
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (mesma volatilidade VIVA) prende cada função até o fim.
DO $trava$
BEGIN
  ALTER FUNCTION private.radar_vinculos_nucleo(text[], boolean) STABLE;
  ALTER FUNCTION public.venda_prazo_aviso(text, bigint) STABLE;
  ALTER FUNCTION public.normalizar_documento(text) IMMUTABLE;
  -- No RE-apply os objetos novos já existem: prendê-los também, ANTES da PRE (achado Codex P2 do código) — senão
  -- outro escritor (SQL Editor) mudaria um deles entre a PRE e o CREATE, e a PÓS aprovaria por cima.
  IF to_regprocedure('private.radar_vinculos_base(text[],boolean,boolean)') IS NOT NULL THEN
    ALTER FUNCTION private.radar_vinculos_base(text[], boolean, boolean) STABLE;
  END IF;
  IF to_regprocedure('private.credito_vinculo_avaliar(text,boolean)') IS NOT NULL THEN
    ALTER FUNCTION private.credito_vinculo_avaliar(text, boolean) STABLE;
  END IF;
  IF to_regprocedure('public.credito_vinculo_aviso(text)') IS NOT NULL THEN
    ALTER FUNCTION public.credito_vinculo_aviso(text) STABLE;
  END IF;
  IF to_regprocedure('public.credito_vinculo_aviso_registrar(text,text,text,text,text)') IS NOT NULL THEN
    ALTER FUNCTION public.credito_vinculo_aviso_registrar(text, text, text, text, text) VOLATILE;
  END IF;
END
$trava$;

-- PRE: md5 EXATO do núcleo vivo ∈ {predecessor, este}; venda_prazo_aviso e normalizar_documento (lidos, não
-- recriados) presentes e com o corpo esperado.
DO $pre$
DECLARE
  v_nuc text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_vinculos_nucleo(text[],boolean)'));
  v_pz  text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.venda_prazo_aviso(text,bigint)'));
  v_nd  text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.normalizar_documento(text)'));
  v_bs  text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.radar_vinculos_base(text[],boolean,boolean)'));
  v_pa  text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('private.credito_vinculo_avaliar(text,boolean)'));
  v_av  text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.credito_vinculo_aviso(text)'));
  v_rg  text := (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.credito_vinculo_aviso_registrar(text,text,text,text,text)'));
BEGIN
  -- Os 4 objetos novos: ausentes (1º apply) ou já este corpo (re-apply). Outro corpo = outra sessão no meio.
  IF v_bs IS NOT NULL AND v_bs <> '91dc715bb76efc00b85c4b86964d50db' THEN
    RAISE EXCEPTION 'PRE FALHOU: private.radar_vinculos_base vivo (md5 %) não é o deste arquivo', v_bs;
  END IF;
  IF v_pa IS NOT NULL AND v_pa <> 'afbc83bfdbe959be21486d19c818d051' THEN
    RAISE EXCEPTION 'PRE FALHOU: private.credito_vinculo_avaliar vivo (md5 %) não é o deste arquivo', v_pa;
  END IF;
  IF v_av IS NOT NULL AND v_av <> 'e7e4c97c787123c82c814f192db361a2' THEN
    RAISE EXCEPTION 'PRE FALHOU: public.credito_vinculo_aviso vivo (md5 %) não é o deste arquivo', v_av;
  END IF;
  IF v_rg IS NOT NULL AND v_rg <> '9e0cfc8bc35dd5bc0784d0821b15918a' THEN
    RAISE EXCEPTION 'PRE FALHOU: public.credito_vinculo_aviso_registrar vivo (md5 %) não é o deste arquivo', v_rg;
  END IF;
  IF v_nuc IS NULL OR v_nuc NOT IN ('bc00b310f4347fde61fee3a6c3b28a30', 'f345a864df438f0b7fba25bf50f6ea43') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_vinculos_nucleo vivo (md5 %) não é o da 20261106083754 nem este — outra sessão mexeu nas regras; reconcilie antes', v_nuc;
  END IF;
  IF v_pz IS DISTINCT FROM 'd2dda7d32d8a6acd34e24aa1cc1f4c96' THEN
    RAISE EXCEPTION 'PRE FALHOU: venda_prazo_aviso vivo (md5 %) não é o da 20261031200000 — a regra do vencido mudou; reprove o aviso antes', v_pz;
  END IF;
  IF v_nd IS DISTINCT FROM 'b7659502c90df3ff483c576cf56d559d' THEN
    RAISE EXCEPTION 'PRE FALHOU: normalizar_documento vivo (md5 %) não é o da 20261019140000 — a chave do documento mudou', v_nd;
  END IF;
END
$pre$;

-- ------------------------------------------------------------
-- 1. A base das regras do vínculo (a ÚNICA cópia). Corpo = núcleo da 20261106083754, com 2 mudanças:
--    o filtro de já-cliente do SUJEITO vira `p_incluir_clientes` e o corte de 10 sai (fica no invólucro).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.radar_vinculos_base(p_cnpjs text[], p_carteira boolean, p_incluir_clientes boolean)
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
     WHERE e.cnpj = ANY (p_cnpjs) AND (p_incluir_clientes OR e.ja_cliente IS NOT TRUE)
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
$function$;


REVOKE ALL ON FUNCTION private.radar_vinculos_base(text[], boolean, boolean) FROM PUBLIC, anon, authenticated;

-- O núcleo da ficha e da lista vira invólucro da base: mesma assinatura, mesmas colunas, MESMA saída (prospecção
-- não mostra quem já é cliente e corta em 10 por lead, na ordem da ficha — `ordem` é por lead, então cortar depois
-- é o mesmo que cortar antes). Prova de equivalência: db/test-credito-vinculo-aviso.sh (E*).
CREATE OR REPLACE FUNCTION private.radar_vinculos_nucleo(p_cnpjs text[], p_carteira boolean)
 RETURNS TABLE(lead_cnpj text, ordem integer, cliente_cnpj text, cliente_nome text, cliente_situacao text,
               forca text, sinais text[])
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT b.lead_cnpj, b.ordem, b.cliente_cnpj, b.cliente_nome, b.cliente_situacao, b.forca, b.sinais
    FROM private.radar_vinculos_base(p_cnpjs, p_carteira, false) b
   WHERE b.ordem <= 10
$function$;

REVOKE ALL ON FUNCTION private.radar_vinculos_nucleo(text[], boolean) FROM PUBLIC, anon, authenticated;

-- ------------------------------------------------------------
-- 2. O AVISO. Leitura, nada persistido. Sujeito = o CNPJ do cliente do pedido ou do lead da ficha.
--    private.credito_vinculo_avaliar = a avaliação, numa ÚNICA consulta (um snapshot), sem gate — fechada ao JWT.
--    public.credito_vinculo_aviso = gate staff + projeção de quem chama; o sensor usa a avaliação com a carteira
--    inteira, para gravar o CNPJ real do par que a tela mostrou.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.credito_vinculo_avaliar(p_cnpj text, p_ver_carteira boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_out jsonb;
BEGIN
  -- Fora da base RFB do Radar não há como avaliar: dizer isso, nunca "sem vínculo".
  IF NOT EXISTS (SELECT 1 FROM public.radar_empresas e WHERE e.cnpj = p_cnpj) THEN
    RETURN jsonb_build_object('estado', 'fora_da_base', 'regra_versao', 1);
  END IF;

  -- Projeção = a da ficha (decisão do founder, 2026-11-06): o crédito AVALIA a carteira inteira, mas só mostra
  -- nome/CNPJ de cliente só-cadastro a quem lê a carteira (p_ver_carteira). Valores: todo staff.
  WITH
  -- TODOS os vínculos (já-cliente incluído, sem o corte de 10): o corte de apresentação não esconde devedor.
  v AS (
    SELECT b.ordem, b.cliente_cnpj, b.cliente_nome, b.cliente_situacao, b.forca, b.sinais,
           EXISTS (SELECT 1 FROM public.radar_empresas r WHERE r.cnpj = b.cliente_cnpj AND r.ja_cliente) AS no_radar
      FROM private.radar_vinculos_base(ARRAY[p_cnpj], true, true) b
  ),
  -- documento → titular. Documento de mais de um titular não prova de quem é a dívida (→ indeterminado).
  titular AS (
    SELECT v.cliente_cnpj, min(p.user_id::text)::uuid AS user_id, count(DISTINCT p.user_id) AS n_titulares
      FROM v
      JOIN public.profiles p
        ON p.document IS NOT NULL AND public.normalizar_documento(p.document) = v.cliente_cnpj
     GROUP BY v.cliente_cnpj
  ),
  -- Os códigos Omie do titular, cada um com a PROVA do contrato de identidade (20261019140000 §client_prova):
  -- evidência documental = o documento do vinculado, titular único, mapa fresco (7 d). Sem prova → não avaliado.
  par AS (
    SELECT t.cliente_cnpj, m.account AS company, m.omie_codigo_cliente AS codigo,
           -- COALESCE: evidência NULA é "sem prova", nunca NULL (NULL some de provado E de NOT provado)
           COALESCE(t.n_titulares = 1
                    AND m.evidence_document_normalized = t.cliente_cnpj
                    AND m.updated_at >= now() - interval '7 days', false) AS provado
      FROM titular t
      JOIN public.omie_customer_account_map m ON m.user_id = t.user_id
     WHERE m.omie_codigo_cliente > 0
  ),
  -- A regra do vencido é UMA: venda_prazo_aviso (a mesma do aviso de prazo e da fila de cobrança).
  aval AS (
    SELECT q.cliente_cnpj, q.company, public.venda_prazo_aviso(q.company, q.codigo) AS a
      FROM par q
     WHERE q.provado
  ),
  credora AS (
    SELECT a.cliente_cnpj, a.company,
           sum((a.a ->> 'vencido')::numeric) AS vencido,
           sum((a.a ->> 'n_titulos')::integer) AS n_titulos,
           max((a.a ->> 'dias_vencido_max')::integer) AS dias_vencido_max,
           min(a.a ->> 'vencimento_mais_antigo') AS vencimento_mais_antigo,
           min(a.a ->> 'sync_em') AS sync_em,
           sum((a.a ->> 'n_ambiguos')::integer) AS n_ambiguos,
           sum((a.a ->> 'n_invalidos')::integer) AS n_invalidos,
           -- a pior qualidade entre os códigos da mesma conta
           (array_agg(a.a ->> 'qualidade' ORDER BY CASE a.a ->> 'qualidade' WHEN 'sem_sync' THEN 0
                                                                            WHEN 'defasado' THEN 1 ELSE 2 END))[1] AS qualidade
      FROM aval a
     WHERE (a.a ->> 'disponivel')::boolean
     GROUP BY a.cliente_cnpj, a.company
  ),
  por_vinculo AS (
    SELECT v.*,
           (SELECT count(*) FROM par q WHERE q.cliente_cnpj = v.cliente_cnpj AND q.provado) AS n_provados,
           (SELECT count(*) FROM par q WHERE q.cliente_cnpj = v.cliente_cnpj AND NOT q.provado) AS n_sem_prova,
           -- avaliação INCOMPLETA de alguma credora: título de status incerto/inválido, ou sync velho/ausente
           EXISTS (SELECT 1 FROM credora c WHERE c.cliente_cnpj = v.cliente_cnpj
                    AND (c.n_ambiguos > 0 OR c.n_invalidos > 0 OR c.qualidade <> 'ok')) AS incompleto,
           (SELECT jsonb_agg(jsonb_build_object(
                     'company', c.company, 'vencido', c.vencido, 'n_titulos', c.n_titulos,
                     'dias_vencido_max', c.dias_vencido_max, 'vencimento_mais_antigo', c.vencimento_mais_antigo,
                     'sync_em', c.sync_em, 'qualidade', c.qualidade,
                     'n_ambiguos', c.n_ambiguos, 'n_invalidos', c.n_invalidos) ORDER BY c.company)
              FROM credora c WHERE c.cliente_cnpj = v.cliente_cnpj AND c.vencido > 0) AS credoras
      FROM v
  )
  SELECT jsonb_build_object(
           'estado', 'avaliado',
           'regra_versao', 1,
           'n_vinculos', count(*),
           -- sem evidência positiva E sem avaliação completa: não se sabe — nunca "em dia"
           'n_indeterminados', count(*) FILTER (WHERE pv.credoras IS NULL
                                                  AND (pv.n_provados = 0 OR pv.n_sem_prova > 0 OR pv.incompleto)),
           'vinculos', coalesce(jsonb_agg(jsonb_build_object(
                         -- referência OPACA e ESTÁVEL do par (sujeito, vinculado): não muda se outro vínculo
                         -- entrar na frente (a posição mudaria e o voto iria para o cliente errado).
                         'ref', left(md5(p_cnpj || '|' || pv.cliente_cnpj), 16),
                         'cliente_cnpj', CASE WHEN pv.no_radar OR p_ver_carteira THEN pv.cliente_cnpj END,
                         'cliente_nome', CASE WHEN pv.no_radar OR p_ver_carteira THEN pv.cliente_nome END,
                         'cliente_situacao', pv.cliente_situacao, 'forca', pv.forca, 'sinais', to_jsonb(pv.sinais),
                         -- parte das contas do vinculado não foi avaliada: o aviso vale, o total pode ser maior
                         'parcial', (pv.n_sem_prova > 0 OR pv.incompleto),
                         'credoras', pv.credoras,
                         '_cliente_cnpj_real', pv.cliente_cnpj) ORDER BY pv.ordem)
                         FILTER (WHERE pv.credoras IS NOT NULL), '[]'::jsonb))
    INTO v_out
    FROM por_vinculo pv;
  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION private.credito_vinculo_avaliar(text, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.credito_vinculo_aviso(p_cnpj text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_out jsonb;
BEGIN
  -- SECURITY DEFINER bypassa a RLS de profiles/fin_contas_receber ⇒ o gate vive AQUI, antes de qualquer retorno:
  -- staff, o mesmo recorte de venda_prazo_aviso.
  IF v_uid IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_uid AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'credito_vinculo_aviso: exige staff' USING ERRCODE = '42501';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido' USING ERRCODE = '22023';
  END IF;
  v_out := private.credito_vinculo_avaliar(p_cnpj, COALESCE(private.cap_carteira_ler(v_uid), false));
  -- O CNPJ real é só do sensor: nunca sai pela API.
  IF v_out ? 'vinculos' THEN
    v_out := jsonb_set(v_out, '{vinculos}',
               coalesce((SELECT jsonb_agg(x - '_cliente_cnpj_real' ORDER BY o)
                           FROM jsonb_array_elements(v_out -> 'vinculos') WITH ORDINALITY AS e(x, o)), '[]'::jsonb));
  END IF;
  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.credito_vinculo_aviso(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.credito_vinculo_aviso(text) TO authenticated, service_role;

-- ------------------------------------------------------------
-- 3. O SENSOR: único escritor de 'credito.vinculo_aviso_servido' e 'credito.vinculo_aviso_conferido' no outbox.
--    Não estende a allowlist de analytics_ledger_registrar (função quente, várias frentes): como
--    venda_prazo_decisao_registrar, este writer valida o conteúdo no SERVIDOR — staff, superfície, CNPJ, e que o
--    par (sujeito, ref opaco) é um aviso VIGENTE (UMA avaliação, com o CNPJ real) — e grava o CNPJ real do
--    vinculado nas props, mesmo quando a tela o oculta. A lente "Ver como" fica fora na FONTE (o front não chama sob a lente).
--    'servido': 1 por titular, superfície, sujeito e dia, com os pares exibidos e a versão da regra.
--    'conferido': TODO voto grava (a chave leva o instante) — o último por ocorrido_em é a resposta vigente.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.credito_vinculo_aviso_registrar(p_evento text, p_superficie text, p_cnpj text,
                                                                  p_ref text DEFAULT NULL, p_veredito text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_dia text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  v_aviso jsonb;
  v_vinc jsonb;
  v_chave text;
  v_props jsonb;
  v_n int;
BEGIN
  IF v_uid IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.user_roles ur
        WHERE ur.user_id = v_uid AND ur.role IN ('employee'::public.app_role, 'master'::public.app_role)) THEN
    RAISE EXCEPTION 'credito_vinculo_aviso_registrar: exige staff' USING ERRCODE = '42501';
  END IF;
  IF p_evento IS NULL OR p_evento NOT IN ('servido', 'conferido') THEN
    RAISE EXCEPTION 'credito_vinculo_aviso_registrar: evento inválido' USING ERRCODE = '22023';
  END IF;
  IF p_superficie IS NULL OR p_superficie NOT IN ('pedido', 'ficha_radar') THEN
    RAISE EXCEPTION 'credito_vinculo_aviso_registrar: superfície inválida' USING ERRCODE = '22023';
  END IF;
  IF p_cnpj IS NULL OR p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cnpj inválido' USING ERRCODE = '22023';
  END IF;
  IF p_evento = 'conferido'
     AND (p_ref IS NULL OR p_ref !~ '^[0-9a-f]{16}$'
          OR p_veredito IS NULL OR p_veredito NOT IN ('mesmo_grupo', 'sem_relacao', 'nao_confirmei')) THEN
    RAISE EXCEPTION 'credito_vinculo_aviso_registrar: conferência exige ref e veredito válido' USING ERRCODE = '22023';
  END IF;

  -- 'servido' já gravado hoje: sai ANTES da avaliação cara (~1 s); o ON CONFLICT segue como guarda concorrente.
  v_chave := 'credito_vinculo:' || v_uid::text || ':servido:' || p_superficie || ':' || p_cnpj || ':' || v_dia;
  IF p_evento = 'servido' AND EXISTS (SELECT 1 FROM public.analytics_outbox o WHERE o.chave_dedup = v_chave) THEN
    RETURN jsonb_build_object('registrado', false, 'motivo', 'ja_registrado');
  END IF;

  -- Teto por titular/dia (flood por voto repetido). Silencioso: telemetria nunca quebra a tela.
  SELECT count(*) INTO v_n FROM public.analytics_outbox
   WHERE user_id = v_uid AND evento LIKE 'credito.vinculo_aviso_%' AND ocorrido_em > now() - interval '1 day';
  IF v_n >= 200 THEN
    RETURN jsonb_build_object('registrado', false, 'motivo', 'teto');
  END IF;

  -- UMA avaliação (um snapshot), com o CNPJ real de cada par: só se registra o que a tela poderia mostrar AGORA.
  v_aviso := private.credito_vinculo_avaliar(p_cnpj, true);
  IF v_aviso ->> 'estado' IS DISTINCT FROM 'avaliado' OR jsonb_array_length(v_aviso -> 'vinculos') = 0 THEN
    RAISE EXCEPTION 'credito_vinculo_aviso_registrar: não há aviso vigente para este CNPJ' USING ERRCODE = '22023';
  END IF;

  IF p_evento = 'servido' THEN
    v_props := jsonb_build_object(
      'superficie', p_superficie, 'cnpj', p_cnpj, 'regra_versao', v_aviso -> 'regra_versao',
      'n_indeterminados', v_aviso -> 'n_indeterminados',
      'pares', (SELECT jsonb_agg(jsonb_build_object('ref', x -> 'ref', 'cliente_cnpj', x -> '_cliente_cnpj_real',
                                                    'forca', x -> 'forca',
                                                    'credoras', (SELECT jsonb_agg(c -> 'company') FROM jsonb_array_elements(x -> 'credoras') c)))
                  FROM jsonb_array_elements(v_aviso -> 'vinculos') x));
    INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup)
    VALUES ('credito.vinculo_aviso_servido', v_uid::text, v_uid, v_props, v_chave)
    ON CONFLICT (chave_dedup) DO NOTHING;
  ELSE
    SELECT x INTO v_vinc FROM jsonb_array_elements(v_aviso -> 'vinculos') x WHERE x ->> 'ref' = p_ref;
    IF v_vinc IS NULL THEN
      -- ref obsoleta (o par saiu do aviso): recusa — a tela recarrega; NUNCA reassocia a outro cliente.
      RAISE EXCEPTION 'credito_vinculo_aviso_registrar: ref % não é um vínculo vigente deste CNPJ', p_ref USING ERRCODE = '22023';
    END IF;
    v_props := jsonb_build_object(
      'superficie', p_superficie, 'cnpj', p_cnpj, 'ref', p_ref, 'cliente_cnpj', v_vinc -> '_cliente_cnpj_real',
      'veredito', p_veredito, 'forca', v_vinc -> 'forca', 'regra_versao', v_aviso -> 'regra_versao');
    v_chave := 'credito_vinculo:' || v_uid::text || ':conferido:' || p_superficie || ':' || p_cnpj || ':' || p_ref
               || ':' || to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS');
    INSERT INTO public.analytics_outbox (evento, distinct_id, user_id, props, chave_dedup)
    VALUES ('credito.vinculo_aviso_conferido', v_uid::text, v_uid, v_props, v_chave)
    ON CONFLICT (chave_dedup) DO NOTHING;
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('registrado', v_n = 1);
END;
$function$;

REVOKE ALL ON FUNCTION public.credito_vinculo_aviso_registrar(text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.credito_vinculo_aviso_registrar(text, text, text, text, text) TO authenticated;

-- ------------------------------------------------------------
-- PÓS: corpos, ACL, definer — a migration que não pegou aborta aqui, com o motivo.
-- ------------------------------------------------------------
DO $post$
DECLARE
  r record;
  v_av oid := to_regprocedure('public.credito_vinculo_aviso(text)')::oid;
  v_rg oid := to_regprocedure('public.credito_vinculo_aviso_registrar(text,text,text,text,text)')::oid;
BEGIN
  FOR r IN
    SELECT x.alvo, x.esperado,
           (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure(x.alvo)) AS vivo
      FROM (VALUES ('private.radar_vinculos_base(text[], boolean, boolean)',                   '91dc715bb76efc00b85c4b86964d50db'),
                   ('private.radar_vinculos_nucleo(text[], boolean)',                           'f345a864df438f0b7fba25bf50f6ea43'),
                   ('private.credito_vinculo_avaliar(text, boolean)',                           'afbc83bfdbe959be21486d19c818d051'),
                   ('public.credito_vinculo_aviso(text)',                                       'e7e4c97c787123c82c814f192db361a2'),
                   ('public.credito_vinculo_aviso_registrar(text, text, text, text, text)',     '9e0cfc8bc35dd5bc0784d0821b15918a'),
                   ('public.venda_prazo_aviso(text, bigint)',                                   'd2dda7d32d8a6acd34e24aa1cc1f4c96'),
                   ('public.radar_possiveis_vinculos(text)',                                    '2452f463ae9d97860a4514b81f30a3ea'),
                   ('public.radar_vinculos_por_cnpjs(text[])',                                  'a9278dd0c4e9fb025743caa438b9b130')) AS x(alvo, esperado)
  LOOP
    IF r.vivo IS DISTINCT FROM r.esperado THEN
      RAISE EXCEPTION 'A1 FALHOU: % vivo (md5 %) não é o corpo esperado por este arquivo', r.alvo, r.vivo;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'private.radar_vinculos_base(text[], boolean, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.radar_vinculos_base(text[], boolean, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.radar_vinculos_nucleo(text[], boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.radar_vinculos_nucleo(text[], boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.credito_vinculo_avaliar(text, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'private.credito_vinculo_avaliar(text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A2 FALHOU: base/núcleo/avaliação (sem gate) executável pelo JWT';
  END IF;
  IF has_function_privilege('anon', v_av, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_av, 'EXECUTE')
     OR has_function_privilege('anon', v_rg, 'EXECUTE') OR NOT has_function_privilege('authenticated', v_rg, 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: ACL do aviso/sensor errada (anon executa ou authenticated não executa)';
  END IF;
  IF NOT (SELECT bool_and(p.prosecdef) FROM pg_catalog.pg_proc p WHERE p.oid IN (v_av, v_rg)) THEN
    RAISE EXCEPTION 'A4 FALHOU: aviso/sensor sem SECURITY DEFINER — a base fechada, profiles e o outbox negariam';
  END IF;
  RAISE NOTICE 'crédito: aviso de vínculo com vencido (base+invólucro, RPC staff, sensor validado) — corpos e ACL provados';
END
$post$;
