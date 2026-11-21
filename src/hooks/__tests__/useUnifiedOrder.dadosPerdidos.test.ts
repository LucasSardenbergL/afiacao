import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Rodada 2 da auditoria do Novo Pedido (PR B — dados errados ou perdidos): FIAÇÃO ──
// O comportamento é provado nos helpers puros (dias-entrega, exibicao-produto, parcela-manual,
// submitOrder §B4/B6). O hook e a página são grandes demais para renderizar aqui; este arquivo
// prova que eles USAM os helpers (precedente: useUnifiedOrder.envioRobusto.test.ts).
const raiz = resolve(__dirname, '../../..');
const hook = readFileSync(resolve(raiz, 'src/hooks/useUnifiedOrder.ts'), 'utf8');
const selecao = readFileSync(resolve(raiz, 'src/hooks/unifiedOrder/useCustomerSelection.ts'), 'utf8');
const pagina = readFileSync(resolve(raiz, 'src/pages/UnifiedOrder.tsx'), 'utf8');
const busca = readFileSync(resolve(raiz, 'src/components/unified-order/ProductItemForm.tsx'), 'utf8');
const carrinho = readFileSync(resolve(raiz, 'src/components/unified-order/CartItemList.tsx'), 'utf8');

function corpoDo(nome: string): string {
  const ini = hook.indexOf(`const ${nome} = useCallback(`);
  expect(ini, `${nome} não encontrado`).toBeGreaterThan(-1);
  const fim = hook.indexOf('\n  }, [', ini);
  return hook.slice(ini, fim);
}

describe('Novo Pedido — fiação do PR B', () => {
  it('B2: limparCamposDoPedido zera observação, dia de entrega e OC', () => {
    const corpo = corpoDo('limparCamposDoPedido');
    expect(corpo).toContain("setNotes('');");
    expect(corpo).toContain("setReadyByDate('');");
    expect(corpo).toContain("setOrdemCompra('');");
    expect(corpo).toContain("setSelectedTimeSlot('');");
  });

  it('B2: trocar de cliente limpa observação, dia de entrega, horário e OC (não só a OC)', () => {
    const corpo = corpoDo('clearCustomer');
    expect(corpo).toContain("setOrdemCompra(''); setNotes(''); setReadyByDate(''); setSelectedTimeSlot('');");
  });

  it('B2: sucesso TOTAL do pedido e orçamento salvo limpam os campos do pedido', () => {
    expect(corpoDo('submitOrder')).toMatch(/if \(result\.allConfirmed\) \{\s*clearCart\(\);\s*limparCamposDoPedido\(\);/);
    expect(corpoDo('submitQuote')).toMatch(/clearCart\(\);\s*limparCamposDoPedido\(\);\s*navigate\('\/sales\/quotes'\);/);
  });

  it('B6: o horário escolhido na aba Afiação vai no delivery do envio', () => {
    expect(corpoDo('submitOrder')).toContain('timeSlot: selectedTimeSlot,');
  });

  it('B7: a seleção expõe o prazo manual e a página o grava no rascunho', () => {
    expect(selecao).toContain('parcelasManuaisDaSelecao,');
    expect(pagina).toContain('parcelasManuais: parcelasManuaisDaSelecao(),');
  });

  it('B7: o restore reaplica o prazo pelos setters exportados, com o guard de cliente', () => {
    const ini = pagina.indexOf('const handleRestore = () => {');
    const restore = pagina.slice(ini, pagina.indexOf('\n  };', ini));
    expect(restore).toContain('lerParcelasDoRascunho(state.parcelasManuais)');
    expect(restore).toContain('if (codigoAtual === codigoRascunho) aplicarParcelasDoRascunho(parcelas);');
    expect(restore).toContain('parcelasPendentesRef.current = { codigoCliente: codigoRascunho, parcelas };');
    // O guard de cliente diferente segue ANTES (rascunho de outro cliente não aplica nada).
    expect(restore.indexOf("toast.error('Rascunho de outro cliente'")).toBeLessThan(restore.indexOf('lerParcelasDoRascunho'));
    expect(pagina).toContain('if (pendente.codigoCliente !== codigoClienteSelecionado) return;');
    // codigo_cliente 0 não identifica ninguém: 0 === 0 aplicaria o prazo de A em B.
    expect(restore).toContain("if (parcelas && typeof codigoRascunho === 'number' && codigoRascunho > 0) {");
  });

  it('B4: o carrinho trata serviço com preço ≤0 como A orçar e rotula Subtotal conhecido', () => {
    expect(carrinho).toContain('{price !== null && price > 0 ? (');
    expect(carrinho).toContain("{servicosAOrcar > 0 && totalEstimated > 0 ? 'Subtotal conhecido' : 'Total'}");
  });

  it('B4/B5: a busca de produto usa os rótulos honestos (sem `estoque ?? 0`)', () => {
    expect(busca).not.toContain('estoque ?? 0');
    expect(busca).toContain('seloEstoque(product.estoque)');
    expect(busca).toContain('rotuloPrecoProduto(');
  });
});
