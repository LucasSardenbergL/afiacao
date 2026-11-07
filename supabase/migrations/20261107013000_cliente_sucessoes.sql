-- Sucessão DECLARADA entre clientes (Radar, entrega 2 do "sucessor declarado"; desenho aprovado pelo founder em
-- 2026-11-06, revisado pelo Codex -r max: 9 P1, nenhum P0).
--
-- Caso real: MARQUES PLANEJADOS LTDA (CNPJ 69491768000101, aberto em 06/10/2026) é CISÃO do cliente DIVIMOVEIS
-- (03166577000166): os filhos do dono abriram a empresa nova e o pai segue. O founder quer DECLARAR esse fato na
-- ficha do lead para que, na entrega 3, o histórico de compras da antiga possa ser rateado entre as duas.
--
-- O que esta migration cria (e o que ela NÃO faz):
--   1. `public.cliente_sucessoes` — o fato humano, DIRIGIDO (antigo → novo), por CNPJ completo. 1 antiga → N novas
--      agrupadas por `evento_id` (1 evento ativo por antiga). Revogar é auditado: sem DELETE, e o único UPDATE
--      permitido é a transição para revogada (trigger). RLS ligada e tabela fechada ao JWT.
--   2. `private.cliente_sucessoes_grafo` — a versão OTIMISTA do grafo (um contador). Toda escrita trava o grafo
--      inteiro (advisory xact lock comum) ANTES de validar, confere a versão e a incrementa: duas declarações
--      concorrentes A→B × B→A não passam as duas pelo teste de cadeia.
--   3. `private.cliente_resolver_documento(doc)` — CNPJ → UMA identidade canônica (`profiles` + `customer_canonical_alias`).
--      0 candidatos = não é cliente; >1 = ambíguo (bloqueia).
--   4. `private.cliente_sucessoes_vigentes(hoje)` — as declarações ativas com os dois extremos resolvidos e o ESTADO
--      (`ativa` só com o novo cadastrado, resolução inequívoca e corte já alcançado). A entrega 3 herda daqui.
--   5. RPCs: `cliente_declarar_sucessao`, `cliente_revogar_sucessao` (só gestor/master = pode_ver_carteira_completa),
--      `cliente_sucessao_previa` (prévia dos pedidos dos dois lados em volta do corte — contagens e datas, SEM valor;
--      só gestor/master) e `cliente_sucessoes_do_documento` (o selo; lê com cap_radar_prospectar ou gestor).
--   NÃO marca `radar_empresas.ja_cliente`, NÃO entra no `radar_recruzar_ja_cliente`, NÃO toca pedido, histórico,
--   preço, repasse, margem nem crédito. Herança transitiva (A→B→C) é RECUSADA na v1.
--
-- Data de corte = data COMERCIAL (a abertura na Receita é só sugestão, guardada em `data_corte_sugerida`). O dia do
-- pedido segue EXATAMENTE o fallback de `private.venda_linhas_pedido`: COALESCE(order_date_kpi, created_at em
-- America/Sao_Paulo); a prévia marca as datas estimadas (sem order_date_kpi).
--
-- Idempotente (re-rodar não duplica tabela, índice, trigger nem ACL). Transacional pelo SQL Editor.

-- ── PRE: a base que esta migration pressupõe (medida em prod via psql-ro em 2026-11-07) ──────────────────────
DO $pre$
BEGIN
  IF to_regprocedure('public.pode_ver_carteira_completa(uuid)') IS NULL
     OR to_regprocedure('private.cap_radar_prospectar(uuid)') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.customer_canonical_alias') IS NULL
     OR to_regclass('public.radar_empresas') IS NULL
     OR to_regclass('public.sales_orders') IS NULL
     OR to_regclass('public.order_items') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: falta a base (capabilities, profiles, alias canônico, radar_empresas, pedidos)';
  END IF;
END
$pre$;

-- ── 1. O fato declarado ──────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cliente_sucessoes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  evento_id           uuid NOT NULL,
  antigo_documento    text NOT NULL,
  novo_documento      text NOT NULL,
  tipo                text NOT NULL,
  data_corte          date NOT NULL,
  data_corte_sugerida date,
  observacao          text,
  declarado_por       uuid NOT NULL,
  declarado_em        timestamptz NOT NULL DEFAULT now(),
  revogado_em         timestamptz,
  revogado_por        uuid,
  revogado_motivo     text,
  CONSTRAINT cliente_sucessoes_doc_chk
    CHECK (antigo_documento ~ '^[0-9A-Z]{12}[0-9]{2}$' AND novo_documento ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  CONSTRAINT cliente_sucessoes_distintos_chk CHECK (antigo_documento <> novo_documento),
  CONSTRAINT cliente_sucessoes_tipo_chk CHECK (tipo IN ('cisao', 'sucessao')),
  CONSTRAINT cliente_sucessoes_revogacao_chk CHECK (
    (revogado_em IS NULL AND revogado_por IS NULL AND revogado_motivo IS NULL)
    -- `revogado_motivo IS NOT NULL` explícito: length(btrim(NULL)) > 0 é NULL, e CHECK aceita NULL.
    OR (revogado_em IS NOT NULL AND revogado_por IS NOT NULL AND revogado_motivo IS NOT NULL
        AND length(btrim(revogado_motivo)) > 0))
);
COMMENT ON TABLE public.cliente_sucessoes IS
  'Sucessão/cisão DECLARADA por gestor/master: o CNPJ novo sucede (sucessao) ou cinde de (cisao) o antigo a partir da '
  'data de corte COMERCIAL. Dirigida, auditada (sem DELETE; revogar preenche revogado_*). Escritores: '
  'public.cliente_declarar_sucessao / public.cliente_revogar_sucessao. Não reescreve pedido nem histórico.';

CREATE UNIQUE INDEX IF NOT EXISTS cliente_sucessoes_par_ativo_uq
  ON public.cliente_sucessoes (antigo_documento, novo_documento) WHERE revogado_em IS NULL;
CREATE INDEX IF NOT EXISTS cliente_sucessoes_novo_ativo_idx
  ON public.cliente_sucessoes (novo_documento) WHERE revogado_em IS NULL;
CREATE INDEX IF NOT EXISTS cliente_sucessoes_evento_idx ON public.cliente_sucessoes (evento_id);

ALTER TABLE public.cliente_sucessoes ENABLE ROW LEVEL SECURITY;
-- Escrita SÓ pelas RPCs (que travam o grafo, conferem a versão e aplicam as regras): nem o service_role
-- escreve direto — ele só LÊ (a entrega 3 lê pelas funções privadas).
REVOKE ALL ON TABLE public.cliente_sucessoes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.cliente_sucessoes TO service_role;

-- Auditoria + porta: sem DELETE/TRUNCATE; INSERT/UPDATE só com a porta que as RPCs abrem na própria transação
-- (`cliente_sucessoes.porta` = 'rpc', local) — o dono da tabela (SQL Editor) também não escreve por fora. A porta
-- é PROTOCOLO, não cofre: quem é dono pode abri-la; por isso `vigentes` revalida o grafo na leitura (fail-closed).
-- O único UPDATE é ativa → revogada (com quem e por quê), sem mexer no resto da linha; INSERT nasce ativa.
CREATE OR REPLACE FUNCTION private.cliente_sucessoes_imutavel()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'cliente_sucessoes: sem DELETE (revogue a declaração)' USING ERRCODE = '23001';
  END IF;
  IF current_setting('cliente_sucessoes.porta', true) IS DISTINCT FROM 'rpc' THEN
    RAISE EXCEPTION 'cliente_sucessoes: escrita fora das RPCs (declarar/revogar)' USING ERRCODE = '23001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.revogado_em IS NOT NULL OR NEW.revogado_por IS NOT NULL OR NEW.revogado_motivo IS NOT NULL THEN
      RAISE EXCEPTION 'cliente_sucessoes: a declaração nasce ativa' USING ERRCODE = '23001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.revogado_em IS NOT NULL
     OR NEW.revogado_em IS NULL
     OR NEW.revogado_por IS NULL
     OR NEW.revogado_motivo IS NULL OR length(btrim(NEW.revogado_motivo)) = 0
     OR (NEW.id, NEW.evento_id, NEW.antigo_documento, NEW.novo_documento, NEW.tipo, NEW.data_corte,
         NEW.data_corte_sugerida, NEW.observacao, NEW.declarado_por, NEW.declarado_em)
        IS DISTINCT FROM
        (OLD.id, OLD.evento_id, OLD.antigo_documento, OLD.novo_documento, OLD.tipo, OLD.data_corte,
         OLD.data_corte_sugerida, OLD.observacao, OLD.declarado_por, OLD.declarado_em) THEN
    RAISE EXCEPTION 'cliente_sucessoes: só a revogação altera uma declaração' USING ERRCODE = '23001';
  END IF;
  RETURN NEW;
END
$function$;
REVOKE ALL ON FUNCTION private.cliente_sucessoes_imutavel() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS cliente_sucessoes_imutavel_trg ON public.cliente_sucessoes;
CREATE TRIGGER cliente_sucessoes_imutavel_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.cliente_sucessoes
  FOR EACH ROW EXECUTE FUNCTION private.cliente_sucessoes_imutavel();
DROP TRIGGER IF EXISTS cliente_sucessoes_sem_truncate_trg ON public.cliente_sucessoes;
CREATE TRIGGER cliente_sucessoes_sem_truncate_trg
  BEFORE TRUNCATE ON public.cliente_sucessoes
  FOR EACH STATEMENT EXECUTE FUNCTION private.cliente_sucessoes_imutavel();

-- ── 2. Versão otimista do grafo ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS private.cliente_sucessoes_grafo (
  id     boolean PRIMARY KEY DEFAULT true CHECK (id),
  versao bigint NOT NULL DEFAULT 0
);
INSERT INTO private.cliente_sucessoes_grafo (id, versao) VALUES (true, 0) ON CONFLICT (id) DO NOTHING;
ALTER TABLE private.cliente_sucessoes_grafo ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.cliente_sucessoes_grafo FROM PUBLIC, anon, authenticated, service_role;

-- ── 3. CNPJ → UMA identidade canônica ────────────────────────────────────────────────────────────────────────
-- Candidatos: o profile com aquele documento (passado pelo alias, se ele próprio for alias) e o canônico de todo
-- alias ATIVO com aquele documento. Mesmo comprador por dois caminhos conta 1 (UNION). `user_id` só sai com
-- exatamente 1 candidato VÁLIDO; 0 = não é cliente; >1 = ambíguo. Válido = tem profile e não é, ele próprio, alias
-- ativo de outro (alias órfão ou encadeado conta como candidato, mas `invalidos` > 0 e `user_id` fica NULL: um
-- UUID solto não prova cadastro).
CREATE OR REPLACE FUNCTION private.cliente_resolver_documento(p_documento text)
 RETURNS TABLE(user_id uuid, candidatos integer, invalidos integer, nome text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH cand AS (
    SELECT COALESCE(a.canonical_user_id, p.user_id) AS uid
      FROM public.profiles p
      LEFT JOIN public.customer_canonical_alias a ON a.alias_user_id = p.user_id AND a.status = 'active'
     WHERE p.document IS NOT NULL
       AND regexp_replace(upper(btrim(p.document)), '[^0-9A-Z]', '', 'g') = p_documento
    UNION
    SELECT a.canonical_user_id
      FROM public.customer_canonical_alias a
     WHERE a.status = 'active' AND a.documento IS NOT NULL
       AND regexp_replace(upper(btrim(a.documento)), '[^0-9A-Z]', '', 'g') = p_documento
  ),
  val AS (
    SELECT c.uid,
           EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = c.uid)
           AND NOT EXISTS (SELECT 1 FROM public.customer_canonical_alias x
                            WHERE x.alias_user_id = c.uid AND x.status = 'active') AS valido
      FROM cand c
  ),
  r AS (
    SELECT CASE WHEN count(*) = 1 AND bool_and(v.valido) THEN (array_agg(v.uid))[1] END AS uid,
           count(*)::integer AS n,
           count(*) FILTER (WHERE NOT v.valido)::integer AS inv
      FROM val v
  )
  SELECT r.uid, r.n, r.inv,
         (SELECT COALESCE(NULLIF(btrim(p.razao_social), ''), NULLIF(btrim(p.name), ''))
            FROM public.profiles p WHERE p.user_id = r.uid)
    FROM r
$function$;
REVOKE ALL ON FUNCTION private.cliente_resolver_documento(text) FROM PUBLIC, anon, authenticated;


-- ── 4. As declarações ativas, resolvidas, com o estado ───────────────────────────────────────────────────────
-- `ativa` ⇔ antigo e novo resolvem para 1 identidade cada, distintas, e o corte já chegou (`p_hoje` = o dia em
-- America/Sao_Paulo, passado por quem chama). Fora disso a declaração fica guardada como `declarada`, com o
-- IMPEDIMENTO concreto. A entrega 3 (rateio) herda SÓ das linhas `ativa` daqui.
--
-- O grafo é julgado pela IDENTIDADE dos extremos, não pelo CNPJ: dois documentos do mesmo comprador são o mesmo
-- nó. A chave de um extremo é o user_id resolvido (ou 'doc:<cnpj>' enquanto não resolve). `chaves` é a base
-- comum da escrita (declarar) e da leitura (vigentes), para as duas julgarem o MESMO grafo.
CREATE OR REPLACE FUNCTION private.cliente_sucessoes_chaves()
 RETURNS TABLE(id uuid, evento_id uuid, antigo_documento text, novo_documento text, tipo text, data_corte date,
               antigo_user_id uuid, antigo_candidatos integer, novo_user_id uuid, novo_candidatos integer,
               chave_antigo text, chave_novo text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.id, s.evento_id, s.antigo_documento, s.novo_documento, s.tipo, s.data_corte,
         a.user_id, a.candidatos, n.user_id, n.candidatos,
         COALESCE(a.user_id::text, 'doc:' || s.antigo_documento),
         COALESCE(n.user_id::text, 'doc:' || s.novo_documento)
    FROM public.cliente_sucessoes s
   CROSS JOIN LATERAL private.cliente_resolver_documento(s.antigo_documento) a
   CROSS JOIN LATERAL private.cliente_resolver_documento(s.novo_documento) n
   WHERE s.revogado_em IS NULL
$function$;
REVOKE ALL ON FUNCTION private.cliente_sucessoes_chaves() FROM PUBLIC, anon, authenticated;

-- A leitura REVALIDA o grafo (fail-closed): cadastro/alias muda depois da declaração, e a porta da tabela é
-- protocolo, não cofre. Cadeia/ciclo, par duplicado (mesmos 2 compradores) e evento divergente (mesma antiga em
-- 2 eventos, ou tipo/corte diferentes) deixam TODAS as linhas envolvidas `declarada`.
CREATE OR REPLACE FUNCTION private.cliente_sucessoes_vigentes(p_hoje date)
 RETURNS TABLE(id uuid, evento_id uuid, antigo_documento text, novo_documento text, tipo text, data_corte date,
               antigo_user_id uuid, novo_user_id uuid, estado text, impedimento text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH k AS (SELECT * FROM private.cliente_sucessoes_chaves())
  SELECT s.id, s.evento_id, s.antigo_documento, s.novo_documento, s.tipo, s.data_corte,
         s.antigo_user_id, s.novo_user_id,
         CASE WHEN x.impedimento IS NULL THEN 'ativa' ELSE 'declarada' END,
         x.impedimento
    FROM k s
   CROSS JOIN LATERAL (SELECT CASE
          WHEN s.antigo_candidatos = 0 THEN 'antigo_nao_e_cliente'
          WHEN s.antigo_candidatos > 1 THEN 'antigo_ambiguo'
          WHEN s.antigo_user_id IS NULL THEN 'antigo_cadastro_invalido'
          WHEN s.novo_candidatos > 1 THEN 'novo_ambiguo'
          WHEN s.novo_candidatos = 0 THEN 'novo_sem_cadastro'
          WHEN s.novo_user_id IS NULL THEN 'novo_cadastro_invalido'
          WHEN s.antigo_user_id = s.novo_user_id THEN 'mesmo_comprador'
          WHEN EXISTS (SELECT 1 FROM k o WHERE o.id <> s.id
                          AND (o.chave_novo = s.chave_antigo OR o.chave_antigo = s.chave_novo)) THEN 'cadeia'
          WHEN EXISTS (SELECT 1 FROM k o WHERE o.id <> s.id
                          AND o.chave_antigo = s.chave_antigo AND o.chave_novo = s.chave_novo) THEN 'duplicada'
          WHEN EXISTS (SELECT 1 FROM k o WHERE o.id <> s.id AND o.chave_antigo = s.chave_antigo
                          AND (o.evento_id, o.tipo, o.data_corte) IS DISTINCT FROM (s.evento_id, s.tipo, s.data_corte))
               THEN 'evento_divergente'
          WHEN p_hoje IS NULL OR s.data_corte > p_hoje THEN 'corte_futuro'
        END AS impedimento) x
$function$;
REVOKE ALL ON FUNCTION private.cliente_sucessoes_vigentes(date) FROM PUBLIC, anon, authenticated;

-- ── 5. Declarar ──────────────────────────────────────────────────────────────────────────────────────────────
-- Ordem: gate → normalização → TRAVA do grafo → versão → resolução → regras do grafo → escrita → versão+1.
-- Recusa de domínio volta como {ok:false, motivo}; entrada inválida é 22023; sem gestor é 42501.
CREATE OR REPLACE FUNCTION public.cliente_declarar_sucessao(
  p_antigo_documento text, p_novo_documento text, p_tipo text, p_data_corte date, p_versao_esperada bigint,
  p_observacao text DEFAULT NULL, p_data_corte_sugerida date DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_antigo text := regexp_replace(upper(btrim(p_antigo_documento)), '[^0-9A-Z]', '', 'g');
  v_novo text := regexp_replace(upper(btrim(p_novo_documento)), '[^0-9A-Z]', '', 'g');
  v_versao bigint;
  v_a record;
  v_n record;
  v_ev record;
  v_evento uuid;
  v_id uuid;
  v_ka text;
  v_kn text;
BEGIN
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only' USING ERRCODE = '42501';
  END IF;
  IF v_antigo IS NULL OR v_antigo !~ '^[0-9A-Z]{12}[0-9]{2}$' OR v_novo IS NULL OR v_novo !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cliente_declarar_sucessao: documento inválido (CNPJ completo)' USING ERRCODE = '22023';
  END IF;
  IF p_tipo IS NULL OR p_tipo NOT IN ('cisao', 'sucessao') THEN
    RAISE EXCEPTION 'cliente_declarar_sucessao: tipo inválido (cisao|sucessao)' USING ERRCODE = '22023';
  END IF;
  IF p_data_corte IS NULL OR p_versao_esperada IS NULL THEN
    RAISE EXCEPTION 'cliente_declarar_sucessao: data de corte e versão são obrigatórias' USING ERRCODE = '22023';
  END IF;
  IF v_antigo = v_novo THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'mesmo_documento');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cliente_sucessoes:grafo', 0));
  SELECT g.versao INTO v_versao FROM private.cliente_sucessoes_grafo g WHERE g.id;
  IF v_versao IS DISTINCT FROM p_versao_esperada THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'versao_mudou', 'versao', v_versao);
  END IF;

  SELECT * INTO v_a FROM private.cliente_resolver_documento(v_antigo);
  IF v_a.candidatos = 0 THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'antigo_nao_e_cliente');
  ELSIF v_a.candidatos > 1 THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'antigo_ambiguo', 'candidatos', v_a.candidatos);
  ELSIF v_a.user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'antigo_cadastro_invalido');
  END IF;
  SELECT * INTO v_n FROM private.cliente_resolver_documento(v_novo);
  IF v_n.candidatos > 1 THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'novo_ambiguo', 'candidatos', v_n.candidatos);
  ELSIF v_n.candidatos = 1 AND v_n.user_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'novo_cadastro_invalido');
  END IF;
  IF v_n.user_id = v_a.user_id THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'mesmo_comprador');
  END IF;
  -- O grafo é de COMPRADORES: as regras abaixo comparam as chaves de identidade (ver private.cliente_sucessoes_chaves).
  v_ka := v_a.user_id::text;
  v_kn := COALESCE(v_n.user_id::text, 'doc:' || v_novo);

  IF EXISTS (SELECT 1 FROM private.cliente_sucessoes_chaves() k WHERE k.chave_antigo = v_ka AND k.chave_novo = v_kn) THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'ja_declarada');
  END IF;
  -- Cadeia (inclui o ciclo): o antigo já RECEBE de alguém, ou o novo já PASSA para alguém. Herança transitiva
  -- fica recusada na v1 (cada parcela precisaria carregar a origem física e o percurso).
  IF EXISTS (SELECT 1 FROM private.cliente_sucessoes_chaves() k WHERE k.chave_novo = v_ka)
     OR EXISTS (SELECT 1 FROM private.cliente_sucessoes_chaves() k WHERE k.chave_antigo = v_kn) THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'cadeia');
  END IF;

  -- 1 evento ativo por antiga (por COMPRADOR): a 2ª nova entra no MESMO evento, com o mesmo tipo e o mesmo corte.
  SELECT s.evento_id, s.tipo, s.data_corte INTO v_ev
    FROM private.cliente_sucessoes_chaves() k
    JOIN public.cliente_sucessoes s ON s.id = k.id
   WHERE v_ka = k.chave_antigo
   ORDER BY s.declarado_em, s.id
   LIMIT 1;
  IF FOUND THEN
    IF v_ev.tipo <> p_tipo OR v_ev.data_corte <> p_data_corte THEN
      RETURN jsonb_build_object('ok', false, 'motivo', 'evento_divergente',
        'tipo', v_ev.tipo, 'data_corte', v_ev.data_corte);
    END IF;
    v_evento := v_ev.evento_id;
  ELSE
    v_evento := gen_random_uuid();
  END IF;

  PERFORM set_config('cliente_sucessoes.porta', 'rpc', true);
  INSERT INTO public.cliente_sucessoes (evento_id, antigo_documento, novo_documento, tipo, data_corte,
                                        data_corte_sugerida, observacao, declarado_por, declarado_em)
  VALUES (v_evento, v_antigo, v_novo, p_tipo, p_data_corte, p_data_corte_sugerida,
          NULLIF(btrim(p_observacao), ''), v_uid, clock_timestamp())
  RETURNING id INTO v_id;
  PERFORM set_config('cliente_sucessoes.porta', '', true);
  UPDATE private.cliente_sucessoes_grafo g SET versao = g.versao + 1 WHERE g.id RETURNING g.versao INTO v_versao;

  RETURN jsonb_build_object('ok', true, 'id', v_id, 'evento_id', v_evento, 'versao', v_versao,
    'antigo_nome', v_a.nome, 'novo_cadastrado', v_n.user_id IS NOT NULL);
END
$function$;
REVOKE ALL ON FUNCTION public.cliente_declarar_sucessao(text,text,text,date,bigint,text,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cliente_declarar_sucessao(text,text,text,date,bigint,text,date) TO authenticated, service_role;
COMMENT ON FUNCTION public.cliente_declarar_sucessao(text,text,text,date,bigint,text,date) IS
  'Gestor/master declara que o CNPJ novo sucede/cinde do antigo a partir do corte comercial. Trava o grafo, '
  'confere a versão otimista, resolve os dois extremos (1 identidade canônica cada) e recusa cadeia/ciclo.';

-- ── 6. Revogar ───────────────────────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cliente_revogar_sucessao(p_id uuid, p_motivo text, p_versao_esperada bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_versao bigint;
  v_revogado timestamptz;
BEGIN
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only' USING ERRCODE = '42501';
  END IF;
  IF p_id IS NULL OR p_versao_esperada IS NULL OR p_motivo IS NULL OR length(btrim(p_motivo)) = 0 THEN
    RAISE EXCEPTION 'cliente_revogar_sucessao: id, motivo e versão são obrigatórios' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('cliente_sucessoes:grafo', 0));
  SELECT g.versao INTO v_versao FROM private.cliente_sucessoes_grafo g WHERE g.id;
  IF v_versao IS DISTINCT FROM p_versao_esperada THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'versao_mudou', 'versao', v_versao);
  END IF;

  SELECT s.revogado_em INTO v_revogado FROM public.cliente_sucessoes s WHERE s.id = p_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cliente_revogar_sucessao: declaração não encontrada' USING ERRCODE = 'P0002';
  END IF;
  IF v_revogado IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'motivo', 'ja_revogada');
  END IF;

  PERFORM set_config('cliente_sucessoes.porta', 'rpc', true);
  UPDATE public.cliente_sucessoes s
     SET revogado_em = clock_timestamp(), revogado_por = v_uid, revogado_motivo = btrim(p_motivo)
   WHERE s.id = p_id;
  PERFORM set_config('cliente_sucessoes.porta', '', true);
  UPDATE private.cliente_sucessoes_grafo g SET versao = g.versao + 1 WHERE g.id RETURNING g.versao INTO v_versao;
  RETURN jsonb_build_object('ok', true, 'versao', v_versao);
END
$function$;
REVOKE ALL ON FUNCTION public.cliente_revogar_sucessao(uuid,text,bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cliente_revogar_sucessao(uuid,text,bigint) TO authenticated, service_role;
COMMENT ON FUNCTION public.cliente_revogar_sucessao(uuid,text,bigint) IS
  'Gestor/master revoga uma declaração de sucessão (auditada: a linha fica, com quem/quando/por quê).';

-- ── 7. Prévia do corte (dos dois lados) ──────────────────────────────────────────────────────────────────────
-- Para o gestor CONFIRMAR a data comercial vendo os pedidos: contagens antes/a partir do corte, 1º e último dia,
-- quantos dias são estimados (sem order_date_kpi) e os 12 pedidos mais recentes. Nenhum valor monetário.
-- Mesmo universo e mesmo dia de `private.venda_linhas_pedido` (status, deleted_at, contas, alias canônico).
CREATE OR REPLACE FUNCTION private.cliente_sucessao_previa_lado(p_documento text, p_data_corte date)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH r AS (SELECT * FROM private.cliente_resolver_documento(p_documento)),
  ped AS (
    SELECT so.id, so.account AS empresa, so.order_date_kpi IS NULL AS estimada,
           COALESCE(so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) AS dia
      FROM r
      JOIN public.sales_orders so
        ON so.customer_user_id IN (SELECT r.user_id
                                   UNION SELECT a.alias_user_id FROM public.customer_canonical_alias a
                                          WHERE a.canonical_user_id = r.user_id AND a.status = 'active')
      LEFT JOIN public.customer_canonical_alias a2 ON a2.alias_user_id = so.customer_user_id AND a2.status = 'active'
     WHERE r.user_id IS NOT NULL
       AND COALESCE(a2.canonical_user_id, so.customer_user_id) = r.user_id
       AND so.deleted_at IS NULL
       AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
       AND so.account IN ('oben', 'colacor', 'colacor_sc')
       -- O universo que será HERDADO é o de venda_linhas_pedido: só pedido com item que conta (produto Omie e
       -- quantidade positiva). Recibo do app sem itens, ao lado da gêmea importada, não conta 2 vezes.
       AND EXISTS (SELECT 1 FROM public.order_items oi
                    WHERE oi.sales_order_id = so.id AND oi.omie_codigo_produto IS NOT NULL AND oi.quantity > 0)
  )
  SELECT jsonb_build_object(
    'documento', p_documento,
    'nome', COALESCE(r.nome, (SELECT COALESCE(NULLIF(btrim(e.nome_fantasia), ''), e.razao_social)
                                FROM public.radar_empresas e WHERE e.cnpj = p_documento)),
    'cadastrado', r.user_id IS NOT NULL,
    'candidatos', r.candidatos,
    -- Sem cadastro não há histórico para contar: NULL (ausente), nunca 0.
    'pedidos_antes', CASE WHEN r.user_id IS NULL THEN NULL ELSE (SELECT count(*) FROM ped WHERE ped.dia < p_data_corte) END,
    'pedidos_a_partir', CASE WHEN r.user_id IS NULL THEN NULL ELSE (SELECT count(*) FROM ped WHERE ped.dia >= p_data_corte) END,
    'primeiro_pedido', (SELECT min(ped.dia) FROM ped),
    'ultimo_pedido', (SELECT max(ped.dia) FROM ped),
    'datas_estimadas', CASE WHEN r.user_id IS NULL THEN NULL ELSE (SELECT count(*) FROM ped WHERE ped.estimada) END,
    'recentes', COALESCE((SELECT jsonb_agg(jsonb_build_object('dia', x.dia, 'empresa', x.empresa,
                                   'estimada', x.estimada, 'antes_do_corte', x.dia < p_data_corte)
                                   ORDER BY x.dia DESC, x.id)
                            FROM (SELECT * FROM ped ORDER BY ped.dia DESC, ped.id LIMIT 12) x), '[]'::jsonb))
    FROM r
$function$;
REVOKE ALL ON FUNCTION private.cliente_sucessao_previa_lado(text,date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.cliente_sucessao_previa(p_antigo_documento text, p_novo_documento text, p_data_corte date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_antigo text := regexp_replace(upper(btrim(p_antigo_documento)), '[^0-9A-Z]', '', 'g');
  v_novo text := regexp_replace(upper(btrim(p_novo_documento)), '[^0-9A-Z]', '', 'g');
BEGIN
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: gestor/master only' USING ERRCODE = '42501';
  END IF;
  IF v_antigo IS NULL OR v_antigo !~ '^[0-9A-Z]{12}[0-9]{2}$' OR v_novo IS NULL OR v_novo !~ '^[0-9A-Z]{12}[0-9]{2}$'
     OR p_data_corte IS NULL THEN
    RAISE EXCEPTION 'cliente_sucessao_previa: documentos completos e data de corte' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object(
    'data_corte', p_data_corte,
    'abertura_novo', (SELECT e.data_abertura FROM public.radar_empresas e WHERE e.cnpj = v_novo),
    'antigo', private.cliente_sucessao_previa_lado(v_antigo, p_data_corte),
    'novo', private.cliente_sucessao_previa_lado(v_novo, p_data_corte));
END
$function$;
REVOKE ALL ON FUNCTION public.cliente_sucessao_previa(text,text,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cliente_sucessao_previa(text,text,date) TO authenticated, service_role;

-- ── 8. Leitura (o selo da ficha) ─────────────────────────────────────────────────────────────────────────────
-- As declarações em que o documento é antigo OU novo, ativas e revogadas (auditoria), mais a versão do grafo
-- (o front devolve-a ao declarar/revogar). Lê com o Radar (cap_radar_prospectar) ou gestor. Só nomes, datas e
-- estado: NÃO abre preço nem histórico da antiga.
CREATE OR REPLACE FUNCTION public.cliente_sucessoes_do_documento(p_documento text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := (SELECT auth.uid());
  v_doc text := regexp_replace(upper(btrim(p_documento)), '[^0-9A-Z]', '', 'g');
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
BEGIN
  IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false) OR COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  IF v_doc IS NULL OR v_doc !~ '^[0-9A-Z]{12}[0-9]{2}$' THEN
    RAISE EXCEPTION 'cliente_sucessoes_do_documento: documento inválido' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object(
    'versao', (SELECT g.versao FROM private.cliente_sucessoes_grafo g WHERE g.id),
    'sucessoes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id, 'evento_id', s.evento_id,
               'papel', CASE WHEN s.novo_documento = v_doc THEN 'novo' ELSE 'antigo' END,
               'antigo_documento', s.antigo_documento,
               'antigo_nome', COALESCE((SELECT r.nome FROM private.cliente_resolver_documento(s.antigo_documento) r),
                                       (SELECT e.razao_social FROM public.radar_empresas e WHERE e.cnpj = s.antigo_documento)),
               'novo_documento', s.novo_documento,
               'novo_nome', COALESCE((SELECT r.nome FROM private.cliente_resolver_documento(s.novo_documento) r),
                                     (SELECT e.razao_social FROM public.radar_empresas e WHERE e.cnpj = s.novo_documento)),
               'tipo', s.tipo, 'data_corte', s.data_corte, 'data_corte_sugerida', s.data_corte_sugerida,
               'observacao', s.observacao,
               'declarado_por_nome', (SELECT p.name FROM public.profiles p WHERE p.user_id = s.declarado_por),
               'declarado_em', s.declarado_em,
               'revogado_em', s.revogado_em,
               'revogado_por_nome', (SELECT p.name FROM public.profiles p WHERE p.user_id = s.revogado_por),
               'revogado_motivo', s.revogado_motivo,
               'estado', COALESCE(v.estado, 'revogada'),
               'impedimento', v.impedimento)
             ORDER BY (s.revogado_em IS NOT NULL), s.declarado_em DESC, s.id)
        FROM public.cliente_sucessoes s
        LEFT JOIN private.cliente_sucessoes_vigentes(v_hoje) v ON v.id = s.id
       WHERE s.antigo_documento = v_doc OR s.novo_documento = v_doc), '[]'::jsonb));
END
$function$;
REVOKE ALL ON FUNCTION public.cliente_sucessoes_do_documento(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cliente_sucessoes_do_documento(text) TO authenticated, service_role;

-- ── PÓS: relê o catálogo; qualquer estado insuficiente aborta a transação inteira ───────────────────────────
DO $post$
DECLARE
  r record;
  v text;
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.cliente_sucessoes'::regclass)
     OR has_table_privilege('authenticated', 'public.cliente_sucessoes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('anon', 'public.cliente_sucessoes', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'P1 FALHOU: cliente_sucessoes sem RLS ou aberta ao JWT';
  END IF;
  IF has_table_privilege('service_role', 'public.cliente_sucessoes', 'INSERT,UPDATE,DELETE,TRUNCATE')
     OR has_table_privilege('service_role', 'private.cliente_sucessoes_grafo', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'P1b FALHOU: service_role escreve direto (a escrita é só pelas RPCs)';
  END IF;
  IF has_table_privilege('authenticated', 'private.cliente_sucessoes_grafo', 'SELECT,UPDATE')
     OR has_table_privilege('anon', 'private.cliente_sucessoes_grafo', 'SELECT,UPDATE')
     OR (SELECT count(*) FROM private.cliente_sucessoes_grafo) <> 1 THEN
    RAISE EXCEPTION 'P2 FALHOU: grafo de versão aberto ao JWT ou sem a linha única';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = 'public.cliente_sucessoes'::regclass AND NOT t.tgisinternal
        AND t.tgname IN ('cliente_sucessoes_imutavel_trg', 'cliente_sucessoes_sem_truncate_trg') AND t.tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION 'P3 FALHOU: triggers de auditoria (sem DELETE/TRUNCATE, só revogação) ausentes ou desligados';
  END IF;
  -- tgtype: 4 = INSERT, 8 = DELETE, 16 = UPDATE — a porta só vale se o trigger de linha pegar os três.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.cliente_sucessoes'::regclass
                    AND t.tgname = 'cliente_sucessoes_imutavel_trg' AND (t.tgtype::int & 28) = 28) THEN
    RAISE EXCEPTION 'P3b FALHOU: o trigger de auditoria não cobre INSERT/UPDATE/DELETE';
  END IF;
  FOR r IN SELECT * FROM (VALUES
      ('public.cliente_declarar_sucessao(text,text,text,date,bigint,text,date)', 'IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN'),
      ('public.cliente_revogar_sucessao(uuid,text,bigint)', 'IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN'),
      ('public.cliente_sucessao_previa(text,text,date)', 'IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)) THEN'),
      ('public.cliente_sucessoes_do_documento(text)', 'IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false) OR')
    ) AS x(sig, gate)
  LOOP
    SELECT p.prosrc INTO v FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig) AND p.prosecdef;
    IF v IS NULL OR strpos(v, r.gate) = 0 THEN
      RAISE EXCEPTION 'P4 FALHOU: % ausente, sem SECDEF ou sem o gate', r.sig;
    END IF;
    IF has_function_privilege('anon', r.sig, 'EXECUTE') OR has_function_privilege('public', r.sig, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'P5 FALHOU: ACL de % (anon/PUBLIC fechados, authenticated aberto)', r.sig;
    END IF;
  END LOOP;
  FOR r IN SELECT * FROM (VALUES ('private.cliente_resolver_documento(text)'), ('private.cliente_sucessoes_vigentes(date)'),
                                  ('private.cliente_sucessoes_chaves()'),
                                  ('private.cliente_sucessao_previa_lado(text,date)'), ('private.cliente_sucessoes_imutavel()')) AS x(sig)
  LOOP
    IF to_regprocedure(r.sig) IS NULL
       OR has_function_privilege('anon', r.sig, 'EXECUTE') OR has_function_privilege('authenticated', r.sig, 'EXECUTE') THEN
      RAISE EXCEPTION 'P6 FALHOU: % ausente ou aberto ao JWT', r.sig;
    END IF;
  END LOOP;
  RAISE NOTICE 'cliente_sucessoes: tabela + grafo + 2 triggers + resolvedor + vigentes + 4 RPCs OK';
END
$post$;
