-- ============================================================================================
-- F1 Task 9 -- lado Omie do resumo diario do extrato: movimento REALIZADO por dia, calibrado antes de aparecer
-- ============================================================================================
-- Plano: docs/superpowers/plans/2026-11-20-f1-extrato-bancario-itau.md (Task 9 + apendice "Task 9, Step 1").
-- Depende da F1 (20261121123119_banco_extrato_f1.sql, JA aplicada -- nao e editada aqui).
--
-- O que cria:
--   1. public.banco_regra_calibracao: o resultado MEDIDO da calibracao de uma versao da regra contra o extrato
--      aceito (contagens por lado, nunca valores). Escrita so por migration/envelope (authenticated: so SELECT).
--   2. public.banco_extrato_omie_dia(conta, de, ate): SECURITY INVOKER (RLS vale), uma linha por dia de [de, ate],
--      soma as N omie_ncodcc de banco_conta_omie pela regra v1. GATE FAIL-CLOSED NO SERVIDOR, por lado e POR DIA: o
--      lado (creditos ou debitos) do dia D so sai com numero se (a) TODAS as calibracoes registradas da versao, para
--      a conta, tiverem todo dia conferido batendo ou explicado E pelo menos 1 dia com movimento naquele lado, e
--      (b) D estiver DENTRO do periodo de alguma calibracao da versao (a medicao nao vale para dia que nao mediu,
--      p.ex. debito recente ainda sem baixa). Senao o valor e NULL e o flag *_calibrado = false.
--      Sentido sem linha Omie no dia = NULL (ausente != zero), mesmo calibrado: nao se fabrica 0 por ausencia.
--   3. Seed: a calibracao v1 medida em 2026-11-21 (Oben, out/2026): 31 dias conferidos, 24 com movimento por lado;
--      batem 7 (so os 7 dias sem movimento nos dois lados) em creditos e 7 em debitos; 0 explicadas -> os DOIS
--      lados fechados.
--
-- Regra v1 (inalterada da descoberta; a calibracao NAO justificou uma v2 -- ver o PR e o apendice do plano):
--   otica CONTA_CORRENTE_REC (credito) / CONTA_CORRENTE_PAG (debito); naturezas BAXR/APBR/TRAR/EXTR e
--   BAXP/APEP/TRAP/EXTP (lista POSITIVA); valor > 0; data efetiva = COALESCE(data_credito_omie,
--   data_pagamento_omie) (nunca vencimento/data_movimento); dedup por (company, titulo, omie_ncodbaixa) ficando a
--   ultima observacao, ANTES do filtro de periodo (uma baixa corrigida para fora da janela nao ressuscita a versao
--   velha dentro dela); fora a baixa de titulo hoje nao liquidado e a transferencia entre duas contas Omie da
--   MESMA conta bancaria.
--
-- Molde TRAVA -> PRE -> CREATE -> POS. Idempotente, sem BEGIN/COMMIT. Nenhum numero de agencia/conta aqui.
-- ============================================================================================

-- -- SECAO 0 -- TRAVA + PRE ----------------------------------------------------------------------
DO $pre$
DECLARE
  v_marca text;
BEGIN
  -- TRAVA: o seed le banco_conta; segura mudanca de cadastro ate o COMMIT.
  PERFORM set_config('lock_timeout', '10s', true);
  LOCK TABLE public.banco_conta IN SHARE MODE;

  IF to_regprocedure('public.fin_user_can_access(text)') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU dependencia: public.fin_user_can_access(text) ausente.';
  END IF;
  IF to_regclass('public.banco_conta') IS NULL OR to_regclass('public.banco_conta_omie') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU dependencia: banco_conta/banco_conta_omie ausentes (a F1 nao foi aplicada).';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'fin_movimentacoes'
         AND column_name IN ('id','company','omie_ncodcc','natureza','valor','omie_codigo_lancamento','omie_ncodbaixa',
                             'updated_at','created_at','categoria_descricao','data_credito_omie','data_pagamento_omie')) <> 12 THEN
    RAISE EXCEPTION 'PRE FALHOU dependencia: fin_movimentacoes sem as 12 colunas que a regra v1 le.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name IN ('fin_contas_receber','fin_contas_pagar')
         AND column_name IN ('company','omie_codigo_lancamento','status_titulo')) <> 6 THEN
    RAISE EXCEPTION 'PRE FALHOU dependencia: fin_contas_receber/fin_contas_pagar sem company/omie_codigo_lancamento/status_titulo.';
  END IF;
  -- valor tem de ser exato em centavos (numeric com escala 2): soma em float fabricaria centavo.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'fin_movimentacoes' AND column_name = 'valor'
                    AND data_type = 'numeric' AND numeric_scale = 2) THEN
    RAISE EXCEPTION 'PRE FALHOU dependencia: fin_movimentacoes.valor nao e numeric(,2).';
  END IF;

  -- o seed liga a medicao a A conta Itau da oben: mais de uma = ambiguo, aborta (nunca copia para as duas).
  IF (SELECT count(*) FROM public.banco_conta WHERE company = 'oben' AND banco_codigo = '341') > 1 THEN
    RAISE EXCEPTION 'PRE FALHOU seed_ambiguo: mais de uma banco_conta Itau da oben; a calibracao medida nao tem dono unico. Nada foi criado.';
  END IF;

  -- re-apply: a tabela que ja existe tem de ser DESTA migration (marca no COMMENT).
  IF to_regclass('public.banco_regra_calibracao') IS NOT NULL THEN
    v_marca := obj_description(to_regclass('public.banco_regra_calibracao'), 'pg_class');
    IF v_marca IS NULL OR v_marca NOT LIKE 'banco_extrato_omie_dia:%' THEN
      RAISE EXCEPTION 'PRE FALHOU objeto_alheio: public.banco_regra_calibracao ja existe sem a marca banco_extrato_omie_dia. Nada foi criado.';
    END IF;
  END IF;
END
$pre$;

-- -- SECAO 1 -- tabela da calibracao ---------------------------------------------------------------
-- Uma linha = uma medicao da regra <regra_versao> na conta, no periodo [de, ate]. Os lados sao independentes
-- (apendice, decisao 12): o gate de cada lado olha so as suas colunas. "batem" conta dia em que a soma Omie e a
-- do extrato sao iguais ao centavo (inclusive 0 = 0, dia sem movimento nos dois lados); "explicadas" conta dia
-- divergente cuja diferenca INTEIRA foi atribuida a uma causa conhecida. "com_movimento" conta dia com movimento
-- naquele lado em pelo menos uma das fontes: sem nenhum, a medicao so viu 0 = 0 e nao calibra o lado.
CREATE TABLE IF NOT EXISTS public.banco_regra_calibracao (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company                           text NOT NULL,
  banco_conta_id                    uuid NOT NULL,
  regra_versao                      text NOT NULL CHECK (regra_versao ~ '^v[0-9]+$'),
  de                                date NOT NULL,
  ate                               date NOT NULL,
  dias_conferidos                   integer NOT NULL,
  dias_com_movimento_creditos       integer NOT NULL,
  dias_com_movimento_debitos        integer NOT NULL,
  dias_batem_creditos               integer NOT NULL,
  dias_batem_debitos                integer NOT NULL,
  divergencias_explicadas_creditos  integer NOT NULL,
  divergencias_explicadas_debitos   integer NOT NULL,
  notas                             text NOT NULL CHECK (length(btrim(notas)) > 0),
  medido_em                         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT banco_regra_calibracao_periodo_ck CHECK (ate >= de AND dias_conferidos BETWEEN 0 AND (ate - de + 1)),
  CONSTRAINT banco_regra_calibracao_contagens_ck CHECK (
        dias_com_movimento_creditos BETWEEN 0 AND dias_conferidos
    AND dias_com_movimento_debitos BETWEEN 0 AND dias_conferidos
    AND dias_batem_creditos >= 0 AND dias_batem_debitos >= 0
    AND divergencias_explicadas_creditos >= 0 AND divergencias_explicadas_debitos >= 0
    AND dias_batem_creditos + divergencias_explicadas_creditos <= dias_conferidos
    AND dias_batem_debitos + divergencias_explicadas_debitos <= dias_conferidos),
  CONSTRAINT banco_regra_calibracao_medicao_key UNIQUE (banco_conta_id, regra_versao, de, ate),
  CONSTRAINT banco_regra_calibracao_conta_fk FOREIGN KEY (banco_conta_id, company) REFERENCES public.banco_conta (id, company)
);
COMMENT ON TABLE public.banco_regra_calibracao IS 'banco_extrato_omie_dia: calibracao medida da regra do movimento Omie por dia contra o extrato aceito (contagens por lado).';

ALTER TABLE public.banco_regra_calibracao ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS banco_regra_calibracao_select ON public.banco_regra_calibracao;
CREATE POLICY banco_regra_calibracao_select
  ON public.banco_regra_calibracao FOR SELECT TO authenticated USING (public.fin_user_can_access(company));
-- REVOKE ALL tira tambem TRUNCATE (que FURA a RLS) e o ALL que o default ACL de prod concede.
-- service_role tambem: o default ACL de prod lhe da ALL (inclusive TRUNCATE), e ela poderia trocar uma reprovacao
-- por aprovacao fora do envelope. Escrita = so o dono (migration/envelope).
REVOKE ALL ON TABLE public.banco_regra_calibracao FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.banco_regra_calibracao TO authenticated, service_role;

-- -- SECAO 2 -- RPC banco_extrato_omie_dia ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.banco_extrato_omie_dia(p_banco_conta_id uuid, p_de date, p_ate date)
RETURNS TABLE (data date, creditos_centavos bigint, debitos_centavos bigint, regra_versao text,
               creditos_calibrado boolean, debitos_calibrado boolean)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
#variable_conflict use_column
DECLARE
  c_versao CONSTANT text := 'v1';
  v_conta_c boolean;
  v_conta_d boolean;
BEGIN
  IF p_banco_conta_id IS NULL OR p_de IS NULL OR p_ate IS NULL THEN
    RAISE EXCEPTION 'banco_extrato_omie_dia: conta, de e ate sao obrigatorios' USING ERRCODE = '22004';
  END IF;
  IF p_ate < p_de OR p_ate - p_de > 400 THEN
    RAISE EXCEPTION 'banco_extrato_omie_dia: intervalo invalido (de % ate %, maximo 401 dias)', p_de, p_ate USING ERRCODE = '22023';
  END IF;

  -- GATE (parte da conta): sem calibracao (ou sem acesso a ela, pela RLS) = fechado. Uma calibracao reprovada
  -- fecha o lado mesmo que outra tenha passado (bool_and). Zero dia conferido, ou nenhum dia com movimento no
  -- lado (so 0 = 0), nao calibra o lado. A parte do DIA (dentro de um periodo medido) vai na consulta.
  SELECT coalesce(bool_and(k.dias_conferidos > 0 AND k.dias_com_movimento_creditos > 0
                           AND k.dias_batem_creditos + k.divergencias_explicadas_creditos = k.dias_conferidos), false),
         coalesce(bool_and(k.dias_conferidos > 0 AND k.dias_com_movimento_debitos > 0
                           AND k.dias_batem_debitos + k.divergencias_explicadas_debitos = k.dias_conferidos), false)
    INTO v_conta_c, v_conta_d
    FROM public.banco_regra_calibracao k
   WHERE k.banco_conta_id = p_banco_conta_id AND k.regra_versao = c_versao;

  RETURN QUERY
  WITH dias AS (
    SELECT p_de + g AS d FROM generate_series(0, p_ate - p_de) g
  ),
  medido AS (
    SELECT dias.d,
           EXISTS (SELECT 1 FROM public.banco_regra_calibracao k
                    WHERE k.banco_conta_id = p_banco_conta_id AND k.regra_versao = c_versao
                      AND dias.d BETWEEN k.de AND k.ate) AS dentro
      FROM dias
  ),
  contas AS (
    SELECT bco.company, bco.omie_ncodcc
      FROM public.banco_conta_omie bco
     WHERE bco.banco_conta_id = p_banco_conta_id
  ),
  linhas AS (
    SELECT m.id, m.company, m.omie_ncodcc, m.natureza, m.valor,
           m.omie_codigo_lancamento, m.omie_ncodbaixa, m.updated_at, m.created_at,
           m.categoria_descricao AS grupo,
           COALESCE(m.data_credito_omie, m.data_pagamento_omie) AS data_efetiva
      FROM public.fin_movimentacoes m
      JOIN contas c ON c.company = m.company AND c.omie_ncodcc = m.omie_ncodcc
     WHERE m.categoria_descricao IN ('CONTA_CORRENTE_REC', 'CONTA_CORRENTE_PAG')
       AND m.natureza IN ('BAXR', 'APBR', 'TRAR', 'EXTR',
                          'BAXP', 'APEP', 'TRAP', 'EXTP')
       AND m.valor > 0
       -- SEM filtro de periodo aqui: o dedup abaixo precisa ver todas as versoes da baixa (o periodo vai no agg)
  ),
  -- versoes da MESMA baixa: uma linha por (empresa, titulo, nCodBaixa), a observada por ultimo
  baixas AS (
    SELECT DISTINCT ON (l.company, l.omie_codigo_lancamento, l.omie_ncodbaixa) l.*
      FROM linhas l
     WHERE l.omie_ncodbaixa IS NOT NULL
     ORDER BY l.company, l.omie_codigo_lancamento, l.omie_ncodbaixa,
              l.updated_at DESC NULLS LAST, l.created_at DESC NULLS LAST, l.id DESC
  ),
  atuais AS (
    SELECT * FROM baixas
    UNION ALL
    SELECT * FROM linhas l WHERE l.omie_ncodbaixa IS NULL
  ),
  validas AS (
    SELECT a.*
      FROM atuais a
     WHERE
       -- baixa cancelada: o titulo hoje nao esta liquidado e a baixa sobrou no espelho
       NOT (a.natureza IN ('BAXR', 'APBR') AND EXISTS (
              SELECT 1 FROM public.fin_contas_receber r
               WHERE r.company = a.company AND r.omie_codigo_lancamento = a.omie_codigo_lancamento
                 AND r.status_titulo NOT IN ('RECEBIDO', 'PAGTO PARCIAL')))
       AND NOT (a.natureza = 'BAXP' AND EXISTS (
              SELECT 1 FROM public.fin_contas_pagar p
               WHERE p.company = a.company AND p.omie_codigo_lancamento = a.omie_codigo_lancamento
                 AND p.status_titulo NOT IN ('PAGO', 'PAGTO PARCIAL')))
       -- transferencia entre duas contas Omie da MESMA conta bancaria (nao existe no extrato)
       AND NOT (a.natureza IN ('TRAP', 'TRAR') AND EXISTS (
              SELECT 1 FROM public.fin_movimentacoes o
                JOIN contas c2 ON c2.company = o.company AND c2.omie_ncodcc = o.omie_ncodcc
               WHERE o.company = a.company
                 AND o.natureza = CASE a.natureza WHEN 'TRAP' THEN 'TRAR' ELSE 'TRAP' END
                 AND o.omie_ncodcc <> a.omie_ncodcc
                 AND o.valor = a.valor
                 AND COALESCE(o.data_credito_omie, o.data_pagamento_omie) = a.data_efetiva))
  ),
  agg AS (
    -- sentido sem linha no dia = NULL (sem COALESCE): um credito chegando nao prova que o debito do dia ja foi
    -- baixado (atraso de baixa de debito: p90 48 dias). A versao vigente da baixa e filtrada pelo periodo SO aqui.
    SELECT v.data_efetiva AS d,
           sum((v.valor * 100)::bigint) FILTER (WHERE v.grupo = 'CONTA_CORRENTE_REC')::bigint AS cred,
           sum((v.valor * 100)::bigint) FILTER (WHERE v.grupo = 'CONTA_CORRENTE_PAG')::bigint AS deb
      FROM validas v
     WHERE v.data_efetiva BETWEEN p_de AND p_ate
     GROUP BY v.data_efetiva
  )
  SELECT dias.d,
         CASE WHEN v_conta_c AND medido.dentro THEN agg.cred END,
         CASE WHEN v_conta_d AND medido.dentro THEN agg.deb END,
         c_versao,
         v_conta_c AND medido.dentro,
         v_conta_d AND medido.dentro
    FROM dias
    JOIN medido ON medido.d = dias.d
    LEFT JOIN agg ON agg.d = dias.d
   ORDER BY dias.d;
END
$fn$;
COMMENT ON FUNCTION public.banco_extrato_omie_dia(uuid, date, date) IS
  'banco_extrato_omie_dia: movimento Omie realizado por dia (regra v1), gate fail-closed por lado em banco_regra_calibracao.';
REVOKE ALL ON FUNCTION public.banco_extrato_omie_dia(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.banco_extrato_omie_dia(uuid, date, date) TO authenticated, service_role;

-- -- SECAO 3 -- seed: a calibracao v1 medida (Oben, out/2026) -------------------------------------------
-- Medido em 2026-11-21 via psql-ro contra os 2 OFX aceitos (01-20/10 e 10-31/10). So contagens.
INSERT INTO public.banco_regra_calibracao
  (company, banco_conta_id, regra_versao, de, ate, dias_conferidos, dias_com_movimento_creditos, dias_com_movimento_debitos,
   dias_batem_creditos, dias_batem_debitos, divergencias_explicadas_creditos, divergencias_explicadas_debitos, notas)
SELECT b.company, b.id, 'v1', DATE '2026-10-01', DATE '2026-10-31', 31, 24, 24,
       7, 7, 0, 0,
       'v1 NAO calibrada. 24 dias com movimento em cada lado, 0 batem ao centavo (os 7 que batem sao 0=0). '
       || 'Creditos: estrutural (desconto de duplicatas e cobranca em lote no banco x baixa por titulo no Omie). '
       || 'Debitos: boleto pago casa 1:1 no mesmo dia, mas tarifa, juros, IOF, debito automatico e encargos de '
       || 'desconto so existem no banco. Detalhe no PR da Task 9.'
  FROM public.banco_conta b
 WHERE b.company = 'oben' AND b.banco_codigo = '341'
ON CONFLICT (banco_conta_id, regra_versao, de, ate) DO NOTHING;

-- -- SECAO 4 -- POS: relido do catalogo e dos dados ----------------------------------------------------
DO $post$
DECLARE
  v_sig text := 'public.banco_extrato_omie_dia(uuid,date,date)';
  v_n   int;
BEGIN
  -- (1) tabela com RLS, marca, 1 policy SELECT authenticated, ACL: anon nada, authenticated so SELECT.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.banco_regra_calibracao') AND relrowsecurity)
     OR obj_description(to_regclass('public.banco_regra_calibracao'), 'pg_class') NOT LIKE 'banco_extrato_omie_dia:%' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU rls: banco_regra_calibracao ausente, sem RLS ou sem a marca.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'banco_regra_calibracao';
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'banco_regra_calibracao'
                               AND cmd = 'SELECT' AND roles = '{authenticated}'
                               AND qual = 'fin_user_can_access(company)') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU policy: banco_regra_calibracao com % policy(s) (esperado 1, SELECT, authenticated, USING fin_user_can_access(company)).', v_n;
  END IF;
  IF has_table_privilege('anon', 'public.banco_regra_calibracao', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('authenticated', 'public.banco_regra_calibracao', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_table_privilege('service_role', 'public.banco_regra_calibracao', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR NOT has_table_privilege('authenticated', 'public.banco_regra_calibracao', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU privilegio: banco_regra_calibracao com ACL fora do desenho.';
  END IF;

  -- (2) RPC: INVOKER (a RLS das fontes vale), fechada para PUBLIC e anon, aberta para authenticated e service_role,
  --     com o contrato de saida que a tela le.
  IF to_regprocedure(v_sig) IS NULL
     OR (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(v_sig))
     OR has_function_privilege('public', v_sig, 'EXECUTE')
     OR has_function_privilege('anon', v_sig, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU rpc: banco_extrato_omie_dia ausente, SECURITY DEFINER ou EXECUTE fora do desenho.';
  END IF;
  IF pg_get_function_result(to_regprocedure(v_sig)) <>
     'TABLE(data date, creditos_centavos bigint, debitos_centavos bigint, regra_versao text, creditos_calibrado boolean, debitos_calibrado boolean)' THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU contrato: banco_extrato_omie_dia com RETURNS TABLE fora do contrato.';
  END IF;

  -- (3) seed: onde existe a conta Itau da oben, a medicao v1 de out/2026 esta registrada com os numeros medidos.
  IF EXISTS (SELECT 1 FROM public.banco_conta WHERE company = 'oben' AND banco_codigo = '341')
     AND NOT EXISTS (SELECT 1 FROM public.banco_regra_calibracao k JOIN public.banco_conta b ON b.id = k.banco_conta_id
                      WHERE b.company = 'oben' AND b.banco_codigo = '341' AND k.regra_versao = 'v1'
                        AND k.de = DATE '2026-10-01' AND k.ate = DATE '2026-10-31' AND k.dias_conferidos = 31
                        AND k.dias_com_movimento_creditos = 24 AND k.dias_com_movimento_debitos = 24
                        AND k.dias_batem_creditos = 7 AND k.dias_batem_debitos = 7
                        AND k.divergencias_explicadas_creditos = 0 AND k.divergencias_explicadas_debitos = 0) THEN
    RAISE EXCEPTION 'POSTCONDICAO FALHOU seed: calibracao v1 out/2026 da oben ausente ou com numeros diferentes do medido.';
  END IF;
END
$post$;
