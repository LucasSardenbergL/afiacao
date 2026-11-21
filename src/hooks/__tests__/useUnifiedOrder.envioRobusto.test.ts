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
    expect(corpo).toContain('checkoutEnvRef.current = { ...checkoutEnvRef.current, afiacaoOs: marca };');
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
