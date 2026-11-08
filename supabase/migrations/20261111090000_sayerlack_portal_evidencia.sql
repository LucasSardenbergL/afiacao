-- ============================================================================================
-- 7.2 do plano Sayerlack (revisão 2, 2026-11-08): EVIDÊNCIA DURÁVEL e IMUTÁVEL de cada leitura do portal
-- ============================================================================================
-- Migration MANUAL (custom não auto-aplica no Lovable): aplicar pelo envelope (`bun run db:aplicar`), que fornece a
-- transação (por isso NÃO há BEGIN/COMMIT aqui).
--
-- O BURACO: o ledger da importadora (`acoes_execucoes`, acao reposicao.importar_portal_sayerlack) guarda só o RESUMO
-- da tentativa. O que o portal mostrou — linha da consulta, itens brutos do busca-itens-pedido, condição e o conjunto de
-- opções — morria na resposta. Sem isso não há como auditar uma compra depois, nem comparar o pedido com uma leitura
-- posterior (5.2, "alterado no portal").
--
-- O DESENHO:
--   - 1 linha por leitura do portal (cada chamada ao Browserless da importadora), INSERT-only: UPDATE/DELETE recusados
--     por trigger (42501), inclusive para service_role;
--   - correlação pelo id da tentativa no ledger (`execucao_id` = acoes_execucoes.id; o ledger guarda `evidencia_id` de
--     volta). Sem FK: o ledger é fail-open (pode não ter aberto) e a evidência não pode depender dele;
--   - 1 escritor: a edge sayerlack-importar-pedido-portal (service_role). anon/authenticated sem escrita; staff lê.
-- Prova: db/test-sayerlack-portal-evidencia.sh (PG17, 2 locales, --falsificar).
-- Diário: docs/historico/importar-pedido-portal-sayerlack.md
-- ============================================================================================

CREATE TABLE IF NOT EXISTS public.sayerlack_portal_evidencia (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  execucao_id      uuid,
  protocolo        text NOT NULL CHECK (protocolo ~ '^[0-9]{3,12}$'),
  pedido_id        bigint,
  origem           text NOT NULL CHECK (origem IN ('manual', 'automatica')),
  somente_situacao boolean NOT NULL DEFAULT false,
  lido_de          timestamptz NOT NULL,
  lido_ate         timestamptz NOT NULL,
  http_status      integer,
  leitura_ok       boolean NOT NULL,
  erro_tipo        text,
  erro             text,
  consulta_headers jsonb,
  consulta_linhas  jsonb,
  itens_brutos     jsonb,
  condicao         text,
  condicoes_opcoes jsonb,
  trace            jsonb,
  gravado_em       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sayerlack_portal_evidencia_intervalo CHECK (lido_ate >= lido_de),
  -- Teto de tamanho: evidência, não depósito (uma leitura real tem poucos KB; o trace é cortado na edge).
  CONSTRAINT sayerlack_portal_evidencia_tamanho CHECK (
    octet_length(coalesce(consulta_linhas::text, '') || coalesce(itens_brutos::text, '') ||
                 coalesce(condicoes_opcoes::text, '') || coalesce(trace::text, '') ||
                 coalesce(consulta_headers::text, '') || coalesce(erro, '')) <= 524288
  )
);
COMMENT ON TABLE public.sayerlack_portal_evidencia IS
  '7.2 Sayerlack: o que o portal mostrou em cada leitura da importadora (imutável; 1 escritor = edge sayerlack-importar-pedido-portal; correlação execucao_id = acoes_execucoes.id).';

CREATE INDEX IF NOT EXISTS sayerlack_portal_evidencia_protocolo_idx
  ON public.sayerlack_portal_evidencia (protocolo, lido_ate DESC);
CREATE INDEX IF NOT EXISTS sayerlack_portal_evidencia_execucao_idx
  ON public.sayerlack_portal_evidencia (execucao_id) WHERE execucao_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sayerlack_portal_evidencia_pedido_idx
  ON public.sayerlack_portal_evidencia (pedido_id) WHERE pedido_id IS NOT NULL;

ALTER TABLE public.sayerlack_portal_evidencia ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sayerlack_portal_evidencia FROM PUBLIC;
REVOKE ALL ON TABLE public.sayerlack_portal_evidencia FROM anon;
REVOKE ALL ON TABLE public.sayerlack_portal_evidencia FROM authenticated;
REVOKE ALL ON TABLE public.sayerlack_portal_evidencia FROM service_role;
GRANT SELECT ON TABLE public.sayerlack_portal_evidencia TO authenticated;
GRANT SELECT, INSERT ON TABLE public.sayerlack_portal_evidencia TO service_role;
DROP POLICY IF EXISTS staff_le_portal_evidencia ON public.sayerlack_portal_evidencia;
CREATE POLICY staff_le_portal_evidencia ON public.sayerlack_portal_evidencia
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::app_role)) OR (SELECT public.has_role(auth.uid(), 'employee'::app_role)));

-- Imutável: nenhuma linha muda nem some, nem pelo dono do banco (o GRANT não basta: o trigger fecha a CLASSE).
CREATE OR REPLACE FUNCTION public.sayerlack__evidencia_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501',
    MESSAGE = '[EVIDENCIA-IMUTAVEL] evidência do portal Sayerlack não se altera nem se apaga (' || TG_OP || ')';
END;
$$;
REVOKE ALL ON FUNCTION public.sayerlack__evidencia_imutavel() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack__evidencia_imutavel() FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack__evidencia_imutavel() FROM authenticated;
DROP TRIGGER IF EXISTS trg_evidencia_imutavel ON public.sayerlack_portal_evidencia;
CREATE TRIGGER trg_evidencia_imutavel
  BEFORE UPDATE OR DELETE ON public.sayerlack_portal_evidencia
  FOR EACH ROW EXECUTE FUNCTION public.sayerlack__evidencia_imutavel();
DROP TRIGGER IF EXISTS trg_evidencia_imutavel_truncate ON public.sayerlack_portal_evidencia;
CREATE TRIGGER trg_evidencia_imutavel_truncate
  BEFORE TRUNCATE ON public.sayerlack_portal_evidencia
  FOR EACH STATEMENT EXECUTE FUNCTION public.sayerlack__evidencia_imutavel();

-- ── Postcondição (marcador positivo no fim) ────────────────────────────────────────────────
DO $pos$
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sayerlack_portal_evidencia'::regclass) THEN
    RAISE EXCEPTION 'POSTCONDICAO E1 FALHOU: evidência sem RLS';
  END IF;
  IF has_table_privilege('anon', 'public.sayerlack_portal_evidencia', 'SELECT')
     OR has_table_privilege('anon', 'public.sayerlack_portal_evidencia', 'INSERT')
     OR has_table_privilege('authenticated', 'public.sayerlack_portal_evidencia', 'INSERT')
     OR has_table_privilege('authenticated', 'public.sayerlack_portal_evidencia', 'UPDATE')
     OR has_table_privilege('service_role', 'public.sayerlack_portal_evidencia', 'UPDATE')
     OR has_table_privilege('service_role', 'public.sayerlack_portal_evidencia', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDICAO E2 FALHOU: escrita aberta fora do escritor (ou UPDATE/DELETE concedido)';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.sayerlack_portal_evidencia', 'INSERT') THEN
    RAISE EXCEPTION 'POSTCONDICAO E3 FALHOU: o escritor (service_role) não insere';
  END IF;
  IF (SELECT count(*) FROM pg_trigger
       WHERE tgrelid = 'public.sayerlack_portal_evidencia'::regclass
         AND tgname IN ('trg_evidencia_imutavel', 'trg_evidencia_imutavel_truncate') AND tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION 'POSTCONDICAO E4 FALHOU: evidência sem a trava de imutabilidade (UPDATE/DELETE/TRUNCATE)';
  END IF;
  RAISE NOTICE 'EVIDENCIA_PORTAL_OK: tabela imutável, RLS de leitura staff, 1 escritor (service_role INSERT)';
END
$pos$;
