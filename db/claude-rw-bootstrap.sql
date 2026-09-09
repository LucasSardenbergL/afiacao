-- ╔═══════════════════════════════════════════════════════════════════════════════════════╗
-- ║  claude-rw-bootstrap.sql — a ÚNICA colagem manual que resta                            ║
-- ║  🟣 Lovable → SQL Editor → cole ISTO → Run.  Depois disso: `bun run db:aplicar`.        ║
-- ║                                                                                        ║
-- ║  ⚠️ ANTES DE COLAR: troque TROQUE_ESTA_SENHA por uma senha forte, e guarde-a em         ║
-- ║     ~/.config/afiacao/claude_rw.pgpass (modo 600). NUNCA cole a senha no chat.          ║
-- ║                                                                                        ║
-- ║  Idempotente: re-colar é seguro (não recria papel, não duplica ledger, não reseta       ║
-- ║  a senha de um papel que já existe).                                                    ║
-- ╚═══════════════════════════════════════════════════════════════════════════════════════╝

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 1) O PAPEL — identidade separada, sem poder próprio
-- ════════════════════════════════════════════════════════════════════════════════════════
-- A 1ª versão deste arquivo fazia `GRANT postgres TO claude_rw`. Produção RECUSOU:
--   42501: permission denied to grant role "postgres"
--   DETAIL: Only roles with the ADMIN option on role "postgres" may grant this role.
-- Medido depois: o papel `postgres` tem ZERO membros, o único superuser é `supabase_admin`
-- (fora do nosso alcance), e os 425 objetos de `public` são TODOS dele. O SQL Editor É o
-- `postgres`, e no PG16+ um papel não tem ADMIN sobre si mesmo — só quem o criou tem.
-- Conclusão medida: neste banco não dá para VIRAR postgres. Só dá para EXECUTAR como ele.
--
-- Então `claude_rw` nasce sem privilégio nenhum. Todo o poder mora na função da seção 3,
-- e o único direito deste papel é CHAMÁ-LA.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_rw') THEN
    CREATE ROLE claude_rw LOGIN NOINHERIT PASSWORD 'TROQUE_ESTA_SENHA';
  END IF;
END
$$;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 2) O LEDGER — o que torna a automação auditável
-- ════════════════════════════════════════════════════════════════════════════════════════
-- Duas metades, e a separação é o contrato:
--   • a TENTATIVA é gravada FORA da transação da migration → sobrevive ao rollback, então
--     apply que falhou deixa cicatriz em vez de sumir;
--   • o RECIBO é gravado DENTRO dela → se a migration volta atrás, o recibo volta junto.
--     Nunca existe "aplicada" para algo que não aplicou.
CREATE TABLE IF NOT EXISTS public.db_aplicacoes (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  arquivo       text        NOT NULL,
  sha256        text        NOT NULL,
  commit_sha    text,
  estado        text        NOT NULL DEFAULT 'tentativa'
                            CHECK (estado IN ('tentativa', 'aplicada', 'falhou', 'desconhecido')),
  ator          text        NOT NULL DEFAULT current_user,
  iniciado_em   timestamptz NOT NULL DEFAULT now(),
  concluido_em  timestamptz,
  erro          text
);

COMMENT ON TABLE public.db_aplicacoes IS
  'Trilha de aplicação de SQL em produção via `bun run db:aplicar`. Tentativa gravada fora '
  'da transação (sobrevive a rollback); recibo (estado=aplicada) gravado dentro dela.';

-- A trava contra aplicação DUPLA: os mesmos bytes não entram duas vezes com sucesso.
-- Parcial de propósito — tentativa/falha podem repetir; sucesso não.
CREATE UNIQUE INDEX IF NOT EXISTS db_aplicacoes_sha_aplicada_uniq
  ON public.db_aplicacoes (sha256) WHERE estado = 'aplicada';

CREATE INDEX IF NOT EXISTS db_aplicacoes_iniciado_em_idx
  ON public.db_aplicacoes (iniciado_em DESC);

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 3) A FUNÇÃO — a porta, e é uma porta de verdade
-- ════════════════════════════════════════════════════════════════════════════════════════
-- Sem rodeio sobre o que isto é: uma função SECURITY DEFINER que executa SQL arbitrário com
-- os privilégios de `postgres`. Quem consegue chamá-la É postgres, na prática. É a MESMA
-- autoridade do `GRANT postgres TO claude_rw` que a plataforma recusou — não é mais, e a
-- honestidade sobre isso é o que permite tratá-la com o cuidado certo.
--
-- O que a estreita, de fato:
--   • EXECUTE revogado de PUBLIC **e** de anon (as duas pontas — database.md), concedido
--     nominalmente só a `claude_rw`, cuja senha vive só na máquina do founder;
--   • `search_path` fixo no corpo: SECURITY DEFINER com search_path aberto é escalada de
--     privilégio via objeto plantado noutro schema;
--   • some inteira com um `DROP FUNCTION` — a porta é revogável sem tocar em mais nada.
--
-- E o que ela ACRESCENTA sobre o desenho recusado: o SQL chega como PARÂMETRO, então ela
-- reconfere o SHA-256 do que recebeu contra o que o chamador declarou. Se o transporte
-- mexeu um byte, a aplicação é recusada ANTES de executar. Isso o `GRANT` não daria.
CREATE OR REPLACE FUNCTION public.aplicar_sql(
  p_sql  text,
  p_sha  text,
  p_id   bigint
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $funcao$
DECLARE
  v_sha_real   text;
  v_sha_ledger text;
BEGIN
  IF p_sql IS NULL OR length(btrim(p_sql)) = 0 THEN
    RAISE EXCEPTION 'APLICAR_SQL: corpo vazio' USING ERRCODE = '22023';
  END IF;

  -- Integridade ponta-a-ponta: os bytes que vão RODAR são os bytes que foram REGISTRADOS.
  v_sha_real := encode(sha256(convert_to(p_sql, 'UTF8')), 'hex');
  IF v_sha_real IS DISTINCT FROM p_sha THEN
    RAISE EXCEPTION 'APLICAR_SQL: sha divergente (declarado=%, recebido=%)', p_sha, v_sha_real
      USING ERRCODE = '22023';
  END IF;

  -- TRAVA e VALIDA a tentativa ANTES do EXECUTE. Conferir só depois seria tarde: o corpo já
  -- teria rodado. E `WHERE id = p_id` sozinho não bastava — aceitava um id JÁ fechado (o corpo
  -- executava de novo e a mesma linha era reescrita, sem violar unicidade nenhuma) e aceitava
  -- um id de OUTRO hash (recibo apontando para bytes que não são os que rodaram). O FOR UPDATE
  -- serializa quem tentar usar a mesma tentativa em paralelo.
  SELECT sha256 INTO v_sha_ledger
    FROM public.db_aplicacoes
   WHERE id = p_id AND estado = 'tentativa'
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'APLICAR_SQL: tentativa % inexistente ou já fechada — NADA foi executado', p_id
      USING ERRCODE = '22023';
  END IF;

  -- O ensaio grava o hash prefixado (a linha morre no ROLLBACK); fora isso, tem de bater.
  IF v_sha_ledger NOT IN (p_sha, 'ensaio:' || p_sha) THEN
    RAISE EXCEPTION 'APLICAR_SQL: tentativa % é de OUTRO corpo (ledger=%, recebido=%)',
      p_id, v_sha_ledger, p_sha USING ERRCODE = '22023';
  END IF;

  -- O apply. Erro aqui aborta a função inteira, e com ela o recibo abaixo: é o que garante
  -- que "aplicada" nunca sobrevive a uma migration que voltou atrás.
  EXECUTE p_sql;

  UPDATE public.db_aplicacoes
     SET estado = 'aplicada', concluido_em = now()
   WHERE id = p_id AND estado = 'tentativa';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'APLICAR_SQL: recibo % não pôde ser fechado', p_id USING ERRCODE = '22023';
  END IF;

  RETURN 'FIM_APLICACAO_OK';
END
$funcao$;

COMMENT ON FUNCTION public.aplicar_sql(text, text, bigint) IS
  'Porta de escrita automatizada (SECURITY DEFINER = postgres). Confere o sha256 do corpo '
  'antes de executar e grava o recibo na mesma transação. EXECUTE só para claude_rw.';

-- ════════════════════════════════════════════════════════════════════════════════════════
-- 4) RLS + ACL — as duas pontas, sempre
-- ════════════════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.db_aplicacoes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.db_aplicacoes FROM PUBLIC;
REVOKE ALL ON public.db_aplicacoes FROM anon;

-- Fechar função exige NOMEAR as duas pontas: `PUBLIC` e `anon` (database.md §4).
REVOKE ALL ON FUNCTION public.aplicar_sql(text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.aplicar_sql(text, text, bigint) FROM anon;
REVOKE ALL ON FUNCTION public.aplicar_sql(text, text, bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.aplicar_sql(text, text, bigint) TO claude_rw;

-- Staff LÊ o ledger (é trilha de auditoria — existe para ser lida).
GRANT SELECT ON public.db_aplicacoes TO authenticated;

DROP POLICY IF EXISTS db_aplicacoes_staff_le ON public.db_aplicacoes;
CREATE POLICY db_aplicacoes_staff_le ON public.db_aplicacoes
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('employee', 'master')
    )
  );

-- O ledger é a única coisa que `claude_rw` escreve por fora da função — de propósito: a
-- trilha não pode depender do mesmo poder que ela existe para vigiar.
-- UPDATE incluído de propósito: o recibo de sucesso é da FUNÇÃO, mas marcar a própria
-- tentativa como 'falhou'/'desconhecido' é do script — e essa anotação acontece justamente
-- quando a função abortou, isto é, quando ela não pode escrever nada.
GRANT SELECT, INSERT, UPDATE ON public.db_aplicacoes TO claude_rw;

DROP POLICY IF EXISTS db_aplicacoes_rw ON public.db_aplicacoes;
CREATE POLICY db_aplicacoes_rw ON public.db_aplicacoes
  FOR ALL TO claude_rw
  USING (true) WITH CHECK (true);

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════════════════
-- PÓS-CONDIÇÃO — o marcador positivo. Se você não vir `BOOTSTRAP_OK`, NÃO deu certo.
-- ════════════════════════════════════════════════════════════════════════════════════════
SELECT
  CASE
    WHEN (SELECT count(*) FROM pg_roles WHERE rolname = 'claude_rw') = 1
     AND to_regclass('public.db_aplicacoes') IS NOT NULL
     AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.db_aplicacoes'::regclass)
     AND NOT has_table_privilege('anon', 'public.db_aplicacoes', 'SELECT')
     AND has_table_privilege('claude_rw', 'public.db_aplicacoes', 'INSERT')
     AND (SELECT prosecdef FROM pg_proc WHERE oid = 'public.aplicar_sql(text,text,bigint)'::regprocedure)
     AND has_function_privilege('claude_rw', 'public.aplicar_sql(text,text,bigint)', 'EXECUTE')
     AND NOT has_function_privilege('anon',   'public.aplicar_sql(text,text,bigint)', 'EXECUTE')
     AND NOT has_function_privilege('public', 'public.aplicar_sql(text,text,bigint)', 'EXECUTE')
    THEN 'BOOTSTRAP_OK'
    ELSE 'BOOTSTRAP_FALHOU — não prossiga; me mande esta linha'
  END AS resultado;
