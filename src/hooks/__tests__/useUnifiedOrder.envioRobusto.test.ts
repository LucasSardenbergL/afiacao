import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Rodada 2 da auditoria do Novo Pedido (PR A — robustez do envio): FIAÇÃO no hook ──
// O comportamento de cada guarda é provado nos helpers puros (travaEnvio.test.ts,
// submitOrder.test.ts §A1, submitQuote.test.ts §A4, parcela-manual.test.ts). O hook é grande
// demais para renderizar aqui; este arquivo prova que ele USA as guardas (precedente:
// useUnifiedOrder.accountGuard.test.ts). Cada asserção casa a forma exata da fiação.
const raiz = resolve(__dirname, '../../..');
const hook = readFileSync(resolve(raiz, 'src/hooks/useUnifiedOrder.ts'), 'utf8');
const selecao = readFileSync(resolve(raiz, 'src/hooks/unifiedOrder/useCustomerSelection.ts'), 'utf8');
const pagina = readFileSync(resolve(raiz, 'src/pages/UnifiedOrder.tsx'), 'utf8');

function corpoDo(nome: string): string {
  const ini = hook.indexOf(`const ${nome} = useCallback(async`);
  expect(ini, `${nome} não encontrado`).toBeGreaterThan(-1);
  const fim = hook.indexOf('\n  }, [', ini);
  return hook.slice(ini, fim);
}

describe('useUnifiedOrder — fiação das guardas de envio', () => {
  it('A2: a trava só liga dentro de executarComTravaDeEnvio (nenhum `submittingRef.current = true` solto)', () => {
    expect(hook).not.toMatch(/submittingRef\.current\s*=\s*true/);
    expect(corpoDo('submitOrder')).toContain('await executarComTravaDeEnvio(submittingRef, setSubmitting, async () => {');
  });

  it('A3: submitQuote passa pela MESMA trava', () => {
    expect(corpoDo('submitQuote')).toContain('await executarComTravaDeEnvio(submittingRef, setSubmitting, async () => {');
  });

  it('A1: o envio lê a marca da OS do envelope e grava a marca no MESMO envelope', () => {
    const corpo = corpoDo('submitOrder');
    expect(corpo).toContain('afiacaoJaEnviada: checkoutEnvRef.current.afiacaoOs ?? null,');
    expect(corpo).toContain('checkoutEnvRef.current = { ...checkoutEnvRef.current, afiacaoOs: marca, afiacaoPendente: false };');
  });

  it('OS idempotente: marca PENDENTE no mesmo envelope antes da edge, e devolve se gravou', () => {
    const corpo = corpoDo('submitOrder');
    expect(corpo).toContain('afiacaoPendente: checkoutEnvRef.current.afiacaoPendente ?? false,');
    expect(corpo).toContain('const proximo: CheckoutEnvelope = { ...checkoutEnvRef.current, afiacaoPendente: true };');
    expect(corpo).toMatch(/if \(!persistCheckoutEnv\(proximo\)\) return false;\s*checkoutEnvRef\.current = proximo;/);
  });

  it('OS idempotente: ação da OS no Omie tem toast PRÓPRIO, fora da cadeia de crédito/parcial', () => {
    const corpo = corpoDo('submitOrder');
    expect(corpo).toContain("const acoesOs = result.errors.filter(e => e.step.startsWith('afiacao_'));");
    expect(corpo).toContain("toast.error('OS de Afiação: confira no Omie', {");
    expect(corpo).toContain("!e.step.startsWith('afiacao_') && e.step !== 'aguardar_os_afiacao');");
    expect(corpo).toContain("toast.warning('OS de Afiação em processamento', {");
  });

  it('A4: orçamento parcial NÃO limpa o carrinho inteiro', () => {
    const corpo = corpoDo('submitQuote');
    expect(corpo).toContain('if (result.success && pendentes.length === 0) {');
    expect(corpo).toContain('mensagemOrcamentoParcial(');
  });

  it('A5: os mutadores exportados saem de protegerDuranteEnvio', () => {
    expect(hook).toContain('const mutadoresDoCarrinho = useMemo(() => protegerDuranteEnvio(submittingRef, {');
    expect(hook).toMatch(/updateQuantity, updateProductPrice, updateTintDiscount, aplicarDescontoCores, removeFromCart,\n\s*\} = mutadoresDoCarrinho;/);
  });

  it('A5 (Codex P1): as vias da IA/voz/imagem que escrevem direto no setCart também barram com envio em voo', () => {
    for (const sig of [
      'const handleVoiceItemsIdentified = (identifiedItems: IdentifiedItem[]) => {',
      'const handleImageCategoryIdentified = (categoryId: string) => {',
      'const handleUnifiedAIResult = useCallback((result: AIOrderResult) => {',
    ]) {
      const ini = hook.indexOf(sig);
      expect(ini, sig).toBeGreaterThan(-1);
      expect(hook.slice(ini, ini + 400)).toContain('if (submittingRef.current) { avisarCarrinhoTravado(); return; }');
    }
    expect(pagina).toContain('precoLoading={h.precoPartidaLoading || h.submitting}');
  });

  it('A6: o rascunho só some com o envio confirmado; o diálogo recebe o desfecho', () => {
    expect(pagina).toContain('clearTrigger: h.orderSuccessOpen && h.ultimoEnvioConfirmado,');
    expect(pagina).toContain('envioConfirmado={h.ultimoEnvioConfirmado}');
    expect(corpoDo('submitOrder')).toContain('setUltimoEnvioConfirmado(result.allConfirmed);');
  });

  it('A7: o histórico só sugere prazo se a conta não foi escolhida à mão; a tela recebe o setter que marca', () => {
    expect(selecao).toContain('podeSugerirParcela(parcelaManualRef.current.oben, myToken)');
    expect(selecao).toContain('podeSugerirParcela(parcelaManualRef.current.colacor, myToken)');
    expect(selecao).toContain('setSelectedParcelaOben: escolherParcelaOben,');
    expect(selecao).toContain('setSelectedParcelaColacor: escolherParcelaColacor,');
  });
});

// ── Ciclo ÚNICO envelope × rascunho (follow-up Codex do #4042) — FIAÇÃO na página/hook ──
// Comportamento: ciclo-rascunho.test.ts, useOrderDraft.ciclo.test.ts, RestoreDraftDialog.envioPendente.
describe('UnifiedOrder — envelope e rascunho morrem juntos', () => {
  function corpoPagina(nome: string): string {
    const ini = pagina.indexOf(`const ${nome} = `);
    expect(ini, `${nome} não encontrado`).toBeGreaterThan(-1);
    return pagina.slice(ini, pagina.indexOf('\n  };', ini));
  }

  it('bug 1: descartar o rascunho zera o envelope (pedido idêntico seguinte é NOVO)', () => {
    // PR 2.2 (rodada 4): solta SÓ o envio que o diálogo mostrou (chave + id), inclusive o legado.
    expect(corpoPagina('handleDiscardDraft')).toContain('h.descartarEnvelope(envioMostradoRef.current);');
    expect(pagina).toContain('envioPendente={envioDoRascunho.pendente}');
  });

  it('bug 2: "Trocar e limpar" apaga o rascunho em disco junto com o envelope', () => {
    expect(corpoPagina('handleClearCustomer')).toContain('if (h.clearCustomer()) clearDraft();');
    expect(pagina).toContain('onClearCustomer={handleClearCustomer}');
    expect(pagina).not.toContain('onClearCustomer={h.clearCustomer}');
  });

  it('bug 3: orçamento salvo amarra o rascunho ao desfecho NA HORA (total apaga, parcial grava o resto)', () => {
    const q = corpoPagina('handleSubmitQuote');
    expect(q).toContain('clearDraft();');
    expect(q).toContain('gravarRascunhoAgora({ ...draftPayload, cart: restante });');
    expect(pagina).toContain('onSubmitQuote={handleSubmitQuote}');
    const corpo = corpoDo('submitQuote');
    // total: aoGravar(null) ANTES do navigate; parcial: o MESMO recorte do carrinho vai pro disco
    expect(corpo.indexOf('opts?.aoGravar?.(null);')).toBeGreaterThan(-1);
    expect(corpo.indexOf('opts?.aoGravar?.(null);')).toBeLessThan(corpo.indexOf("navigate('/sales/quotes');"));
    expect(corpo).toContain('opts?.aoGravar?.(carrinhoAposOrcamentoParcial(cart, salvas));');
  });
});

// ── Pós-Codex (ciclo único): troca durante envio, sucesso com a tela desmontada, envio antes do debounce ──
describe('useUnifiedOrder — ciclo do rascunho no ENVIO e na troca', () => {
  it('troca de cliente com envio em voo é barrada e a página NÃO apaga o rascunho', () => {
    const ini = hook.indexOf('const clearCustomer = useCallback(');
    const corpo = hook.slice(ini, hook.indexOf('\n  }, [', ini));
    expect(corpo).toContain('if (submittingRef.current) { avisarCarrinhoTravado(); return false; }');
    expect(pagina).toContain('if (h.clearCustomer()) clearDraft();');
  });

  it('orçamento com envio de pedido pendente é barrado ANTES de gravar (sem 2ª linha da conta enviada)', () => {
    const corpo = corpoDo('submitQuote');
    // PR 2.2 (Codex P0 #6, rodada 4): relê as chaves do cliente E o legado — não só o espelho da aba.
    expect(corpo).toContain('const pendenteQ = armQ && alvoQ ? pendenteDoCliente(armQ, alvoQ) : null;');
    const barra = corpo.indexOf('if (pendenteQ !== null || checkoutEnvRef.current?.committed) {');
    expect(barra).toBeGreaterThan(-1);
    expect(barra).toBeLessThan(corpo.indexOf('submitQuoteService('));
  });

  it('envio: rascunho gravado no commit do envelope e apagado no sucesso TOTAL dentro do hook', () => {
    const corpo = corpoDo('submitOrder');
    // PR 2.2: o commit é gravado pela RESERVA (relê o armazém do par sob trava entre abas); o rascunho vem logo após.
    const commit = corpo.indexOf('checkoutEnvRef.current = reserva.envelope;\n      if (!reserva.gravou) {');
    expect(corpo).toContain('chaveDoEnvelopeRef.current = alvo.chaves[0];');
    expect(corpo.indexOf('cicloRascunhoRef.current.aoComprometer?.();')).toBeGreaterThan(commit);
    expect(commit).toBeGreaterThan(-1);
    expect(commit).toBeLessThan(corpo.indexOf('submitOrderService('));
    expect(corpo).toMatch(/result\.allConfirmed\) \{\n\s*checkoutEnvRef\.current = null; chaveDoEnvelopeRef\.current = null; void comTravaEntreAbas\(nomeDaTrava\(userIdTrava\), \(\) => concluirEnvio\(arm, alvo\.chaves, checkoutId\)\);[^\n]*\n\s*cicloRascunhoRef\.current\.aoConfirmarTudo\?\.\(\);/);
    expect(pagina).toContain('...draftPayload, nonce: h.nonceDoRascunho(), customerChaveEnvelope: h.chaveDoRascunho() ?? draftPayload.customerChaveEnvelope,');
    expect(pagina).toContain('aoConfirmarTudo: clearDraft,');
  });
});
