-- ============================================================
-- Anexa fin_audit_trigger às tabelas financeiras críticas
-- ============================================================

DROP TRIGGER IF EXISTS trg_audit ON fin_contas_receber;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_contas_receber
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_contas_pagar;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_contas_pagar
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_categoria_dre_mapping;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_categoria_dre_mapping
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_orcamento;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_orcamento
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_fechamentos;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_fechamentos
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();

DROP TRIGGER IF EXISTS trg_audit ON fin_eliminacoes_intercompany;
CREATE TRIGGER trg_audit
  AFTER INSERT OR UPDATE OR DELETE ON fin_eliminacoes_intercompany
  FOR EACH ROW EXECUTE FUNCTION fin_audit_trigger();
