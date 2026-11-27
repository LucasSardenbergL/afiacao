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
    expect(restore).toContain('const decisao = decidirRestore(codigoRascunho, codigoAtual);');
    // O guard de cliente diferente segue ANTES (rascunho de outro cliente não aplica nada).
    expect(restore.indexOf("if (decisao === 'recusar') {")).toBeLessThan(restore.indexOf('lerParcelasDoRascunho'));
    // codigo_cliente 0 não identifica ninguém: o prazo só volta com cliente identificado.
    expect(restore).toContain('aplicarDadosDoRascunho(dados, codigoClienteIdentifica(codigoRascunho));');
    // Follow-up do #4068: segue pelo setter EXPORTADO, mas conferido contra a lista do Omie.
    expect(pagina).toContain("if (prazoVolta && d.parcelas?.oben) reaplicarParcelaDoRascunho('oben', d.parcelas.oben);");
    expect(pagina).toContain("(conta === 'oben' ? h.setSelectedParcelaOben : h.setSelectedParcelaColacor)(codigo);");
  });

  it('follow-up #4068: sem cliente na tela, o restore INTEIRO espera o cliente do rascunho', () => {
    const ini = pagina.indexOf('const handleRestore = () => {');
    const restore = pagina.slice(ini, pagina.indexOf('\n  };', ini));
    const ramoEspera = restore.slice(restore.indexOf("if (decisao === 'esperarCliente'"), restore.indexOf('} else {'));
    expect(ramoEspera).toContain('restorePendenteRef.current = { codigoCliente: codigoRascunho');
    // No ramo de espera NADA do rascunho entra na tela (carrinho, observação, OC).
    expect(ramoEspera).not.toContain('aplicarDadosDoRascunho(');
    expect(ramoEspera).not.toContain('h.setCart(');
    // A seleção resolve a pendência: só o cliente DO rascunho aplica.
    expect(pagina).toContain('const decisao = resolverRestorePendente(pendente.codigoCliente, codigoClienteSelecionado);');
    // Só o ramo 'aplicar' solta a pendência e aplica (o cliente errado a MANTÉM — #4271; o render
    // disso é provado em src/pages/__tests__/UnifiedOrder.restore-pendente.test.tsx).
    const efeito = pagina.slice(pagina.indexOf('const decisao = resolverRestorePendente('), pagina.indexOf('}, [codigoClienteSelecionado]);'));
    const ramoAplicar = efeito.slice(efeito.indexOf("if (decisao === 'aplicar') {"), efeito.indexOf('return;', efeito.indexOf("if (decisao === 'aplicar') {")));
    expect(ramoAplicar).toContain('aplicarDadosRef.current(pendente.dados, true);');
    expect(ramoAplicar).toContain('restorePendenteRef.current = null;');
  });

  it('B4: o carrinho trata serviço com preço ≤0 como A orçar e rotula Subtotal conhecido', () => {
    expect(carrinho).toContain('{price !== null && price > 0 ? (');
    // C2 (PR C): o rótulo virou `rotuloTotal` (mesmo no carrinho e na barra de envio) — testado puro.
    expect(carrinho).toContain('rotuloTotal(totalEstimated, servicosAOrcar)');
  });

  it('B4/B5: a busca de produto usa os rótulos honestos (sem `estoque ?? 0`)', () => {
    expect(busca).not.toContain('estoque ?? 0');
    expect(busca).toContain('seloEstoque(product.estoque)');
    expect(busca).toContain('rotuloPrecoProduto(');
  });

  // Codex r2 do #4271 (P2): o caso 173 → U decide `reuse`, mas a proteção dos envios SEGUINTES depende
  // de o envelope ser regravado com a fingerprint CANÔNICA (senão um 2º reenvio com a seleção sem o
  // código 173 já não acharia o alias legado). A decisão é provada no helper; aqui, que o hook grava.
  it('reuso migra a fingerprint do envelope para a chave canônica devolvida pelo helper', () => {
    const ini = hook.indexOf('decidirEnvelopeDoCliente(checkoutEnvRef.current');
    expect(ini, 'chamada do helper não encontrada').toBeGreaterThan(-1);
    const trecho = hook.slice(ini, ini + 3000);
    expect(trecho).toContain('const { decision, fingerprint } = decidirEnvelopeDoCliente(');
    expect(trecho).toContain('checkoutEnvRef.current = { ...checkoutEnvRef.current, fingerprint, committed: true }');
  });
});

