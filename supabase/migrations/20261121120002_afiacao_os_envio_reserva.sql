-- ============================================================
-- afiacao_os_envio — reserva IDEMPOTENTE da OS de Afiação por pedido (checkout)
-- Follow-up Codex do #4042: a OS duplicava quando o Omie aceitava o IncluirOS e a resposta se
-- perdia antes de chegar ao navegador (chave com Date.now() + orderId novo a cada envio).
--
-- A edge `omie-sync` (sync_order, v1.15+) grava esta linha ANTES do IncluirOS:
--   · order_id (PK) = checkoutId do envelope do front → 2 envios do mesmo checkout disputam a
--     MESMA linha (atomicidade pela PK, não por leitura-antes-de-escrever);
--   · assinatura = o que foi pedido NA 1ª tentativa (imutável — o payload_enviado de
--     omie_ordens_servico é reescrito pelo AlterarOS e não serve de prova da criação);
--   · omie_codigo_os/omie_numero_os = a OS que existe no Omie, gravados UMA vez
--     (UPDATE … WHERE omie_codigo_os IS NULL) por quem incluiu ou reconciliou.
-- Só a edge (service_role) escreve; staff só lê (diagnóstico).
-- Aditiva: nenhuma tabela existente muda.
-- ============================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.afiacao_os_envio (
  order_id            uuid PRIMARY KEY,
  chave_integracao    text NOT NULL UNIQUE,
  assinatura          text,               -- NULL = front antigo (sem assinatura): nunca "confere"
  omie_codigo_cliente bigint NOT NULL,
  omie_codigo_os      bigint,
  omie_numero_os      text,
  desfecho            text CHECK (desfecho IN ('incluida', 'reconciliada')),
  criado_em           timestamptz NOT NULL DEFAULT now(),
  confirmado_em       timestamptz,
  CONSTRAINT afiacao_os_envio_os_coerente CHECK (
    (omie_codigo_os IS NULL AND desfecho IS NULL AND confirmado_em IS NULL)
    OR (omie_codigo_os > 0 AND desfecho IS NOT NULL AND confirmado_em IS NOT NULL)
  )
);

ALTER TABLE public.afiacao_os_envio ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.afiacao_os_envio FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.afiacao_os_envio TO authenticated;
GRANT ALL ON public.afiacao_os_envio TO service_role;

DROP POLICY IF EXISTS "afiacao_os_envio_select_staff" ON public.afiacao_os_envio;
CREATE POLICY "afiacao_os_envio_select_staff"
  ON public.afiacao_os_envio
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND role IN ('employee'::public.app_role, 'master'::public.app_role)
    )
  );

DO $post$
BEGIN
  IF to_regclass('public.afiacao_os_envio') IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: afiacao_os_envio nao existe - a edge omie-sync v1.15 recusa criar OS sem a reserva';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.afiacao_os_envio'::regclass) THEN
    RAISE EXCEPTION 'A2 FALHOU: afiacao_os_envio sem RLS';
  END IF;
  IF has_table_privilege('authenticated', 'public.afiacao_os_envio', 'INSERT')
     OR has_table_privilege('authenticated', 'public.afiacao_os_envio', 'UPDATE')
     OR has_table_privilege('anon', 'public.afiacao_os_envio', 'SELECT') THEN
    RAISE EXCEPTION 'A3 FALHOU: authenticated/anon com escrita (ou anon com leitura) em afiacao_os_envio';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.afiacao_os_envio', 'INSERT')
     OR NOT has_table_privilege('service_role', 'public.afiacao_os_envio', 'UPDATE') THEN
    RAISE EXCEPTION 'A4 FALHOU: service_role sem INSERT/UPDATE em afiacao_os_envio - a edge nao reserva';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.afiacao_os_envio'::regclass AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'A5 FALHOU: chave_integracao sem UNIQUE';
  END IF;
  RAISE NOTICE 'afiacao_os_envio OK: tabela + RLS + ACL + unique';
END
$post$;

COMMIT;
