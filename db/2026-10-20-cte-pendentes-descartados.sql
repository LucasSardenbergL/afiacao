-- Os 2 CT-e (modelo 57, frete, SEM itens) que a omie-nfe-recebimento-sync importou como recebimento
-- `pendente` até a v1.5 saem da tela de conferência: status `descartado` + motivo em `observacoes`.
-- Decisão do founder (2026-10-20): só os 2 pendentes; os 26 CT-e `efetivado` ficam como histórico.
-- Nada é apagado. Narrativa: docs/historico/nfe-recebimento-ignora-cte.md.
--
-- Caminho: `bun run db:aplicar db/2026-10-20-cte-pendentes-descartados.sql` (o executor dá a
-- transação — este arquivo NÃO leva BEGIN/COMMIT).
--
-- Idempotente: o UPDATE só pega linha que AINDA está `pendente`, sem itens, sem conferente e sem
-- trava de efetivação. Re-rodar é no-op, e a postcondição continua verde.
-- Fail-closed: se alguém começou a conferir uma delas, o UPDATE não a pega e a postcondição aborta.

UPDATE public.nfe_recebimentos r
SET status = 'descartado',
    observacoes = concat_ws(E'\n', nullif(r.observacoes, ''),
      'Descartado em 2026-10-20: CT-e (modelo 57, conhecimento de frete, sem itens de produto) importado por engano como recebimento pela omie-nfe-recebimento-sync até a v1.5. Não há mercadoria a conferir.')
WHERE r.id IN ('05330de5-8495-4878-8503-629bf86a1eac', '1b0f6ce6-0bb8-4349-8c5f-51845fbeee10')
  AND r.status = 'pendente'
  AND substr(r.chave_acesso, 21, 2) = '57'
  AND r.conferente_id IS NULL
  AND r.conferido_at IS NULL
  AND r.efetivacao_lock_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM public.nfe_recebimento_itens i WHERE i.nfe_recebimento_id = r.id);

DO $post$
DECLARE
  v_descartados int;
  v_cte_pendentes int;
  v_cte_total int;
  v_cte_efetivados int;
BEGIN
  SELECT count(*) INTO v_descartados
  FROM public.nfe_recebimentos
  WHERE id IN ('05330de5-8495-4878-8503-629bf86a1eac', '1b0f6ce6-0bb8-4349-8c5f-51845fbeee10')
    AND status = 'descartado'
    AND observacoes LIKE '%Descartado em 2026-10-20: CT-e (modelo 57%';
  IF v_descartados IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'A1 FALHOU: % de 2 CT-e pendentes viraram descartado com o motivo — algum já estava em uso ou mudou de estado; nada gravado', v_descartados;
  END IF;

  SELECT count(*) FILTER (WHERE status = 'pendente'),
         count(*),
         count(*) FILTER (WHERE status = 'efetivado')
    INTO v_cte_pendentes, v_cte_total, v_cte_efetivados
  FROM public.nfe_recebimentos
  WHERE substr(chave_acesso, 21, 2) = '57';
  IF v_cte_pendentes IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'A2 FALHOU: ainda há % CT-e pendente(s) — a tela de conferência continuaria mostrando frete', v_cte_pendentes;
  END IF;
  IF v_cte_total IS DISTINCT FROM 28 OR v_cte_efetivados IS DISTINCT FROM 26 THEN
    RAISE EXCEPTION 'A3 FALHOU: o passivo mudou de tamanho (total %, efetivados %; esperado 28 e 26) — a mudança só pode tocar os 2 pendentes', v_cte_total, v_cte_efetivados;
  END IF;
  RAISE NOTICE 'cte-pendentes-descartados OK: 2 descartados, 0 CT-e pendente, 26 efetivados intactos (28 no total)';
END
$post$;
