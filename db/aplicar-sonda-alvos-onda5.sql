-- ============================================================
-- deploy_sonda_alvos — onda 5, pelo `db:aplicar` (SEM envelope de transação)
-- Espelha: supabase/migrations/20260909222423_deploy_sonda_alvos_onda5.sql
-- ============================================================
-- Mesma razão dos irmãos `aplicar-sonda-alvos-onda3.sql` e `-onda4.sql`: a migration nasce
-- envelopada em `BEGIN; … COMMIT;` para o SQL Editor, e o `db:aplicar` já provê a transação — o
-- corpo roda dentro dela via `EXECUTE`, onde comando de transação é proibido. E o corpo não pode
-- ser transformado no cliente: `aplicar_sql()` confere o sha256 do que recebeu contra o declarado,
-- que é a garantia de que o executado é byte a byte o que está no repo.
--
-- `omie-desconto-backfill` entra porque a prova mediu 2/2 closures com zero efeito ao OPTIONS do
-- relé, com degrau de controle. É a primeira edge de ESCRITA declarada a entrar: ela reescreve
-- `order_items.desconto_valor`, então o zero de (a) aqui não é formalidade — um OPTIONS que
-- caísse no fluxo normal seria um backfill não pedido a cada 2h. O que a torna segura é a ORDEM
-- dentro do handler, provada por execução e não por leitura: `atenderSondaOptions` responde e SAI
-- antes do `authorizeCronOrStaff`, do `createClient` e de qualquer chamada ao Omie.
--
-- O motivo de entrar agora é o custo recorrente de ficar fora: sem alvo de cron não há atestação
-- passiva, e em 2026-09-09 a edge foi sondada à MÃO duas vezes no mesmo dia (#2447 e #2451),
-- porque o #2448 mexeu no `index.ts` horas depois da 1ª atestação.

INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES
  ('omie-desconto-backfill', 'F4 onda 5: 2/2 closures com zero efeito ao OPTIONS e degrau de controle; primeira edge de ESCRITA declarada — o probe sai antes do createClient e de qualquer chamada ao Omie')
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
    WHERE a.edge = 'omie-desconto-backfill' AND a.ativo
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: omie-desconto-backfill ausente ou inativa — o cron nao sondaria essa edge, e o /fecho seguiria pedindo sonda manual';
  END IF;

  SELECT count(*) INTO v_total FROM public.deploy_sonda_alvos WHERE ativo;
  IF v_total <> 16 THEN
    RAISE EXCEPTION 'A2 FALHOU: esperava 16 alvos ativos (7 base + 4 onda 2 + 3 onda 3 + 1 onda 4 + 1 onda 5), achei % — banco e repo divergiram', v_total;
  END IF;
END
$post$;
