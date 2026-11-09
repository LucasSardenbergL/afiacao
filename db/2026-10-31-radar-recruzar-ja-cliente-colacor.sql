-- Recruzamento do `ja_cliente` do Radar logo após o primeiro snapshot de não-vinculados Colacor —
-- 2026-10-31, fora do cron.
--
-- POR QUÊ: `radar_recruzar_ja_cliente()` (cron 06:15Z) lê profiles.document ∪
-- omie_clientes_nao_vinculados.cnpj_cpf sem filtro de empresa. O snapshot Colacor (disparo
-- db/2026-10-31-nao-vinculados-colacor-primeiro-snapshot.sql, recibo #797) acabou de pôr os clientes
-- Colacor SEM usuário na tabela; sem este run eles só entrariam no cron de amanhã.
-- A função é a mesma do cron (prosrc md5 3bb62946f182f9a8ed30aa8061512303): só MARCA ja_cliente=true,
-- nunca desmarca — rodar de novo é inócuo.
--
-- Pré-condição (P0): os dois snapshots Colacor `complete` hoje. Sem isso, aborta (transação inteira).
-- Aplicado por `bun run db:aplicar`.
DO $recruzar$
DECLARE
  v_ok  integer;
  v_n   integer;
BEGIN
  SELECT count(*) INTO v_ok FROM public.omie_nao_vinculados_state
   WHERE empresa IN ('colacor_sc', 'colacor') AND status = 'complete'
     AND last_complete_synced_at >= '2026-10-31 18:00:00+00';
  IF v_ok IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'P0 FALHOU: % de 2 snapshots Colacor complete desde 2026-10-31 18:00Z — recruzar agora não leria a Colacor', v_ok;
  END IF;
  SELECT public.radar_recruzar_ja_cliente() INTO v_n;
  IF v_n IS NULL THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_recruzar_ja_cliente devolveu NULL';
  END IF;
  RAISE NOTICE 'radar_recruzar_ja_cliente: % empresa(s) marcadas ja_cliente', v_n;
END
$recruzar$;
-- Medição (read-only, psql-ro): SELECT uf, count(*) FROM radar_empresas WHERE ja_cliente GROUP BY uf ORDER BY 2 DESC;
-- Baseline 2026-10-31 16:15Z: MG 3003 · SP 3 · PA/ES/PR/RJ/RS/PE/MT 1 · SC 0.
