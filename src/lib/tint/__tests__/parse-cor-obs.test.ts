import { describe, it, expect } from 'vitest';
import { parseCorObs } from '../parse-cor-obs';

describe('parseCorObs', () => {
  it('extrai cor_id + nome + embalagem → mantém label, tira embalagem', () => {
    expect(parseCorObs('Cor: 1247 - AZUL RAL 5010 - QT')).toEqual({ tint_nome_cor: '1247 - AZUL RAL 5010' });
  });

  it('nome sem cor_id separado + embalagem', () => {
    expect(parseCorObs('Cor: AZUL RAL 5010 - QT')).toEqual({ tint_nome_cor: 'AZUL RAL 5010' });
  });

  it('sem embalagem mantém o label inteiro', () => {
    expect(parseCorObs('Cor: 1247 - AZUL RAL 5010')).toEqual({ tint_nome_cor: '1247 - AZUL RAL 5010' });
  });

  it('só nome', () => {
    expect(parseCorObs('Cor: AZUL RAL 5010')).toEqual({ tint_nome_cor: 'AZUL RAL 5010' });
  });

  it('embalagem em ML (com e sem espaço)', () => {
    expect(parseCorObs('Cor: BRANCO - 450ML')).toEqual({ tint_nome_cor: 'BRANCO' });
    expect(parseCorObs('Cor: VERDE - 405 ML')).toEqual({ tint_nome_cor: 'VERDE' });
  });

  it('NÃO quebra nome com hífen quando o sufixo não é embalagem conhecida', () => {
    expect(parseCorObs('Cor: AZUL - VERDE')).toEqual({ tint_nome_cor: 'AZUL - VERDE' });
    expect(parseCorObs('Cor: AZUL - 5010')).toEqual({ tint_nome_cor: 'AZUL - 5010' });
  });

  it('só remove embalagem no FIM (não no meio/começo)', () => {
    expect(parseCorObs('Cor: 450ML AZUL')).toEqual({ tint_nome_cor: '450ML AZUL' });
  });

  it('prefixo case-insensitive + trim de espaços', () => {
    expect(parseCorObs('cor:   AZUL  ')).toEqual({ tint_nome_cor: 'AZUL' });
  });

  it('ordem de compra (não é cor) → null', () => {
    expect(parseCorObs('AFI-12345')).toBeNull();
    expect(parseCorObs('Pedido compra 998')).toBeNull();
  });

  it('vazio/null/undefined → null', () => {
    expect(parseCorObs('')).toBeNull();
    expect(parseCorObs(null)).toBeNull();
    expect(parseCorObs(undefined)).toBeNull();
  });

  it('só "Cor:" sem conteúdo (ou só embalagem) → null', () => {
    expect(parseCorObs('Cor:')).toBeNull();
    expect(parseCorObs('Cor:  - QT')).toBeNull();
  });
});
