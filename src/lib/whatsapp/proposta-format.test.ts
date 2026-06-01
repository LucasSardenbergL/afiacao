import { describe, it, expect } from 'vitest';
import { formatarLinhaItem, formatarPropostaRecompra } from './proposta-format';
import type { CestaItem, CestaResult } from './cesta-recompra';

function item(sku: number, qtdSugerida: number, over: Partial<CestaItem> = {}): CestaItem {
  return {
    omie_codigo_produto: sku, qtdSugerida, dueRatio: 1, nPedidos: 3, cadenciaDias: 30,
    confidence: 'media', motivo: 'recorrente_due', ultimoPrecoRef: 10, ...over,
  };
}
function cesta(principal: CestaItem[], secundarios: CestaItem[] = []): CestaResult {
  return { principal, secundarios, totalPedidos: 5, confianca: 'media' };
}
const NOMES: Record<number, string> = { 100: 'Lixa Grão 120', 200: 'Disco de Corte 7"', 300: 'Cola Branca 1kg', 400: 'Fita Crepe', 500: 'Verniz 900ml', 600: 'Estopa' };

describe('formatarLinhaItem', () => {
  it('quantidade inteira + nome', () => {
    expect(formatarLinhaItem(item(100, 3), NOMES)).toBe('• 3× Lixa Grão 120');
  });
  it('quantidade fracionada preserva o decimal', () => {
    expect(formatarLinhaItem(item(100, 1.5), NOMES)).toBe('• 1.5× Lixa Grão 120');
  });
  it('SKU sem nome cai pro código (orquestrador deve enriquecer)', () => {
    expect(formatarLinhaItem(item(999, 2), NOMES)).toBe('• 2× Cód. 999');
  });
});

describe('formatarPropostaRecompra', () => {
  it('monta saudação + intro + itens da principal + CTA', () => {
    const r = formatarPropostaRecompra(cesta([item(100, 3), item(200, 2)]), { nomesPorSku: NOMES });
    expect(r.vazia).toBe(false);
    expect(r.itensPrincipais).toBe(2);
    expect(r.texto).toContain('Olá!');
    expect(r.texto).toContain('costuma repor');
    expect(r.texto).toContain('• 3× Lixa Grão 120');
    expect(r.texto).toContain('• 2× Disco de Corte 7"');
    expect(r.texto).toContain('entrega de amanhã');
  });
  it('usa o primeiro nome do cliente quando disponível', () => {
    const r = formatarPropostaRecompra(cesta([item(100, 3)]), { nomesPorSku: NOMES, primeiroNome: 'João' });
    expect(r.texto).toContain('Olá, João!');
  });
  it('lista secundários ("também costuma levar") capados em maxSecundarios', () => {
    const sec = [item(300, 1), item(400, 1), item(500, 1), item(600, 1)]; // 4
    const r = formatarPropostaRecompra(cesta([item(100, 3)], sec), { nomesPorSku: NOMES }); // default max 3
    expect(r.texto).toContain('também costuma levar');
    expect(r.texto).toContain('Cola Branca 1kg');
    expect(r.texto).toContain('Verniz 900ml');     // 3º secundário entra
    expect(r.texto).not.toContain('Estopa');        // 4º secundário (cap) não entra
  });
  it('sem secundários → não imprime o bloco "também costuma levar"', () => {
    const r = formatarPropostaRecompra(cesta([item(100, 3)]), { nomesPorSku: NOMES });
    expect(r.texto).not.toContain('também costuma levar');
  });
  it('principal vazia → vazia=true, texto vazio (orquestrador não envia)', () => {
    const r = formatarPropostaRecompra(cesta([]), { nomesPorSku: {} });
    expect(r.vazia).toBe(true);
    expect(r.texto).toBe('');
    expect(r.itensPrincipais).toBe(0);
  });
  it('cópia é parametrizável (founder troca as palavras sem mexer no código)', () => {
    const r = formatarPropostaRecompra(cesta([item(100, 3)]), {
      nomesPorSku: NOMES,
      saudacao: () => 'Oi! ',
      introPrincipal: 'Separei sua reposição:',
      cta: 'Posso fechar o pedido?',
    });
    expect(r.texto).toContain('Oi!');
    expect(r.texto).toContain('Separei sua reposição:');
    expect(r.texto).toContain('Posso fechar o pedido?');
    expect(r.texto).not.toContain('entrega de amanhã'); // CTA default substituído
  });
  it('renderiza a camada de cross-sell ("experimente também") quando passada, antes do CTA', () => {
    const r = formatarPropostaRecompra(cesta([item(100, 3)]), {
      nomesPorSku: NOMES,
      crossSell: [{ nome: 'Lixadeira Orbital' }, { nome: 'Máscara PFF2' }],
    });
    expect(r.texto).toContain('Que tal experimentar também:');
    expect(r.texto).toContain('• Lixadeira Orbital');
    expect(r.texto).toContain('• Máscara PFF2');
    // cross-sell vem antes do CTA
    expect(r.texto.indexOf('Lixadeira Orbital')).toBeLessThan(r.texto.indexOf('entrega de amanhã'));
  });
  it('sem cross-sell → não imprime a seção', () => {
    const r = formatarPropostaRecompra(cesta([item(100, 3)]), { nomesPorSku: NOMES });
    expect(r.texto).not.toContain('experimentar também');
  });
});
