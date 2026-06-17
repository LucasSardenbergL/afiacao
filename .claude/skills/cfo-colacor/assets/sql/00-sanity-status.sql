-- ============================================================================
-- 00 — SANIDADE (rode SEMPRE primeiro)
-- 🟣 Lovable → SQL Editor → cola → Run
-- ----------------------------------------------------------------------------
-- Valida os valores REAIS de status_titulo e o frescor dos dados antes de tudo.
-- Status reais (COM espaço): receber = 'A VENCER'/'ATRASADO'/'VENCE HOJE'/'RECEBIDO'/'CANCELADO';
-- pagar = 'A VENCER'/'ATRASADO'/'PAGO'/'CANCELADO'.
-- 🔴 ARMADILHA-MÃE: o `saldo` NÃO zera na baixa. Se na query (a) os status quitados
-- ('RECEBIDO'/'PAGO') aparecerem com saldo_total ALTO (não ~0), está CONFIRMADO que o saldo
-- é furado → filtre "aberto" por status_titulo, NUNCA por saldo>0. (Ver schema, armadilha 1.)
-- READ-ONLY. Não altera nada.
-- ============================================================================

-- (a) valores reais de status_titulo por empresa (CR e CP)
SELECT 'receber' AS tabela, company, status_titulo,
       count(*) AS qtd, round(sum(saldo)::numeric, 2) AS saldo_total
FROM fin_contas_receber
GROUP BY company, status_titulo
UNION ALL
SELECT 'pagar' AS tabela, company, status_titulo,
       count(*), round(sum(saldo)::numeric, 2)
FROM fin_contas_pagar
GROUP BY company, status_titulo
ORDER BY tabela, company, status_titulo;

-- (b) frescor: até quando os dados vão por empresa (datas confirmadas no schema)
SELECT company,
       count(*)               AS titulos_cr,
       max(data_emissao)      AS ultima_emissao,
       max(data_vencimento)   AS ultimo_vencimento
FROM fin_contas_receber
GROUP BY company
ORDER BY company;

-- (c) último sync registrado (se a tabela tiver coluna de timestamp; senão use fin_confiabilidade.ultimo_sync)
SELECT company, ano, mes, ultimo_sync, fechamento_status
FROM fin_confiabilidade
ORDER BY ano DESC, mes DESC, company
LIMIT 9;
