-- ============================================================
-- clientes_nome_ordenacao — ordem A–Z de /admin/customers por um nome NORMALIZADO, não o cru.
--
-- Por quê: "Todos · A–Z" ordenava por profiles.name cru, e os nomes vindos do Omie são sujos.
-- Diagnóstico read-only na PROD (2026-11-21, 16.099 clientes não-funcionários):
--   * 1.969 começam pelo prefixo de MEI "NN.NNN.NNN " (raiz do CNPJ colada no nome) — enchiam as
--     ~20 primeiras páginas com "04.763.245 MARCO ANTONIO…", fora da letra do nome real;
--   *   420 têm entidade HTML (&amp; 363×, &apos; 64×): "&apos;JL ARTESANATO&apos;" abria a lista;
--   *     5 começam por símbolo (". ON ART", "(RR) MOVEIS", "+ PROJETOS");
--   *     6 têm espaço duplicado; 451 caixa mista; 11 com acento.
--   Os 35 restantes que começam por dígito são marcas reais ("3M DO BRASIL", "2R MARCENARIA") e
--   continuam sob o dígito — 0–9 antes de A–Z, como em qualquer lista.
--
-- Desenho:
--   * private.nome_ordenacao(text) IMMUTABLE: acentos via translate (2 caixas) → lower (a PROD não tem a
--     extensão unaccent, e unaccent() é só STABLE) → entidade HTML vira espaço → tira o prefixo
--     MEI → todo não-alfanumérico vira espaço → colapsa/apara. Só-lixo → NULL (vai pro fim).
--     O gêmeo TS (chaveOrdenacaoNome, src/lib/carteira/escopo-clientes.ts) segue as mesmas regras
--     para a carteira, que ordena em memória.
--   * listar_clientes_base passa a ordenar por essa chave (desempate name, user_id — estável) e a
--     DEVOLVÊ-LA na coluna nova `nome_ordenacao` (no FIM), para o `.order()` do cliente repetir as
--     mesmas chaves por cima da página. O nome EXIBIDO (name) não muda.
--   * Mudar o RETURNS TABLE exige DROP + CREATE (REPLACE não troca tipo de retorno) → o ACL
--     RESETA: o REVOKE é reemitido nomeando PUBLIC e anon.
--   * Sem coluna gerada em profiles (INSERT/UPSERT de linha inteira quebraria em coluna gerada) e
--     sem índice: o count(*) OVER () lê o recorte inteiro de qualquer jeito (~16 mil linhas), então
--     um índice não evitaria o sort — só custaria escrita em profiles.
--
-- Molde TRAVA → PRE → CREATE → PÓS (sql-house-style.md, "Recriar objeto VIVO").
-- Prova PG17: db/test-clientes-nome-ordenacao.sh (controle verde + falsificação na mesma invocação).
-- ============================================================

BEGIN;

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) prende a função até o COMMIT.
DO $trava$
BEGIN
  IF to_regprocedure('public.listar_clientes_base(text, text, text, integer, integer)') IS NOT NULL THEN
    ALTER FUNCTION public.listar_clientes_base(text, text, text, integer, integer) STABLE;
  END IF;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor revisado (20261121120001 = PROD 2026-11-21), este}.
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.listar_clientes_base(text, text, text, integer, integer)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('46eb4a002af03433488b875823ed3c74', '349c54644863629db8d7d34c0309dbe6') THEN
    RAISE EXCEPTION 'PRE FALHOU: listar_clientes_base viva (md5 %) nao e o predecessor revisado nem esta versao — outra sessao mexeu; reconcilie antes', v_vivo;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION private.nome_ordenacao(p_nome text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $f$
  SELECT nullif(
    pg_catalog.btrim(
      pg_catalog.regexp_replace(
        pg_catalog.regexp_replace(
          pg_catalog.regexp_replace(
            -- translate ANTES do lower e nas DUAS caixas: sob collation C o lower() não baixa
            -- não-ASCII ('Ô' ficaria) — assim a chave não depende do collation do banco.
            pg_catalog.lower(pg_catalog.translate(p_nome,
              'áàâãäåāéèêëēíìîïīóòôõöøōúùûüūçñýÿÁÀÂÃÄÅĀÉÈÊËĒÍÌÎÏĪÓÒÔÕÖØŌÚÙÛÜŪÇÑÝŸ',
              'aaaaaaaeeeeeiiiiiooooooouuuuucnyyaaaaaaaeeeeeiiiiiooooooouuuuucnyy')),
            '&(#[0-9]+|#x[0-9a-f]+|[a-z]+);', ' ', 'g'),
          '^[^a-z0-9]*[0-9]{2}\.[0-9]{3}\.[0-9]{3}[[:space:]]+', ''),
        '[^a-z0-9]+', ' ', 'g')),
    '')
$f$;

REVOKE ALL ON FUNCTION private.nome_ordenacao(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.nome_ordenacao(text) FROM anon;
GRANT EXECUTE ON FUNCTION private.nome_ordenacao(text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.nome_ordenacao(text) TO service_role;

DROP FUNCTION IF EXISTS public.listar_clientes_base(text, text, text, integer, integer);

CREATE FUNCTION public.listar_clientes_base(
  p_busca  text    DEFAULT NULL,
  p_saude  text    DEFAULT NULL,
  p_ordem  text    DEFAULT 'prioridade',
  p_limite integer DEFAULT 100,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  user_id uuid,
  name text,
  email text,
  phone text,
  document text,
  customer_type text,
  created_at timestamptz,
  requires_po boolean,
  prioridade_ordenacao numeric,
  total bigint,
  nome_ordenacao text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_saude text := nullif(btrim(coalesce(p_saude, '')), '');
  v_busca text := nullif(btrim(coalesce(p_busca, '')), '');
BEGIN
  IF v_saude = 'all' THEN v_saude := NULL; END IF;
  IF v_saude IS NOT NULL
     AND v_saude NOT IN ('saudavel', 'estavel', 'atencao', 'critico', 'sem_historico') THEN
    RAISE EXCEPTION 'listar_clientes_base: p_saude invalido (%)', v_saude USING ERRCODE = '22023';
  END IF;
  IF p_ordem IS NULL OR p_ordem NOT IN ('prioridade', 'nome') THEN
    RAISE EXCEPTION 'listar_clientes_base: p_ordem invalido (%)', p_ordem USING ERRCODE = '22023';
  END IF;
  IF p_limite IS NULL OR p_limite < 1 OR p_limite > 500 THEN
    RAISE EXCEPTION 'listar_clientes_base: p_limite fora de 1..500 (%)', p_limite USING ERRCODE = '22023';
  END IF;
  IF p_offset IS NULL OR p_offset < 0 THEN
    RAISE EXCEPTION 'listar_clientes_base: p_offset negativo (%)', p_offset USING ERRCODE = '22023';
  END IF;

  -- Aliases próprios (uid/nome/…) no CTE: as colunas de saída do RETURNS TABLE são variáveis
  -- plpgsql e colidiriam com p.user_id/p.name (42702 só em RUNTIME — late-bound).
  RETURN QUERY
  WITH recorte AS (
    SELECT
      p.user_id AS uid, p.name AS nome, p.email AS mail, p.phone AS fone, p.document AS doc,
      p.customer_type AS tipo, p.created_at AS criado, p.requires_po AS exige_po,
      CASE WHEN s.sales_history_status = 'sem_historico' THEN NULL ELSE s.priority_score END AS prio,
      private.nome_ordenacao(p.name) AS nome_ord
    FROM public.profiles p
    LEFT JOIN public.farmer_client_scores s ON s.customer_user_id = p.user_id
    WHERE p.is_employee = false
      -- v_busca decide se HÁ busca; o padrão escapado vem do helper (IMMUTABLE: avaliado 1x).
      -- Termo sem conteúdo útil → padrão NULL → ILIKE NULL → nenhuma linha (não "sem filtro").
      AND (v_busca IS NULL
           OR p.name     ILIKE private.padrao_like_contem(v_busca) ESCAPE '\'
           OR p.email    ILIKE private.padrao_like_contem(v_busca) ESCAPE '\'
           OR p.document ILIKE private.padrao_like_contem(v_busca) ESCAPE '\'
           OR p.phone    ILIKE private.padrao_like_contem(v_busca) ESCAPE '\')
      AND (v_saude IS NULL
           OR (v_saude = 'sem_historico' AND s.sales_history_status = 'sem_historico')
           OR (v_saude <> 'sem_historico'
               AND s.health_class = v_saude
               AND s.sales_history_status IS DISTINCT FROM 'sem_historico'))
  )
  -- prioridade_ordenacao = a chave de prioridade DESTA ordenação: NULL na ordem 'nome', para o
  -- `.order()` estável do cliente (mesmas chaves, por cima) não re-ordenar a página A–Z.
  -- nome_ordenacao = a chave de nome (normalizada), devolvida pelo mesmo motivo.
  SELECT r.uid, r.nome, r.mail, r.fone, r.doc, r.tipo, r.criado, r.exige_po,
         CASE WHEN p_ordem = 'prioridade' THEN r.prio END, count(*) OVER (), r.nome_ord
  FROM recorte r
  ORDER BY
    CASE WHEN p_ordem = 'prioridade' THEN r.prio END DESC NULLS LAST,
    r.nome_ord NULLS LAST,
    r.nome,
    r.uid
  LIMIT p_limite OFFSET p_offset;
END
$fn$;

-- ACL: DROP+CREATE resetou — as DUAS pontas (PUBLIC e anon), nomeando as roles.
REVOKE ALL ON FUNCTION public.listar_clientes_base(text, text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.listar_clientes_base(text, text, text, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.listar_clientes_base(text, text, text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.listar_clientes_base(text, text, text, integer, integer) TO service_role;

DO $post$
DECLARE
  v_oid  regprocedure := to_regprocedure('public.listar_clientes_base(text, text, text, integer, integer)');
  v_norm regprocedure := to_regprocedure('private.nome_ordenacao(text)');
  r record;
BEGIN
  IF v_norm IS NULL OR (SELECT provolatile FROM pg_proc WHERE oid = v_norm) <> 'i' THEN
    RAISE EXCEPTION 'A1 FALHOU: private.nome_ordenacao ausente ou nao IMMUTABLE';
  END IF;
  -- comportamento, não só existência: os casos reais do diagnóstico
  FOR r IN SELECT * FROM (VALUES
      ('04.763.245 MARCO ANTÔNIO  DE OLIVEIRA', 'marco antonio de oliveira'),
      ('&apos;PALLET&apos;S EMBALAR&apos;',     'pallet s embalar'),
      ('S &amp; A GRANITOS',                    's a granitos'),
      ('. ON ART E DESIGN',                     'on art e design'),
      ('3M DO BRASIL LTDA',                     '3m do brasil ltda'),
      ('+++',                                   NULL)
    ) AS t(entrada, esperado)
  LOOP
    IF private.nome_ordenacao(r.entrada) IS DISTINCT FROM r.esperado THEN
      RAISE EXCEPTION 'A2 FALHOU: nome_ordenacao(%) = %, esperado %', r.entrada, private.nome_ordenacao(r.entrada), r.esperado;
    END IF;
  END LOOP;
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'A3 FALHOU: listar_clientes_base ausente — a tela /admin/customers (base) quebra';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_oid) THEN
    RAISE EXCEPTION 'A4 FALHOU: listar_clientes_base virou SECURITY DEFINER — bypassaria a RLS de profiles/scores';
  END IF;
  IF NOT ('nome_ordenacao' = ANY (SELECT unnest(proargnames) FROM pg_proc WHERE oid = v_oid)) THEN
    RAISE EXCEPTION 'A5 FALHOU: listar_clientes_base nao devolve nome_ordenacao — o .order() do cliente da 400';
  END IF;
  IF has_function_privilege('anon', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_norm, 'EXECUTE') THEN
    RAISE EXCEPTION 'A6 FALHOU: anon executa listar_clientes_base/nome_ordenacao (REVOKE de PUBLIC/anon nao pegou)';
  END IF;
  IF NOT has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_norm, 'EXECUTE') THEN
    RAISE EXCEPTION 'A7 FALHOU: authenticated sem EXECUTE — a tela recebe 42501';
  END IF;
  RAISE NOTICE 'clientes_nome_ordenacao OK: chave normalizada, invoker, anon fechado, authenticated aberto';
END
$post$;

NOTIFY pgrst, 'reload schema';

COMMIT;
