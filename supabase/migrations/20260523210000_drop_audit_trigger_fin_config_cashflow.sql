-- Hotfix: remove o trigger de auditoria (trg_audit → fin_audit_trigger) da tabela de
-- configuração fin_config_cashflow.
--
-- Motivo: fin_audit_trigger() deriva um período via CASE sobre data_emissao/data_movimento/
-- etc. Essas colunas não existem em fin_config_cashflow (é tabela de CONFIG, não tem período),
-- então qualquer UPDATE/INSERT na tabela falhava com:
--   ERROR 42703: column "data_emissao" not found in data type fin_config_cashflow
-- (ALTER passava porque não dispara trigger de linha; o erro só aparecia ao escrever dados).
--
-- O trigger foi anexado por engano a uma tabela de configuração (period-lock/auditoria por
-- período só faz sentido em tabelas transacionais: fin_contas_receber/pagar, fin_movimentacoes,
-- fin_dre_snapshots, fin_estoque_valor...). A função fin_audit_trigger() é COMPARTILHADA e
-- permanece intacta nas demais tabelas — aqui só destacamos o trigger desta tabela de config.
--
-- Aplicado manualmente no Supabase do Lovable em 2026-05-23 (este arquivo registra a correção
-- pra paridade repo↔produção). Idempotente.

DROP TRIGGER IF EXISTS trg_audit ON public.fin_config_cashflow;
