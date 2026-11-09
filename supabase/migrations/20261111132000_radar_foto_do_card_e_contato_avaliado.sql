-- =============================================================================
-- Radar (pacote K2): card/e-mail seguem a foto durante a publicação em passos, e "não é contabilidade" só vale
-- para o contato que o cálculo leu.
-- =============================================================================
-- 3ª revisão do Radar (Codex + Fable), confirmada no código e na PROD (psql-ro, 2026-11-09):
--
-- 1) private.radar_leads_do_vendedor recortava a foto por `ultimo_lote = vigente`. A publicação em passos
--    (20261111120000) reetiqueta `ultimo_lote` para o lote P e guarda `lote_anterior`; durante a publicação de um
--    mês novo os leads já reetiquetados SUMIAM do card (radar_prospectar_hoje) e do e-mail semanal
--    (radar_avisar_vendedores). Agora o predicado é o da radar_lista:
--      foto de V = ultimo_lote = ANY(ARRAY[V, P]) AND (ultimo_lote = V OR lote_anterior = V)
--    e, sem lote completo, a empresa que só existe em P fica de fora (não é de foto nenhuma).
--
-- 2) private.radar_contato_contabil_avaliar respondia "não é contabilidade" (false) para QUALQUER contato sem
--    marca, desde que o estado global existisse. Depois de uma carga que troca telefone/e-mail, o número novo
--    nunca avaliado saía como "não é" até o recálculo do dia seguinte. Ausente ≠ zero: o "não é" só vale se a
--    linha da empresa não foi escrita depois do cálculo (radar_empresas.updated_at <= estado.calculado_em). A
--    premissa foi MEDIDA: sem trigger de touch, score/recruzamento/posses não gravam updated_at, o último escritor
--    diário é o das 06:05 e o recálculo roda 06:50 — às 09:10 de 2026-11-09, 0 de 573.021 linhas depois do cálculo.
--    A marca positiva (true) segue casando pelo VALOR exato; correção manual prevalece como antes.
--
-- Molde TRAVA → PRE → CREATE → PÓS (as duas são STABLE, SECURITY DEFINER, search_path ''; ACL só do owner).
-- Prova PG17: db/test-radar-k2-foto-e-contato.sh. Cópia sem envelope para o db:aplicar:
-- db/2026-11-09-radar-foto-do-card-e-contato-avaliado.sql.
-- =============================================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) em cada função que a PRE guarda e este arquivo recria.
DO $trava$
BEGIN
  IF to_regprocedure('private.radar_leads_do_vendedor(uuid,integer,timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz) STABLE;
  END IF;
  IF to_regprocedure('private.radar_contato_contabil_avaliar(text,text,text,text)') IS NOT NULL THEN
    ALTER FUNCTION private.radar_contato_contabil_avaliar(text, text, text, text) STABLE;
  END IF;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor de PROD (psql-ro 2026-11-09), este}. Ausente ABORTA; a dependência
-- nova (radar_lote_publicando, lote_anterior) tem de existir.
DO $pre$
DECLARE
  r record;
BEGIN
  IF to_regprocedure('public.radar_lote_publicando()') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: public.radar_lote_publicando() ausente — aplique 20261111120000 antes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                    AND table_name = 'radar_empresas' AND column_name = 'lote_anterior') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_empresas.lote_anterior ausente — aplique 20261111120000 antes';
  END IF;
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('radar_leads_do_vendedor',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('private.radar_leads_do_vendedor(uuid,integer,timestamptz)')),
         '6e9fe43f4c40740727ed0c4559a37366', '52e1543d1a79e54dbe1b794ad8765fb8'),
        ('radar_contato_contabil_avaliar',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
           WHERE p.oid = to_regprocedure('private.radar_contato_contabil_avaliar(text,text,text,text)')),
         '11b8ee508e61874e909891cd8a133842', '9d21d6edae10cb972feb756465104eb1')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

CREATE OR REPLACE FUNCTION private.radar_leads_do_vendedor(p_vendedor uuid, p_n integer, p_agora timestamp with time zone DEFAULT now())
 RETURNS TABLE(posicao integer, cnpj text, razao_social text, nome_fantasia text, municipio_codigo text, municipio_nome text, uf text, score smallint, score_motivos text[], elegiveis integer, atribuido boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH par AS (
    SELECT date_trunc('week', p_agora AT TIME ZONE 'America/Sao_Paulo')::date AS semana,
           p_agora - interval '90 days' AS desde,
           (p_agora AT TIME ZONE 'America/Sao_Paulo')::date AS hoje,
           -- E1: a foto vigente é o maior lote COMPLETO (running/error no meio não é foto). Sem lote completo não
           -- recorta, como a fila (src/lib/radar/lote-vigente.ts: null é "não sei", nunca "zero").
           (SELECT s.mes_referencia FROM public.radar_ingest_state s
             WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1) AS lote,
           -- K2: lote P em publicação em passos (20261111120000). Até a virada a foto de V é o rótulo V intocado
           -- MAIS o rótulo P vindo de V (lote_anterior = V) — o MESMO predicado da radar_lista. Sem isto, durante a
           -- publicação de um mês novo os leads já reetiquetados para P sumiam do card e do e-mail.
           public.radar_lote_publicando() AS pub
  ),
  terr AS (
    SELECT t.municipio_codigo, t.clientes, t.compartilhado FROM private.radar_territorio_do_vendedor(p_vendedor, 3) t
  ),
  -- G2: em acompanhamento (em conversa / não atendeu). Com responsável, a raiz inteira sai dos leads novos (o
  -- compromisso é de alguém); sem responsável com acesso e com o retorno vencido, o CNPJ volta à distribuição.
  acomp AS (
    SELECT ac.cnpj, ac.raiz, ac.responsavel, ac.retorno_em FROM private.radar_acompanhamentos(p_agora) ac
  ),
  -- E4: lead que o gestor passou a este vendedor e cuja posse segue ativa no relógio de p_agora.
  atrib AS (
    SELECT a.cnpj FROM public.radar_atendimentos a
     WHERE a.dono_user_id = p_vendedor
       AND a.atribuido_por IS NOT NULL
       AND a.encerrado_em IS NULL
       AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora
  ),
  -- Os filtros estáticos ficam DENTRO de cada ramo (o do território casa com o índice parcial idx_radar_muni).
  -- São os mesmos nos ramos: ja_cliente, status, score, RFB, foto vigente (E1, com a publicação em passos: K2) e
  -- contato (E1).
  alvo AS (
    SELECT re.cnpj, re.razao_social, re.nome_fantasia, re.municipio_codigo, re.municipio_nome, re.uf,
           re.score, re.score_motivos, t.clientes, t.compartilhado, false AS atribuido
      FROM terr t
      JOIN public.radar_empresas re ON re.municipio_codigo = t.municipio_codigo
      CROSS JOIN par
     WHERE re.ja_cliente = false
       AND re.prospeccao_status = 'a_contatar'
       AND re.score IS NOT NULL
       AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))
       AND (CASE WHEN par.lote IS NULL
                 THEN par.pub IS NULL OR NOT (re.ultimo_lote IS NOT DISTINCT FROM par.pub AND re.lote_anterior IS NULL)
                 ELSE re.ultimo_lote = ANY (ARRAY[par.lote, par.pub])
                      AND (re.ultimo_lote = par.lote OR re.lote_anterior = par.lote) END)
       AND (NULLIF(btrim(re.telefone1), '') IS NOT NULL OR NULLIF(btrim(re.telefone2), '') IS NOT NULL
            OR NULLIF(btrim(re.email), '') IS NOT NULL)
    UNION ALL
    SELECT re.cnpj, re.razao_social, re.nome_fantasia, re.municipio_codigo, re.municipio_nome, re.uf,
           re.score, re.score_motivos, 0, false, true
      FROM atrib ab
      JOIN public.radar_empresas re ON re.cnpj = ab.cnpj
      CROSS JOIN par
     WHERE re.ja_cliente = false
       AND re.prospeccao_status = 'a_contatar'
       AND re.score IS NOT NULL
       AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))
       AND (CASE WHEN par.lote IS NULL
                 THEN par.pub IS NULL OR NOT (re.ultimo_lote IS NOT DISTINCT FROM par.pub AND re.lote_anterior IS NULL)
                 ELSE re.ultimo_lote = ANY (ARRAY[par.lote, par.pub])
                      AND (re.ultimo_lote = par.lote OR re.lote_anterior = par.lote) END)
       AND (NULLIF(btrim(re.telefone1), '') IS NOT NULL OR NULLIF(btrim(re.telefone2), '') IS NOT NULL
            OR NULLIF(btrim(re.email), '') IS NOT NULL)
    UNION ALL
    -- G2: acompanhamento órfão (autor sem acesso, sem posse ativa) com retorno vencido, no território.
    SELECT re.cnpj, re.razao_social, re.nome_fantasia, re.municipio_codigo, re.municipio_nome, re.uf,
           re.score, re.score_motivos, t.clientes, t.compartilhado, false
      FROM acomp o
      JOIN public.radar_empresas re ON re.cnpj = o.cnpj
      JOIN terr t ON t.municipio_codigo = re.municipio_codigo
      CROSS JOIN par
     WHERE o.responsavel IS NULL
       AND o.retorno_em <= par.hoje
       AND re.score IS NOT NULL
       AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))
       AND (CASE WHEN par.lote IS NULL
                 THEN par.pub IS NULL OR NOT (re.ultimo_lote IS NOT DISTINCT FROM par.pub AND re.lote_anterior IS NULL)
                 ELSE re.ultimo_lote = ANY (ARRAY[par.lote, par.pub])
                      AND (re.ultimo_lote = par.lote OR re.lote_anterior = par.lote) END)
       AND (NULLIF(btrim(re.telefone1), '') IS NOT NULL OR NULLIF(btrim(re.telefone2), '') IS NOT NULL
            OR NULLIF(btrim(re.email), '') IS NOT NULL)
  ),
  -- Atribuído no território aparece uma vez só, como atribuído.
  um_por_cnpj AS (
    SELECT DISTINCT ON (a.cnpj) a.*, left(a.cnpj, 8) AS raiz
      FROM alvo a
     ORDER BY a.cnpj, a.atribuido DESC, a.compartilhado, a.clientes DESC
  ),
  universo AS (
    SELECT u.*
      FROM um_por_cnpj u
      CROSS JOIN par
     WHERE NOT EXISTS (
             -- posse ativa: de OUTRO vendedor com acesso (como antes) ou do PRÓPRIO quando ele mesmo assumiu (E3);
             -- a do próprio que veio do gestor é justamente o E4 e fica.
             SELECT 1 FROM public.radar_atendimentos a
              WHERE a.cnpj = u.cnpj
                AND a.encerrado_em IS NULL
                AND ((a.dono_user_id <> p_vendedor AND private.cap_radar_prospectar(a.dono_user_id))
                     OR (a.dono_user_id = p_vendedor AND a.atribuido_por IS NULL))
                AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora)
       AND NOT EXISTS (
             -- G2: a empresa (raiz) está em acompanhamento de alguém: nenhuma filial dela entra como lead novo.
             SELECT 1 FROM acomp ac WHERE ac.raiz = u.raiz AND ac.responsavel IS NOT NULL)
       AND NOT EXISTS (
             -- E2: só e-mail ENTREGUE queima, e só os de semana ANTERIOR (os desta semana seguem no card).
             -- E6: no município COMPARTILHADO, o de OUTRO vendedor (na fila ou entregue) também tira o lead: o
             -- fallback não repete o dono. No território próprio, não: o dono nunca perde lead para o fallback.
             -- O atribuído pelo gestor vem com compartilhado = false. Envio de teste nunca conta.
             SELECT 1 FROM public.radar_email_vendedor_leads l
               JOIN public.radar_email_vendedor_envios e ON e.id = l.envio_id
               JOIN public.fornecedor_alerta fa ON fa.id = e.alerta_id
              WHERE left(l.cnpj, 8) = u.raiz
                AND e.eh_teste = false
                AND e.criado_em >= par.desde
                AND ((e.vendedor_user_id = p_vendedor AND fa.status = 'notificado' AND e.semana < par.semana)
                     OR (e.vendedor_user_id <> p_vendedor AND u.compartilhado
                         AND fa.status IN ('notificado', 'pendente_notificacao'))))
  ),
  -- Uma empresa por raiz de CNPJ (a filial de maior score): em prod o top-5 da Regina trazia a mesma metalúrgica 4 vezes.
  por_raiz AS (
    SELECT DISTINCT ON (u.raiz) u.*
      FROM universo u
     ORDER BY u.raiz, u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj
  )
  SELECT (row_number() OVER (ORDER BY u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj))::integer,
         u.cnpj, u.razao_social, u.nome_fantasia, u.municipio_codigo, u.municipio_nome, u.uf,
         u.score, u.score_motivos, (count(*) OVER ())::integer, u.atribuido
    FROM por_raiz u
   ORDER BY u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj
   LIMIT GREATEST(1, LEAST(COALESCE(p_n, 5), 5));
$function$
;

CREATE OR REPLACE FUNCTION private.radar_contato_contabil_avaliar(p_cnpj text, p_tel1 text, p_tel2 text, p_email text)
 RETURNS TABLE(campo text, tipo text, valor text, automatico boolean, motivos text[], grupos integer, corroborado boolean, correcao_id bigint, veredito boolean, efetivo boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH c AS (
    SELECT v.ordem, v.campo, v.tipo, v.valor
      FROM (VALUES (1, 'telefone1', 'telefone', private.radar_tel_valor(p_tel1)),
                   (2, 'telefone2', 'telefone', private.radar_tel_valor(p_tel2)),
                   (3, 'email', 'email', private.radar_email_valor(p_email))) AS v(ordem, campo, tipo, valor)
     WHERE v.valor IS NOT NULL
  ), est AS (
    -- Nunca calculado = "não sei" (NULL), nunca "não é" (false): ausente ≠ zero. K2: e o "não é" só vale para o
    -- contato que o cálculo LEU. Linha de radar_empresas escrita depois do cálculo (a publicação de um mês novo
    -- troca telefone/e-mail e grava updated_at) = "não sei" até o próximo recálculo (cron 06:50 UTC, depois de
    -- todo escritor diário). Sem linha da empresa, também "não sei".
    SELECT coalesce(s.calculado_em IS NOT NULL
                    AND (SELECT e.updated_at FROM public.radar_empresas e WHERE e.cnpj = p_cnpj) <= s.calculado_em,
                    false) AS calculado
      FROM (SELECT (SELECT s2.calculado_em FROM public.radar_contato_contabil_estado s2 WHERE s2.id) AS calculado_em) s
  )
  SELECT c.campo, c.tipo, c.valor,
         CASE WHEN a.cnpj IS NOT NULL THEN true WHEN est.calculado THEN false END,
         a.motivos, a.grupos, a.corroborado, r.id, r.veredito,
         CASE WHEN r.veredito IS NOT NULL THEN r.veredito
              WHEN a.cnpj IS NOT NULL THEN true
              WHEN est.calculado THEN false END
    FROM c
    CROSS JOIN est
    LEFT JOIN public.radar_contato_contabil a ON a.cnpj = p_cnpj AND a.tipo = c.tipo AND a.valor = c.valor
    LEFT JOIN LATERAL (SELECT k.id, k.veredito FROM public.radar_contato_contabil_correcoes k
                        WHERE k.cnpj = p_cnpj AND k.tipo = c.tipo AND k.valor = c.valor
                        ORDER BY k.id DESC LIMIT 1) r ON true
   ORDER BY c.ordem
$function$
;

-- PÓS: os corpos vivos são ESTES, com os atributos e a ACL de antes (CREATE OR REPLACE preserva o ACL; conferido).
DO $post$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, p.oid, md5(p.prosrc) AS vivo, x.este, p.provolatile, p.prosecdef, p.proconfig
      FROM (VALUES
        ('private.radar_leads_do_vendedor(uuid,integer,timestamptz)', '52e1543d1a79e54dbe1b794ad8765fb8'),
        ('private.radar_contato_contabil_avaliar(text,text,text,text)', '9d21d6edae10cb972feb756465104eb1')
      ) AS x(alvo, este)
      LEFT JOIN pg_catalog.pg_proc p ON p.oid = to_regprocedure(x.alvo)
  LOOP
    IF r.oid IS NULL OR r.vivo IS DISTINCT FROM r.este THEN
      RAISE EXCEPTION 'P1_FALHOU: % vivo (md5 %) não é este (%)', r.alvo, r.vivo, r.este;
    END IF;
    IF r.provolatile IS DISTINCT FROM 's' OR r.prosecdef IS NOT TRUE OR r.proconfig IS DISTINCT FROM ARRAY['search_path=""'] THEN
      RAISE EXCEPTION 'P2_FALHOU: % perdeu STABLE/SECURITY DEFINER/search_path vazio', r.alvo;
    END IF;
    IF has_function_privilege('anon', r.oid, 'EXECUTE') OR has_function_privilege('authenticated', r.oid, 'EXECUTE')
       OR has_function_privilege('public', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'P3_FALHOU: % executável por PUBLIC/anon/authenticated — a interna abriu', r.alvo;
    END IF;
  END LOOP;
  RAISE NOTICE 'K2 ok: leads do vendedor com a foto da publicação em passos; contato não avaliado = não sei';
END
$post$;

COMMIT;
