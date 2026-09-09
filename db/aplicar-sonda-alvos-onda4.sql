-- ============================================================
-- deploy_sonda_alvos — onda 4, pelo `db:aplicar` (SEM envelope de transação)
-- Espelha: supabase/migrations/20260908223555_deploy_sonda_alvos_onda4.sql (#2415, mergeado)
-- ============================================================
-- Mesma razão do irmão `aplicar-sonda-alvos-onda3.sql`: a migration nasce envelopada em
-- `BEGIN; … COMMIT;` para o SQL Editor, e o `db:aplicar` já provê a transação — o corpo roda
-- dentro dela via `EXECUTE`, onde comando de transação é proibido. E o corpo não pode ser
-- transformado no cliente: `aplicar_sql()` confere o sha256 do que recebeu contra o declarado,
-- que é a garantia de que o executado é byte a byte o que está no repo.
--
-- `omie-sync-nfes-recebidas` entra porque a classe `NAO_COMPILA` (#2415) dispensou o único
-- closure que faltava: `b880daeb1` (2026-04-19) tem `index.ts` que não parseia, então nunca
-- bootou e nunca serviu tráfego. 35/36 provados, o 36º impossível.

INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES
  ('omie-sync-nfes-recebidas', 'F4 onda 4: 35/36 closures com zero efeito ao OPTIONS; o 36o (b880daeb1) e NAO_COMPILA — index.ts nao parseia, logo nunca bootou nem serviu trafego')
ON CONFLICT (edge) DO NOTHING;

-- ------------------------------------------------------------
-- Postcondição — aborta a transação do `db:aplicar` se o estado final não bater
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_total int;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.deploy_sonda_alvos a
    WHERE a.edge = 'omie-sync-nfes-recebidas' AND a.ativo
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: omie-sync-nfes-recebidas ausente ou inativa — o cron nao sondaria essa edge';
  END IF;

  SELECT count(*) INTO v_total FROM public.deploy_sonda_alvos WHERE ativo;
  IF v_total <> 15 THEN
    RAISE EXCEPTION 'A2 FALHOU: esperava 15 alvos ativos (7 base + 4 onda 2 + 3 onda 3 + 1 onda 4), achei % — banco e repo divergiram', v_total;
  END IF;
END
$post$;
