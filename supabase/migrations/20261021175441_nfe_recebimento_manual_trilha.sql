-- ============================================================================
-- nfe_recebimento_manual_trilha — trilha server-side da edge `process-nfe`
-- (aba "Manual" de /admin/estoque/recebimento), plano de melhoria v3 item 1.
--
-- A edge conclui o recebimento NO OMIE (AlterarRecebimento → AlterarEtapaRecebimento →
-- ConcluirRecebimento = entrada de estoque e fiscal no ERP) e, até aqui, não gravava NADA no
-- banco: o histórico vivia no localStorage do navegador. Esta tabela é o registro durável de
-- cada invocação, um evento por passo, gravado pela edge (service_role) ANTES de cada escrita
-- no Omie (resultado 'intencao') e DEPOIS dela (ok / erro / indeterminado).
--
-- Desenho:
--  - APPEND-ONLY: o trigger recusa UPDATE e DELETE para todos os papéis, inclusive o
--    service_role. Trilha que o próprio autor pode editar não é trilha (a `acoes_execucoes`
--    deixa o staff fechar a PRÓPRIA linha — por isso esta não reaproveita aquela).
--  - Só o service_role escreve. Staff (master/employee) LÊ; anon e customer não leem.
--    O default privileges do schema public dá ALL a anon/authenticated em tabela nova — o
--    REVOKE abaixo é o que fecha isso (a RLS sozinha não impede o INSERT de passar pelo grant
--    se alguém criar uma policy de escrita depois).
--  - `executado_por` sem FK: a trilha tem de sobreviver à exclusão do usuário.
--  - `criado_em` = clock_timestamp(): a ordem dos eventos de uma invocação é a ordem real.
--
-- Aplicação: `bun run db:aplicar` (sem BEGIN/COMMIT — a transação é do executor).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.nfe_recebimento_manual_trilha (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execucao_id   uuid NOT NULL,
  criado_em     timestamptz NOT NULL DEFAULT clock_timestamp(),
  executado_por uuid NOT NULL,
  conta         text NOT NULL CHECK (conta IN ('oben', 'colacor', 'afiacao')),
  nf_numero     text NOT NULL CHECK (length(nf_numero) BETWEEN 1 AND 20),
  n_id_receb    bigint,
  chave_nfe     text,
  passo         text NOT NULL CHECK (passo IN (
                  'inicio', 'nf_localizada', 'consulta', 'quantidades',
                  'alterar_recebimento', 'alterar_etapa', 'concluir_recebimento', 'fim')),
  resultado     text NOT NULL CHECK (resultado IN (
                  'ok', 'aviso', 'erro', 'indeterminado', 'recusado', 'intencao', 'pulado')),
  detalhe       jsonb NOT NULL DEFAULT '{}'::jsonb,
  versao        text NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nfe_receb_manual_trilha_execucao
  ON public.nfe_recebimento_manual_trilha (execucao_id, criado_em);
CREATE INDEX IF NOT EXISTS idx_nfe_receb_manual_trilha_criado
  ON public.nfe_recebimento_manual_trilha (criado_em DESC);

ALTER TABLE public.nfe_recebimento_manual_trilha ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.nfe_recebimento_manual_trilha FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.nfe_recebimento_manual_trilha TO authenticated;
GRANT SELECT, INSERT ON public.nfe_recebimento_manual_trilha TO service_role;

DROP POLICY IF EXISTS "nfe_receb_manual_trilha_select_staff" ON public.nfe_recebimento_manual_trilha;
CREATE POLICY "nfe_receb_manual_trilha_select_staff"
  ON public.nfe_recebimento_manual_trilha
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role)
      OR public.has_role(auth.uid(), 'employee'::public.app_role));

CREATE OR REPLACE FUNCTION public.nfe_recebimento_manual_trilha_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $f$
BEGIN
  RAISE EXCEPTION 'nfe_recebimento_manual_trilha é append-only (% recusado)', TG_OP
    USING ERRCODE = 'P0001';
END
$f$;

REVOKE ALL ON FUNCTION public.nfe_recebimento_manual_trilha_append_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_nfe_receb_manual_trilha_append_only ON public.nfe_recebimento_manual_trilha;
CREATE TRIGGER trg_nfe_receb_manual_trilha_append_only
  BEFORE UPDATE OR DELETE ON public.nfe_recebimento_manual_trilha
  FOR EACH ROW EXECUTE FUNCTION public.nfe_recebimento_manual_trilha_append_only();

-- Postcondição: o mesmo predicado da query de validação, invertido.
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = to_regclass('public.nfe_recebimento_manual_trilha') AND relrowsecurity) THEN
    RAISE EXCEPTION 'A1 FALHOU: nfe_recebimento_manual_trilha ausente ou sem RLS — a trilha leria/gravaria sem gate';
  END IF;
  IF has_table_privilege('anon', 'public.nfe_recebimento_manual_trilha', 'SELECT')
     OR has_table_privilege('authenticated', 'public.nfe_recebimento_manual_trilha', 'INSERT')
     OR has_table_privilege('authenticated', 'public.nfe_recebimento_manual_trilha', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.nfe_recebimento_manual_trilha', 'DELETE') THEN
    RAISE EXCEPTION 'A2 FALHOU: grant de escrita/leitura indevido em nfe_recebimento_manual_trilha — o REVOKE não pegou';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.nfe_recebimento_manual_trilha', 'INSERT') THEN
    RAISE EXCEPTION 'A3 FALHOU: service_role sem INSERT — a edge não consegue abrir a trilha e recusa todo recebimento';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = 'public.nfe_recebimento_manual_trilha'::regclass
                   AND tgname = 'trg_nfe_receb_manual_trilha_append_only' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'A4 FALHOU: trigger append-only ausente ou desligado — a trilha ficaria editável';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid = 'public.nfe_recebimento_manual_trilha'::regclass
                   AND polname = 'nfe_receb_manual_trilha_select_staff' AND polcmd = 'r') THEN
    RAISE EXCEPTION 'A5 FALHOU: policy de leitura do staff ausente — a tela não leria a trilha';
  END IF;
  RAISE NOTICE 'nfe_recebimento_manual_trilha: RLS on, só service_role escreve, append-only, staff lê';
END
$post$;
