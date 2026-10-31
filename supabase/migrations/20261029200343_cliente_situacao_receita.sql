-- Frente 5 do Radar — situação cadastral da Receita (RFB) FORA do Radar: selo na ficha do cliente
-- (Customer360) e no passo de cliente do pedido. Só ALERTA; não bloqueia pedido.
--
-- Por que uma RPC e não a tabela: radar_situacao_cadastral tem RLS de GESTOR
-- (pode_ver_carteira_completa) e essa policy NÃO se afrouxa aqui (a frente 2 é dona dela). O vendedor
-- precisa ver o selo dos clientes da carteira dele ⇒ SECURITY DEFINER com o MESMO escopo de linha do
-- vizinho get_scores_margem (20261014120000): private.cap_carteira_ler OR private.carteira_visivel_para.
-- Fora do escopo: 42501 (não linha vazia) — o front distingue "sem acesso" de "sem dado".
--
-- Contrato (ausente ≠ ativa — nunca fabricar "CNPJ ok"):
--   · exatamente 1 linha quando autorizado; `estado` ∈
--       irregular     — 03 suspensa · 04 inapta · 08 baixada (a regra do Radar, radar_aplicar_situacao)
--       ativa         — 02
--       outra         — 01 nula ou código desconhecido (fora do selo, coerente com o Radar)
--       sem_dado      — CNPJ válido sem linha em nenhum lote
--       sem_cnpj      — documento que não vira CNPJ (CPF, lixo)
--       sem_documento — cliente sem profile ou sem documento
--   · a linha é a do lote MAIS RECENTE daquele CNPJ e sai rotulada com o lote; `lote_vigente` é o
--     último lote PUBLICADO (radar_ingest_state complete + situação aplicada — os chunks gravam antes do
--     finalize, então max(lote) da foto pode ser um lote em carga) e `confirmado_no_vigente` diz se a
--     observação é desse lote; lote ainda em carga (> vigente) não é lido. Irregular de lote velho = "último registro", nunca "situação atual"
--     (parecer Codex de desenho, achado ALTO 1). Sem lote publicado → confirmado_no_vigente = false;
--   · recusa de escopo = 42501 com HINT 'fora_da_carteira' — o discriminador que o front casa; 42501
--     sem esse HINT (privilégio de dependência, deploy errado) é ERRO, não "sem acesso" (achado 4);
--   · casamento de CNPJ espelha radar_docs_clientes() (20261019200000) — dígitos OU alfanumérico
--     [0-9A-Z]{12}[0-9]{2}, cru ou com a máscara exata; a prova compara os dois no mesmo seed;
--   · não expõe motivo_codigo/observado_em/alertado_em e não lê outra tabela radar_*.
-- Idempotente. Sem BEGIN/COMMIT: aplicar com `bun run db:aplicar <este arquivo>` (o executor fornece a
-- transação); no SQL Editor, envolver em BEGIN; … COMMIT;.

DO $pre$
BEGIN
  IF to_regclass('public.radar_situacao_cadastral') IS NULL OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.radar_ingest_state') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_situacao_cadastral, radar_ingest_state ou profiles ausente';
  END IF;
  IF to_regprocedure('private.cap_carteira_ler(uuid)') IS NULL
     OR to_regprocedure('private.carteira_visivel_para(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: helpers de escopo (cap_carteira_ler/carteira_visivel_para) ausentes';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.cliente_situacao_receita(p_customer_user_id uuid)
RETURNS TABLE(estado text, cnpj text, situacao text, data_situacao date, motivo_descricao text, lote text,
              lote_vigente text, confirmado_no_vigente boolean)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid   uuid;
  v_doc   text;
  v_d     text;
  v_cands text[];
  v_vig   text;
  r       record;
BEGIN
  -- Atribuição no CORPO (erro em DECLARE não é capturável pelo bloco).
  v_uid := (SELECT auth.uid());
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'cliente_situacao_receita: sem identidade' USING ERRCODE = '42501';
  END IF;
  IF p_customer_user_id IS NULL THEN
    RAISE EXCEPTION 'cliente_situacao_receita: cliente obrigatório' USING ERRCODE = '22023';
  END IF;

  -- Escopo espelhando get_scores_margem / fcs_select_carteira. O gate vem ANTES de qualquer leitura:
  -- fora da carteira não se aprende nem se o user_id existe.
  IF NOT (COALESCE(private.cap_carteira_ler(v_uid), false)
          OR COALESCE(private.carteira_visivel_para(p_customer_user_id, v_uid), false)) THEN
    RAISE EXCEPTION 'cliente_situacao_receita: cliente fora da sua carteira'
      USING ERRCODE = '42501', HINT = 'fora_da_carteira';
  END IF;

  SELECT max(i.mes_referencia) INTO v_vig
    FROM public.radar_ingest_state i
   WHERE i.status = 'complete' AND i.situacao_aplicada_em IS NOT NULL;

  SELECT p.document INTO v_doc FROM public.profiles p WHERE p.user_id = p_customer_user_id LIMIT 1;
  IF v_doc IS NULL OR btrim(v_doc) = '' THEN
    RETURN QUERY SELECT 'sem_documento'::text, NULL::text, NULL::text, NULL::date, NULL::text, NULL::text, v_vig, false;
    RETURN;
  END IF;

  -- Espelho da normalização de radar_docs_clientes(): candidatos = só dígitos ∪ alfanumérico (cru ou
  -- máscara exata); vale o que bate o formato de CNPJ.
  v_d := btrim(upper(v_doc));
  SELECT array_agg(DISTINCT c) INTO v_cands
    FROM (
      SELECT regexp_replace(v_doc, '[^0-9]', '', 'g') AS c
      UNION ALL
      SELECT regexp_replace(v_d, '[-./]', '', 'g')
       WHERE v_d ~ '^[0-9A-Z]{12}[0-9]{2}$'
          OR v_d ~ '^[0-9A-Z]{2}[.][0-9A-Z]{3}[.][0-9A-Z]{3}/[0-9A-Z]{4}-[0-9]{2}$'
    ) x
   WHERE c ~ '^[0-9A-Z]{12}[0-9]{2}$';
  IF v_cands IS NULL THEN
    RETURN QUERY SELECT 'sem_cnpj'::text, NULL::text, NULL::text, NULL::date, NULL::text, NULL::text, v_vig, false;
    RETURN;
  END IF;

  SELECT s.cnpj, s.situacao, s.data_situacao, s.motivo_descricao, s.lote
    INTO r
    FROM public.radar_situacao_cadastral s
   WHERE s.cnpj = ANY (v_cands)
     AND (v_vig IS NULL OR s.lote <= v_vig)   -- só lote PUBLICADO: o lote em carga não aparece pela metade
   ORDER BY s.lote DESC, s.cnpj
   LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'sem_dado'::text, v_cands[1], NULL::text, NULL::date, NULL::text, NULL::text, v_vig, false;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    CASE WHEN r.situacao IN ('03', '04', '08') THEN 'irregular'
         WHEN r.situacao = '02' THEN 'ativa'
         ELSE 'outra' END,
    r.cnpj, r.situacao, r.data_situacao, r.motivo_descricao, r.lote,
    v_vig, COALESCE(r.lote = v_vig, false);
END;
$function$;

COMMENT ON FUNCTION public.cliente_situacao_receita(uuid) IS
  'Situação cadastral da Receita (RFB) do cliente, no escopo de carteira (cap_carteira_ler OR carteira_visivel_para). '
  'Lê radar_situacao_cadastral sem afrouxar a RLS de gestor dela. 1 linha; estado irregular/ativa/outra/sem_dado/sem_cnpj/sem_documento. '
  'Fora da carteira: 42501 HINT fora_da_carteira. Selo só para irregular (03/04/08) — ausente nunca vira ativa; '
  'confirmado_no_vigente separa situação do último lote publicado de último registro histórico.';

-- ACL: o Supabase concede EXECUTE por NOME a anon (default privileges) — REVOKE das DUAS pontas.
REVOKE ALL ON FUNCTION public.cliente_situacao_receita(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cliente_situacao_receita(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.cliente_situacao_receita(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cliente_situacao_receita(uuid) TO service_role;

DO $pos$
DECLARE
  f     regprocedure := to_regprocedure('public.cliente_situacao_receita(uuid)');
  v_def text;
BEGIN
  IF f IS NULL THEN
    RAISE EXCEPTION 'POS1 FALHOU: public.cliente_situacao_receita(uuid) nao existe';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = f) THEN
    RAISE EXCEPTION 'POS2 FALHOU: cliente_situacao_receita nao e SECURITY DEFINER - o vendedor bateria na RLS de gestor e veria sempre sem_dado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f AND proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']) THEN
    RAISE EXCEPTION 'POS3 FALHOU: cliente_situacao_receita sem search_path fixo';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('public', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS4 FALHOU: anon/PUBLIC executa cliente_situacao_receita';
  END IF;
  IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS5 FALHOU: authenticated nao executa cliente_situacao_receita - o selo nunca apareceria';
  END IF;
  -- SECURITY DEFINER só atravessa a RLS de gestor se o DONO a atravessa (achado 5): dono com BYPASSRLS,
  -- ou dono da tabela sem FORCE. Senão o vendedor veria sempre sem_dado — falso "nada consta".
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc pr JOIN pg_roles ro ON ro.oid = pr.proowner
      JOIN pg_class c ON c.oid = 'public.radar_situacao_cadastral'::regclass
     WHERE pr.oid = f AND (ro.rolbypassrls OR ro.rolsuper OR (pr.proowner = c.relowner AND NOT c.relforcerowsecurity))) THEN
    RAISE EXCEPTION 'POS7 FALHOU: o dono de cliente_situacao_receita nao atravessa a RLS de radar_situacao_cadastral - sem_dado falso';
  END IF;
  v_def := pg_get_functiondef(f);
  IF position('carteira_visivel_para' IN v_def) = 0 OR position('cap_carteira_ler' IN v_def) = 0
     OR position('fora_da_carteira' IN v_def) = 0 THEN
    RAISE EXCEPTION 'POS6 FALHOU: o corpo de cliente_situacao_receita perdeu o gate de carteira';
  END IF;
END
$pos$;
