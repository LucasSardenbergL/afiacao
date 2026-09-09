-- ============================================================
-- deploy_sonda_alvos — onda 3, pelo `db:aplicar` (SEM envelope de transação)
-- Espelha: supabase/migrations/20260908204421_deploy_sonda_alvos_onda3.sql (#2404, mergeado)
-- ============================================================
-- POR QUE ESTE ARQUIVO EXISTE, e não é duplicata à toa:
--
-- A migration da onda 3 foi escrita pela skill `lovable-db-operator`, que envolve o corpo em
-- `BEGIN; … COMMIT;` — correto para quem cola no SQL Editor do Lovable. O `db:aplicar` é o outro
-- caminho: ele já abre a transação, põe `SET LOCAL statement_timeout`, grava o recibo no ledger
-- DENTRO dela e fecha. Um `BEGIN;` no corpo estoura no `EXECUTE` de `aplicar_sql()`.
--
-- E não dá para "só remover o BEGIN no cliente": `aplicar_sql()` RE-CALCULA o sha256 do corpo e
-- compara com o declarado. Essa comparação é a garantia de que o que EXECUTOU é byte a byte o que
-- está no repo — tentei transformar o corpo em 2026-09-09 (#2421) e o banco recusou, com razão.
--
-- Então o mesmo efeito precisa de um arquivo próprio, sem envelope. É seguro repetir: o INSERT é
-- `ON CONFLICT DO NOTHING` e a postcondição confere o estado final, não o caminho.

INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES
  ('omie-vendas-sync',         'F4 onda 3: 189/189 closures com zero efeito ao OPTIONS; controle exigiu corpo {"action":"sync_products"} — com {} o roteador devolve 400/500 antes do 1o client.from'),
  ('omie-analytics-sync',      'F4 onda 3: 86/86 closures; controle {"action":"get_sync_state"} e a rota mais barata que ainda toca o banco (3 efeitos, zero fetch externo)'),
  ('generate-bundle-argument', 'F4 onda 3: 14/14 closures; controle com bundle/customer/customerProfile minimos, que chegam ao POST do gateway de IA')
ON CONFLICT (edge) DO NOTHING;

-- ------------------------------------------------------------
-- Postcondição — aborta a transação do `db:aplicar` se o estado final não bater
-- ------------------------------------------------------------
DO $post$
DECLARE
  v_faltando text;
  v_total    int;
BEGIN
  SELECT string_agg(e, ', ') INTO v_faltando
  FROM unnest(ARRAY[
    'omie-vendas-sync', 'omie-analytics-sync', 'generate-bundle-argument'
  ]) AS e
  WHERE NOT EXISTS (
    SELECT 1 FROM public.deploy_sonda_alvos a WHERE a.edge = e AND a.ativo
  );
  IF v_faltando IS NOT NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: alvo(s) ausente(s) ou inativo(s): % — o cron nao sondaria essas edges', v_faltando;
  END IF;

  SELECT count(*) INTO v_total FROM public.deploy_sonda_alvos WHERE ativo;
  IF v_total <> 14 THEN
    RAISE EXCEPTION 'A2 FALHOU: esperava 14 alvos ativos (7 base + 4 onda 2 + 3 onda 3), achei % — banco e repo divergiram', v_total;
  END IF;
END
$post$;
