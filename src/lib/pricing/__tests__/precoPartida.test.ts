import { describe, it, expect } from 'vitest';
import { precoPartida, JANELA_ULTIMO_PRATICADO_DIAS } from '../precoPartida';

// hoje fixo p/ determinismo (a função recebe `hoje` injetado — nada de Date.now()).
const HOJE = new Date('2026-07-04T12:00:00');

// helper: data ISO N dias atrás de HOJE
const diasAtras = (n: number): string => {
  const d = new Date(HOJE);
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

describe('precoPartida — precedência de nascimento do preço', () => {
  it('último praticado ≤180d vence a tabela', () => {
    const p = precoPartida({
      tabela: 100, ultimoPraticado: 88, ultimoPraticadoEm: diasAtras(30),
      hoje: HOJE, tier: 'C', mult: 1.05,
    });
    expect(p).toBe(88); // último vence, mesmo com tier (não vira 100×1.05)
  });

  it('último praticado >180d NÃO vence → cai para tabela×mult(tier)', () => {
    const p = precoPartida({
      tabela: 100, ultimoPraticado: 88, ultimoPraticadoEm: diasAtras(200),
      hoje: HOJE, tier: 'C', mult: 1.05,
    });
    expect(p).toBe(105); // 100 × 1.05
  });

  it('exatamente 180d ainda vence (limite inclusivo)', () => {
    const p = precoPartida({
      tabela: 100, ultimoPraticado: 90, ultimoPraticadoEm: diasAtras(JANELA_ULTIMO_PRATICADO_DIAS),
      hoje: HOJE, tier: 'C', mult: 1.05,
    });
    expect(p).toBe(90);
  });

  it('último praticado SEM data preserva o vigente (vence — não derruba sem prova de idade)', () => {
    const p = precoPartida({
      tabela: 100, ultimoPraticado: 88, ultimoPraticadoEm: null,
      hoje: HOJE, tier: 'C', mult: 1.05,
    });
    expect(p).toBe(88); // ausência de data ≠ velho; mantém o comportamento de hoje
  });

  it('sem último praticado + tier C → tabela × mult', () => {
    const p = precoPartida({
      tabela: 200, ultimoPraticado: null, ultimoPraticadoEm: null,
      hoje: HOJE, tier: 'C', mult: 1.05,
    });
    expect(p).toBe(210);
  });

  it('sem último praticado + sem tier → tabela pura (comportamento vigente)', () => {
    const p = precoPartida({
      tabela: 200, ultimoPraticado: null, ultimoPraticadoEm: null,
      hoje: HOJE, tier: null, mult: null,
    });
    expect(p).toBe(200);
  });

  it('tier A (mult 1,00) → tabela sem alteração', () => {
    const p = precoPartida({
      tabela: 200, ultimoPraticado: null, ultimoPraticadoEm: null,
      hoje: HOJE, tier: 'A', mult: 1.0,
    });
    expect(p).toBe(200);
  });

  it('mult inválido (NaN/0/negativo/null) ignora o tier → tabela pura (ausente ≠ fabricar)', () => {
    for (const mult of [NaN, 0, -1, null, Infinity]) {
      const p = precoPartida({
        tabela: 200, ultimoPraticado: null, ultimoPraticadoEm: null,
        hoje: HOJE, tier: 'C', mult,
      });
      expect(p).toBe(200);
    }
  });

  it('tabela ≤0 sem último praticado → não fabrica (retorna a tabela, o guard barra depois)', () => {
    const p = precoPartida({
      tabela: 0, ultimoPraticado: null, ultimoPraticadoEm: null,
      hoje: HOJE, tier: 'C', mult: 1.05,
    });
    expect(p).toBe(0);
  });

  it('último praticado ≤0 é ignorado (não é preço válido) → tabela×mult', () => {
    const p = precoPartida({
      tabela: 100, ultimoPraticado: 0, ultimoPraticadoEm: diasAtras(10),
      hoje: HOJE, tier: 'C', mult: 1.05,
    });
    expect(p).toBe(105);
  });

  it('idempotência: mesma entrada → mesma saída; e re-alimentar a saída como tabela NÃO re-multiplica o carrinho', () => {
    const input = {
      tabela: 200, ultimoPraticado: null, ultimoPraticadoEm: null,
      hoje: HOJE, tier: 'C' as const, mult: 1.05,
    };
    const p1 = precoPartida(input);
    const p2 = precoPartida(input);
    expect(p1).toBe(p2); // determinístico
    expect(p1).toBe(210);
    // a partida roda no NASCIMENTO sobre a TABELA, nunca sobre o preço já no carrinho.
    // Se (por bug) fosse re-aplicada sobre o resultado, dobraria o mult — este teste
    // documenta que a função é chamada com `tabela`, não com o preço anterior.
    const reaplicado = precoPartida({ ...input, tabela: p1 });
    expect(reaplicado).toBe(220.5); // 210 × 1.05 — o QUE ACONTECERIA se re-aplicada (não deve ocorrer no fluxo)
    expect(reaplicado).not.toBe(p1);
  });

  it('reprecificação da fronteira (P1-A): nasceu sem tier durante o loading → corrige partindo da TABELA', () => {
    // Item nasceu a 100 (tier/mult ainda não firmes → tratados como null).
    const nasceu = precoPartida({
      tabela: 100, ultimoPraticado: null, ultimoPraticadoEm: null, hoje: HOJE, tier: null, mult: null,
    });
    expect(nasceu).toBe(100);
    // tier C firma → a reprecificação re-chama sobre a TABELA (100), não sobre o preço nascido.
    const corrigido = precoPartida({
      tabela: 100, ultimoPraticado: null, ultimoPraticadoEm: null, hoje: HOJE, tier: 'C', mult: 1.05,
    });
    expect(corrigido).toBe(105);
    // re-rodar a reprecificação parte da TABELA de novo → estável em 105 (nunca 110). Não compõe.
    const denovo = precoPartida({
      tabela: 100, ultimoPraticado: null, ultimoPraticadoEm: null, hoje: HOJE, tier: 'C', mult: 1.05,
    });
    expect(denovo).toBe(105);
  });
});
