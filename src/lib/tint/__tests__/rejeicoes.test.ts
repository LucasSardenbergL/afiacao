import { describe, expect, it } from 'vitest';
import { agruparPorCor, classificarRejeicao, descreverSlots, motivoCurto, type LinhaDeErro } from '../rejeicoes';

// Formas REAIS de `tint_sync_errors.error_details` (psql-ro, run de 21/10/2026 10:37).
const item = (ordem: number, id_corante: string, qtd_ml: number, viola: boolean) => ({
  ordem, id_corante, qtd_ml, viola, motivos: viola ? ['x'] : null,
});
const AZUL_PURO = {
  cod_produto: 'FO10.6554', id_base: '15', motivos: ['corante_sem_dose_valida'],
  itens: [item(1, '3', 25.107, false), item(2, '5', 15.403, false), item(3, '9', 3.235, false),
    item(4, '10', 10.474, false), item(6, '0', 0, true), item(5, '0', 0, true)],
};
const VERDE_OITI = {
  cod_produto: 'FO10.6554', id_base: '15', motivos: ['dose_sem_corante'],
  itens: [item(1, '2', 12.7074, false), item(2, '3', 3.9277, false), item(3, '5', 32.346, false),
    item(4, '', 2.4645, true)],
};

const MSG = 'receita corrompida: corante presente sem dose válida (qtd_ml <= 0/nula/não-finita) + linha inválida sob protocolo declarado (1d-E) — fórmula NÃO promovida';

describe('classificarRejeicao', () => {
  it('slot livre gravado como corante "0" com 0 ml → slot_livre, slots em ordem', () => {
    const c = classificarRejeicao(AZUL_PURO);
    expect(c?.tipo).toBe('slot_livre');
    expect(c?.linhas.map((l) => l.ordem)).toEqual([5, 6]);
  });

  it('dose legível sem corante → dose_sem_corante, com a dose', () => {
    const c = classificarRejeicao(VERDE_OITI);
    expect(c?.tipo).toBe('dose_sem_corante');
    expect(c?.linhas).toEqual([{ ordem: 4, idCorante: '', qtdMl: 2.4645 }]);
  });

  it('corante "0" com dose ≠0 NÃO é slot livre (seria corante fantasma) → outro', () => {
    expect(classificarRejeicao({ itens: [item(6, '0', 1.5, true)] })?.tipo).toBe('outro');
  });

  it('corante real sem dose → outro (não é a sentinela)', () => {
    expect(classificarRejeicao({ itens: [item(2, '7', 0, true)] })?.tipo).toBe('outro');
  });

  it('mistura das duas assinaturas na mesma fórmula → outro, não escolhe uma', () => {
    expect(classificarRejeicao({ itens: [item(4, '', 2, true), item(6, '0', 0, true)] })?.tipo).toBe('outro');
  });

  it('dose ausente (null) com corante vazio NÃO vira dose_sem_corante — ausente ≠ dose', () => {
    expect(classificarRejeicao({ itens: [{ ordem: 4, id_corante: '', qtd_ml: null, viola: true }] })?.tipo).toBe('outro');
  });

  it('sem itens legíveis ou sem linha violadora → null ("não sei"), nunca um tipo inventado', () => {
    expect(classificarRejeicao(null)).toBeNull();
    expect(classificarRejeicao('texto')).toBeNull();
    expect(classificarRejeicao({ itens: 'x' })).toBeNull();
    expect(classificarRejeicao({ itens: [item(1, '3', 5, false)] })).toBeNull();
  });
});

describe('descreverSlots', () => {
  it('singular, par e lista', () => {
    expect(descreverSlots([{ ordem: 4, idCorante: '', qtdMl: 2 }])).toBe('slot 4');
    expect(descreverSlots([5, 6].map((o) => ({ ordem: o, idCorante: '0', qtdMl: 0 })))).toBe('slots 5 e 6');
    expect(descreverSlots([2, 3, 4, 5, 6].map((o) => ({ ordem: o, idCorante: '0', qtdMl: 0 }))))
      .toBe('slots 2, 3, 4, 5 e 6');
  });
  it('sem ordem → null', () => {
    expect(descreverSlots([{ ordem: null, idCorante: '0', qtdMl: 0 }])).toBeNull();
  });
});

describe('agruparPorCor', () => {
  const linha = (run: string, cor: string, detalhes: unknown = AZUL_PURO): LinhaDeErro => ({
    sync_run_id: run, entity_type: 'formula_promote', entity_id: cor, error_message: MSG, error_details: detalhes,
  });

  it('conta fórmulas SÓ do run mais recente da cor — re-envio a cada ciclo não multiplica', () => {
    // mais novo primeiro: run-3 tem 2 fórmulas de AZUL PURO; run-2 e run-1 repetem as mesmas
    const cores = agruparPorCor([
      linha('run-3', 'AZUL PURO'), linha('run-3', 'AZUL PURO'),
      linha('run-2', 'AZUL PURO'), linha('run-2', 'AZUL PURO'),
      linha('run-1', 'AZUL PURO'), linha('run-1', '303U - BS', VERDE_OITI),
    ]);
    expect(cores).toHaveLength(2);
    expect(cores[0]).toMatchObject({ cor: 'AZUL PURO', formulas: 2, tipo: 'slot_livre' });
    expect(cores[1]).toMatchObject({ cor: '303U - BS', formulas: 1, tipo: 'dose_sem_corante' });
  });

  it('fórmulas da mesma cor com tipos diferentes → outro', () => {
    const [c] = agruparPorCor([linha('r', 'X', AZUL_PURO), linha('r', 'X', VERDE_OITI)]);
    expect(c.tipo).toBe('outro');
  });

  it('sem detalhe classificável → outro, com o motivo curto do guard', () => {
    const [c] = agruparPorCor([linha('r', 'X', null)]);
    expect(c).toMatchObject({ tipo: 'outro', linhas: [], motivo: 'receita corrompida: corante presente sem dose válida' });
  });
});

describe('motivoCurto', () => {
  it('tira o sufixo técnico e a fórmula', () => {
    expect(motivoCurto(MSG)).toBe('receita corrompida: corante presente sem dose válida');
  });
});
