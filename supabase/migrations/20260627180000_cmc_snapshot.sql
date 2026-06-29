-- Fase 2b (defasagem por cliente): CMC por DATA, backfillado do Omie.
-- Uma RPC Postgres não chama a API do Omie → o CMC-por-data tem que estar NO banco.
-- O edge cmc-snapshot-backfill escreve aqui (modo exato-por-âncora + grade mensal).
-- A RPC get_defasagem_cliente lê C_last = snapshot na data da âncora (janela ±7d).
--
-- §5.5: o snapshot guarda o que o Omie devolve HOJE pra uma data passada ("melhor
-- visão atual do custo passado"). Comparar C_last e C_now na MESMA base (ambos via
-- Omie hoje) é mais consistente que misturar congelado-na-época com vivo.
--
-- "Ausente ≠ zero": CHECK (cmc > 0) recusa custo 0/negativo na escrita (não fabricar).
-- Aplicar via SQL Editor. Validar no fim. Prova real: db/test-defasagem.sh (PG17).

CREATE TABLE IF NOT EXISTS public.cmc_snapshot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  omie_codigo_produto bigint NOT NULL,
  data_posicao date NOT NULL,
  cmc numeric NOT NULL CHECK (cmc > 0),
  synced_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account, omie_codigo_produto, data_posicao)
);

-- Lookup da RPC: (account, omie_codigo_produto, data_posicao) — o UNIQUE já cria o
-- índice composto, mas deixamos explícito o índice de lookup por clareza/intenção.
CREATE INDEX IF NOT EXISTS idx_cmc_snapshot_lookup
  ON public.cmc_snapshot (account, omie_codigo_produto, data_posicao);

ALTER TABLE public.cmc_snapshot ENABLE ROW LEVEL SECURITY;

-- Leitura staff (employee/master) — espelha cmc_ledger_select_staff. A RPC é
-- SECURITY DEFINER (bypassa RLS), mas leitura direta staff é inofensiva e simétrica.
DROP POLICY IF EXISTS "cmc_snapshot_select_staff" ON public.cmc_snapshot;
CREATE POLICY "cmc_snapshot_select_staff" ON public.cmc_snapshot
  FOR SELECT TO authenticated
  USING (has_role(auth.uid(), 'employee'::app_role) OR has_role(auth.uid(), 'master'::app_role));

-- Escrita: só service_role (o edge backfill usa SERVICE_ROLE_KEY). Sem policy de
-- INSERT/UPDATE p/ authenticated → authenticated não escreve. REVOKE explícito de
-- anon/authenticated (REVOKE FROM PUBLIC não tira anon/authenticated no Supabase).
REVOKE ALL ON public.cmc_snapshot FROM anon, authenticated;
GRANT SELECT ON public.cmc_snapshot TO authenticated;

-- ── Validação pós-apply ──
SELECT
  (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='cmc_snapshot') AS tabela_1,
  (SELECT count(*) FROM pg_policies WHERE tablename='cmc_snapshot') AS policies_1,
  (SELECT count(*) FROM pg_constraint WHERE conname LIKE '%cmc_snapshot%' AND contype='c') AS check_ge1,
  (SELECT count(*) FROM pg_indexes WHERE tablename='cmc_snapshot') AS idx_ge2;
-- esperado: 1, 1, >=1, >=2 (UNIQUE + idx_lookup + pkey)
