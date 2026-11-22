import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Follow-ups do #4068 / #4087 (Novo Pedido): FIAÇÃO ──
// O comportamento é provado nos helpers puros (resolver-opcao/selos, parcela-manual, helpers,
// dias-entrega, checkout-envelope). Hook e página são grandes demais para renderizar aqui; este
// arquivo prova que eles USAM os helpers (precedente: useUnifiedOrder.dadosPerdidos.test.ts).
const raiz = resolve(__dirname, '../../..');
const ler = (p: string) => readFileSync(resolve(raiz, p), 'utf8');
const pagina = ler('src/pages/UnifiedOrder.tsx');
const edicao = ler('src/components/salesOrderEdit/useSalesOrderEdit.ts');
const selecao = ler('src/hooks/unifiedOrder/useCustomerSelection.ts');
const carrinho = ler('src/hooks/unifiedOrder/useCart.ts');
const envio = ler('src/services/orderSubmission/submitOrder.ts');
const barra = ler('src/components/unified-order/CartSummaryBar.tsx');
const hook = ler('src/hooks/useUnifiedOrder.ts');

describe('A — estoque ausente não vira 0 no front', () => {
  it('venda assistida: o catálogo do selo passa null adiante (não `?? 0`)', () => {
    expect(pagina).toContain('estoque: p.estoque ?? null');
    expect(pagina).not.toContain('estoque: p.estoque ?? 0');
  });
  it('edição de pedido: o produto de tinta não fabrica estoque 0', () => {
    expect(edicao).toContain('estoque: tintPendingProduct.estoque ?? null');
    expect(edicao).not.toContain('estoque: tintPendingProduct.estoque ?? 0');
  });
});

describe('B1 — reconfirmar o prazo já selecionado marca "manual" no rascunho', () => {
  it('o callback do rascunho lê o espelho em STATE da marca e depende dele', () => {
    const ini = selecao.indexOf('const parcelasManuaisDaSelecao = useCallback(');
    expect(ini).toBeGreaterThan(-1);
    const corpo = selecao.slice(ini, selecao.indexOf('\n  );', ini));
    expect(corpo).toContain('parcelasManuaisParaRascunho(marcaManual,');
    expect(corpo).toContain('[marcaManual, selectedParcelaOben, selectedParcelaColacor]');
  });
  it('as duas escolhas manuais atualizam o espelho (objeto novo → re-render mesmo com o mesmo prazo)', () => {
    expect(selecao.match(/setMarcaManual\(parcelaManualRef\.current\);/g)?.length).toBe(2);
  });
});

describe('B2 — prazo do rascunho é conferido contra a lista carregada', () => {
  it('o restore passa pelo decidirParcelaDoRascunho, nas duas contas', () => {
    expect(pagina).toContain('return decidirParcelaDoRascunho(codigo,');
    expect(pagina).toContain("if (prazoVolta && d.parcelas?.oben) reaplicarParcelaDoRascunho('oben', d.parcelas.oben);");
    expect(pagina).toContain("if (prazoVolta && d.parcelas?.colacor) reaplicarParcelaDoRascunho('colacor', d.parcelas.colacor);");
    expect(pagina).not.toContain('h.setSelectedParcelaOben(d.parcelas.oben)');
    expect(pagina).not.toContain('h.setSelectedParcelaColacor(d.parcelas.colacor)');
  });
  it('Codex P1: "carregada" é POR CONTA (não o loadingFormas global das duas)', () => {
    expect(pagina).toContain('carregada: !estado.erro });');
    expect(pagina).not.toContain('carregada: !h.loadingFormas');
  });
  it('Codex P1: lista ainda chegando → reaplica e confere depois; retirada → marca para bloquear', () => {
    expect(pagina).toContain("if (decisao === 'inconferivel') setParcelasAConferir(p => ({ ...p, [conta]: codigo }));");
    expect(pagina).toContain("if (decisao === 'retirada') conferirParcelasRef.current.avisarParcelaRetirada(conta, codigo);");
    expect(pagina).toContain('h.marcarParcelaRetirada(conta, codigo);');
  });
  it('Codex P1: a retirada entra nas condições ausentes das DUAS contas (botão e caminho de envio)', () => {
    expect(hook).toContain('parcelasRetiradas.oben, selectedParcelaOben)');
    expect(hook).toContain('parcelasRetiradas.colacor, selectedParcelaColacor)');
  });
});

describe('B3 — subtotal de serviço na tela soma só preço > 0; payload da OS intacto', () => {
  it('o total da tela usa a soma de exibição', () => {
    expect(carrinho).toContain('const totalEstimated = obenSubtotal + colacorProdSubtotal + serviceSubtotalExibicao;');
    expect(pagina).toContain('serviceSubtotal={h.serviceSubtotalExibicao}');
  });
  it('cupom e resumo pós-envio usam a soma de exibição; o `subtotal` da OS segue o do carrinho', () => {
    expect(envio).toContain('serviceSubtotal: subtotalServicosParaExibicao(serviceItems, getServicePrice),');
    expect(envio).toContain('subtotalServicosParaExibicao(serviceItems, getServicePrice) + DELIVERY_FEES[delivery.option];');
    expect(envio).toContain('subtotal: subtotals.service,');
    expect(envio).toContain('total: subtotals.service + DELIVERY_FEES[delivery.option],');
  });
});

describe('B4 — "hoje" do seletor de entrega acompanha a virada', () => {
  it('a lista recalcula pelo dia corrente (não `useMemo` congelado) e limpa a data vencida', () => {
    expect(barra).not.toContain('useMemo(() => proximosDiasUteis(new Date()), [])');
    expect(barra).toContain('const hoje = useHojeLocal();');
    expect(barra).toContain('proximosDiasUteis(dataLocalDeISO(hoje)), [hoje]');
    expect(barra).toContain('dataEntregaVencida(readyByDate, diasEntrega)');
    expect(barra).toContain("setReadyByDate('');");
  });
  it('Codex P2: o caminho de envio confere a data pelo relógio de agora', () => {
    const ini = hook.indexOf('const submitOrder = useCallback(');
    const corpo = hook.slice(ini, hook.indexOf('await executarComTravaDeEnvio(', ini));
    expect(corpo).toContain('if (dataEntregaJaPassou(readyByDate)) {');
  });
});

describe('B5 — OS já enviada com horário trocado avisa', () => {
  it('o aviso vai como erro NÃO bloqueante (fora de afiacao_*), e `results` segue o rótulo puro', () => {
    expect(envio).toContain('const avisoOs = avisoOsAfiacaoDesatualizada(afiacaoJaEnviada, observacaoOsAfiacao);');
    expect(envio).toContain("if (avisoOs) errors.push({ step: 'aviso_os_afiacao_desatualizada', message: avisoOs });");
    expect(envio).toContain("results.push(afiacaoJaEnviada.numero ? `OS ${afiacaoJaEnviada.numero} (já enviada)` : 'OS Afiação (já enviada)');");
  });
  it('a marca guarda a observação que FOI (null quando a OS foi reconciliada)', () => {
    expect(envio).toContain('observacao: result.reconciliada ? null : observacaoOsAfiacao');
    expect(envio).toContain('notes: observacaoOsAfiacao,');
  });
  it('a assinatura idempotente NÃO passou a incluir notes/observação (não duplica a OS)', () => {
    const ini = envio.indexOf('const assinaturaAfiacao = assinaturaServicosAfiacao(');
    const corpo = envio.slice(ini, envio.indexOf(');', envio.indexOf('entrega: delivery.option', ini)));
    expect(corpo).not.toMatch(/notes|observa/);
  });
});
