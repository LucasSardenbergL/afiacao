DROP TRIGGER IF EXISTS trg_period_lock ON fin_contas_receber;
CREATE TRIGGER trg_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON fin_contas_receber
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

DROP TRIGGER IF EXISTS trg_period_lock ON fin_contas_pagar;
CREATE TRIGGER trg_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON fin_contas_pagar
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

DROP TRIGGER IF EXISTS trg_period_lock ON fin_movimentacoes;
CREATE TRIGGER trg_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON fin_movimentacoes
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

DROP TRIGGER IF EXISTS trg_period_lock ON fin_categoria_dre_mapping;
CREATE TRIGGER trg_period_lock
  BEFORE UPDATE OR DELETE ON fin_categoria_dre_mapping
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();

DROP TRIGGER IF EXISTS trg_period_lock ON fin_orcamento;
CREATE TRIGGER trg_period_lock
  BEFORE INSERT OR UPDATE OR DELETE ON fin_orcamento
  FOR EACH ROW EXECUTE FUNCTION fin_period_lock_trigger();
