# Gestão Financeira: KPI "Saldo Bancário" oculto até existir fonte

- **2026-10-19 (plano v2 #3, decisão do founder "ocultar o indicador"):** `FinanceiroGestao` exibia `Saldo Bancário = R$ 0,00` a partir de uma constante fixa (`saldoBancario = 0`, TODO da tabela `fin_saldo_bancario`, que não existe). Zero fabricado onde o dado está ausente — viola "ausente ≠ zero" do money-path.
- **Correção:** o card e a constante saíram; o grid de KPIs passou a 3 colunas (Total a Receber · Total a Pagar · Inadimplência %). Teste negativo `FinanceiroGestao.saldo-bancario-oculto.test.tsx` afirma que o rótulo não aparece.
- **Para voltar:** só com a fonte real `fin_saldo_bancario` (não implementada aqui) e estado "indisponível" quando a leitura falhar — nunca 0. Frontend: exige Publish do Lovable (do founder).
