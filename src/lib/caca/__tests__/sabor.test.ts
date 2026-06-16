import { describe, it, expect } from 'vitest';
import { classificarSabor } from '../sabor';
import type { CandidatoFeatures } from '../types';

/** Helper: candidato base limpo (frio, sem empresa-alvo). */
function base(overrides: Partial<CandidatoFeatures> = {}): CandidatoFeatures {
  return {
    documento: '12345678000190',
    empresaAlvo: 'oben',
    cidadeUf: null,
    ramo: null,
    ticketFaixa: null,
    familias: [],
    compraEmOutraEmpresa: false,
    compraNaEmpresaAlvo: false,
    ultimaCompraGrupoDias: null,
    atrasoRelativo: null,
    ...overrides,
  };
}

describe('classificarSabor', () => {
  // Descarte: já compra na empresa-alvo
  it('já compra na empresa-alvo → null (não é candidato)', () => {
    expect(classificarSabor(base({ compraNaEmpresaAlvo: true }))).toBeNull();
  });

  it('já compra na alvo mesmo que também seja cross → null', () => {
    expect(
      classificarSabor(base({ compraNaEmpresaAlvo: true, compraEmOutraEmpresa: true }))
    ).toBeNull();
  });

  // Cross-empresa (precedência mais alta entre os válidos)
  it('compra em outra empresa mas não na alvo → cross_empresa', () => {
    expect(
      classificarSabor(base({ compraEmOutraEmpresa: true }))
    ).toBe('cross_empresa');
  });

  it('cross vence dormente: comprou na Colacor há 200d, zero Oben, alvo=oben → cross', () => {
    expect(
      classificarSabor(
        base({ compraEmOutraEmpresa: true, ultimaCompraGrupoDias: 200 })
      )
    ).toBe('cross_empresa');
  });

  it('cross vence mesmo quando compra foi RECENTE no grupo (não é descartado pelo corte de dormência)', () => {
    // Comprou na Colacor há 10 dias, zero na Oben → cross (não frio, não dormente)
    expect(
      classificarSabor(
        base({ compraEmOutraEmpresa: true, ultimaCompraGrupoDias: 10 })
      )
    ).toBe('cross_empresa');
  });

  // Dormente
  it('comprou há exatamente 6 meses (180d) → dormente', () => {
    expect(
      classificarSabor(base({ ultimaCompraGrupoDias: 180 }))
    ).toBe('dormente');
  });

  it('comprou há mais de 6 meses → dormente', () => {
    expect(
      classificarSabor(base({ ultimaCompraGrupoDias: 365 }))
    ).toBe('dormente');
  });

  it('dormenteMeses customizado: 3m → 90d de corte', () => {
    // 91 dias com dormenteMeses=3 → dormente
    expect(
      classificarSabor(base({ ultimaCompraGrupoDias: 91 }), 3)
    ).toBe('dormente');
    // 89 dias com dormenteMeses=3 → frio (não atingiu o corte)
    // Na verdade 89d não é frio — ultimaCompraGrupoDias != null mas abaixo do corte
    // Não se encaixa em nenhuma categoria (comprou recentemente, não é candidato fácil)
    // → frio NÃO: ultimaCompraGrupoDias != null
    // → dormente NÃO: 89 < 90
    // → cross NÃO
    // Neste caso, NÃO há classificação → mas o spec diz só 3 caminhos.
    // Re-lendo o spec: "dormente" = ultimaCompraGrupoDias >= dormenteMeses*30
    // Se abaixo do corte mas não null e não cross, não há sabor → na verdade voltamos null?
    // O spec não cobre esse caso explicitamente. Por segurança: null (não é candidato produtivo)
    expect(
      classificarSabor(base({ ultimaCompraGrupoDias: 89 }), 3)
    ).toBeNull();
  });

  // Frio
  it('nunca comprou (ultimaCompraGrupoDias=null) → frio', () => {
    expect(
      classificarSabor(base({ ultimaCompraGrupoDias: null }))
    ).toBe('frio');
  });

  it('frio mesmo com cidadeUf e ramo conhecidos', () => {
    expect(
      classificarSabor(
        base({ cidadeUf: 'DIVINOPOLIS-MG', ramo: 'marcenaria', ultimaCompraGrupoDias: null })
      )
    ).toBe('frio');
  });

  // Limiar exato
  it('comprou há 179d com dormenteMeses=6 → não dorme (abaixo do corte) → null', () => {
    // 179 < 180 → não é dormente
    // não é cross, não é frio (tem lastCompra)
    expect(
      classificarSabor(base({ ultimaCompraGrupoDias: 179 }))
    ).toBeNull();
  });
});
