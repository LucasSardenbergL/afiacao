-- Corpos de PRODUÇÃO (pg_get_functiondef via psql-ro, 2026-11-09 09:10 UTC) que a migration
-- 20261111132000_radar_foto_do_card_e_contato_avaliado recria ou de que ela depende. Verbatim: o md5(prosrc)
-- de radar_leads_do_vendedor (6e9fe43f…) e de radar_contato_contabil_avaliar (11b8ee50…) é o 'predecessor' da PRE.
-- Usada por db/test-radar-k2-foto-e-contato.sh.

-- radar_tel_valor
CREATE OR REPLACE FUNCTION private.radar_tel_valor(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  -- Só dígitos, sem 55 e sem zero à esquerda; 10 ou 11 dígitos; número de um dígito só (00000000, 99999999) é lixo.
  SELECT CASE WHEN length(d) IN (10, 11) AND right(d, 8) !~ '^(.)\1{7}$' THEN d END
    FROM (SELECT CASE WHEN length(x) IN (12, 13) AND left(x, 2) = '55' THEN substr(x, 3) ELSE x END AS d
            FROM (SELECT ltrim(regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g'), '0') AS x) a) b
$function$

;

-- radar_email_valor
CREATE OR REPLACE FUNCTION private.radar_email_valor(p text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT CASE WHEN v ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' THEN v END
    FROM (SELECT lower(btrim(p)) AS v) a
$function$

;

-- radar_lote_publicando
CREATE OR REPLACE FUNCTION public.radar_lote_publicando()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.mes_referencia
    FROM public.radar_ingest_state s
   WHERE s.carga_fase = 'validada'
     AND s.carga_publicacao_iniciada_em IS NOT NULL
     AND s.mes_referencia > COALESCE((SELECT max(c.mes_referencia) FROM public.radar_ingest_state c
                                       WHERE c.status = 'complete'), '')
   ORDER BY s.mes_referencia
   LIMIT 1
$function$

;

-- radar_contato_contabil_avaliar
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
    -- Nunca calculado = "não sei" (NULL), nunca "não é" (false): ausente ≠ zero.
    SELECT EXISTS (SELECT 1 FROM public.radar_contato_contabil_estado s WHERE s.id) AS calculado
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

-- radar_leads_do_vendedor
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
             WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1) AS lote
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
  -- São os mesmos nos ramos: ja_cliente, status, score, RFB, foto vigente (E1) e contato (E1).
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
       AND (par.lote IS NULL OR re.ultimo_lote = par.lote)
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
       AND (par.lote IS NULL OR re.ultimo_lote = par.lote)
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
       AND (par.lote IS NULL OR re.ultimo_lote = par.lote)
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

-- ACL de PROD: as internas só do owner.
REVOKE ALL ON FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.radar_contato_contabil_avaliar(text, text, text, text) FROM PUBLIC;
