-- As 2 NF-e (modelo 55) `pendente` SEM itens que a importação antiga deixou na conferência estão
-- CANCELADAS no Omie: a importação por chave (mesmo caminho do botão, recibos #661 e #663 do
-- db:aplicar, requests 125479 e 125481) respondeu 409 `cancelada` às duas em 2026-10-21. Não há
-- mercadoria a conferir nem efetivar: saem da tela com status `descartado` + motivo em `observacoes`,
-- no mesmo molde dos CT-e do #3258 (db/2026-10-20-cte-pendentes-descartados.sql). Decisão do
-- founder (2026-10-21). Nada é apagado.
--
-- Caminho: `bun run db:aplicar db/2026-10-21-nfe-canceladas-descartadas.sql` (o executor dá a
-- transação — este arquivo NÃO leva BEGIN/COMMIT).
--
-- Idempotente: o UPDATE só pega linha que AINDA está `pendente`, sem itens, sem conferente, sem
-- efetivação e sem trava. Re-rodar é no-op, e a postcondição continua verde.
-- Fail-closed: se alguém começou a conferir uma delas, o UPDATE não a pega e a postcondição aborta.
-- O claim da efetivação já recusa `descartado` (#3258).

UPDATE public.nfe_recebimentos r
SET status = 'descartado',
    observacoes = concat_ws(E'\n', nullif(r.observacoes, ''),
      'Descartado em 2026-10-21: NF-e CANCELADA no Omie (importação por chave respondeu 409 cancelada). Ficou pendente sem itens desde a importação antiga; não há mercadoria a conferir nem efetivar.')
WHERE r.id IN ('8f554f93-0e59-45e0-a32e-c0014b70aca5', '0af66db4-86dd-40d6-ac9c-153cbda4d64e')
  AND r.status = 'pendente'
  AND substr(r.chave_acesso, 21, 2) = '55'
  AND r.conferente_id IS NULL
  AND r.conferido_at IS NULL
  AND r.efetivado_at IS NULL
  AND r.efetivacao_lock_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.nfe_recebimento_itens i WHERE i.nfe_recebimento_id = r.id);

DO $post$
DECLARE
  v_descartados int;
  v_pend_sem_itens int;
  v_desc_total int;
  v_total int;
BEGIN
  SELECT count(*) INTO v_descartados
  FROM public.nfe_recebimentos
  WHERE id IN ('8f554f93-0e59-45e0-a32e-c0014b70aca5', '0af66db4-86dd-40d6-ac9c-153cbda4d64e')
    AND status = 'descartado'
    AND observacoes LIKE '%Descartado em 2026-10-21: NF-e CANCELADA no Omie%';
  IF v_descartados IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'A1 FALHOU: % de 2 NF-e canceladas viraram descartado com o motivo — alguma já estava em uso ou mudou de estado; nada gravado', v_descartados;
  END IF;

  SELECT count(*) INTO v_pend_sem_itens
  FROM public.nfe_recebimentos r
  WHERE r.status = 'pendente'
    AND NOT EXISTS (SELECT 1 FROM public.nfe_recebimento_itens i WHERE i.nfe_recebimento_id = r.id);
  IF v_pend_sem_itens IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'A2 FALHOU: ainda há % recebimento(s) pendente(s) sem itens — a conferência continuaria com pendência fantasma', v_pend_sem_itens;
  END IF;

  SELECT count(*) FILTER (WHERE status = 'descartado'), count(*) INTO v_desc_total, v_total
  FROM public.nfe_recebimentos;
  IF v_desc_total IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'A3 FALHOU: % descartados no total (esperado 4: os 2 CT-e do #3258 + estas 2) — a mudança tocou outra linha', v_desc_total;
  END IF;
  RAISE NOTICE 'nfe-canceladas-descartadas OK: 2 descartadas, 0 pendente sem itens, 4 descartados no total (% recebimentos)', v_total;
END
$post$;
