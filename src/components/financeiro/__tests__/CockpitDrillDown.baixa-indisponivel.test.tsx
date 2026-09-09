import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MOTIVO_BAIXA_NAO_INGERIDA } from '@/lib/financeiro/procedencia-baixa';

/**
 * O drill-down do cockpit calculava `saldo = (valor_documento || 0) - (valor_recebido || 0)` por
 * LINHA, e o mesmo subtraendo no total do cabeçalho. O subtraendo é 0 em 100% do acervo — o LIST
 * do Omie não devolve a baixa (#396) — então a coluna "Saldo" mostrava o valor de FACE inclusive
 * para título já liquidado, e "Recebido"/"Pago" mostravam R$ 0,00 sobre R$ 27,8M/R$ 28,9M.
 *
 * ⚠️ O gatilho é a PROCEDÊNCIA declarada (`BAIXA_OMIE_LIST`), nunca `v === 0`. O último bloco é o
 * CONTROLE: com a fonte ingerindo a baixa, um zero medido é FATO e sai como moeda.
 */

const estado = vi.hoisted(() => ({
  ingereBaixa: false,
  rows: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/financeiro/procedencia-baixa', async (importActual) => {
  const real = await importActual<typeof import('@/lib/financeiro/procedencia-baixa')>();
  return {
    ...real,
    // A MESMA tela no dia em que a ingestão existir: só a declaração de fonte muda.
    get BAIXA_OMIE_LIST() {
      return estado.ingereBaixa
        ? { fonte: 'teste/fonte que ingere a baixa', ingereBaixa: true, motivo: null }
        : real.BAIXA_OMIE_LIST;
    },
  };
});

vi.mock('@/integrations/supabase/client', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'lt', 'order']) {
    builder[m] = () => builder;
  }
  builder.limit = () => Promise.resolve({ data: estado.rows, error: null });
  return { supabase: { from: () => builder } };
});

import { CockpitDrillDown } from '../CockpitDrillDown';

const CR_LIQUIDADO = {
  company: 'colacor', nome_cliente: 'ACME', numero_documento: 'NF-1',
  data_vencimento: '2026-02-01', status_titulo: 'ATRASADO',
  valor_documento: 1_000, valor_recebido: 0,
};

const CP_LIQUIDADO = {
  company: 'colacor', nome_fornecedor: 'FORN', numero_documento: 'NF-9',
  data_vencimento: '2026-02-01', status_titulo: 'ATRASADO',
  valor_documento: 2_000, valor_pago: 0,
};

/** As células da linha, por posição — casar por texto pegaria a coluna vizinha. */
async function celulas(nome: string): Promise<string[]> {
  const linha = (await screen.findByText(nome)).closest('tr');
  expect(linha).not.toBeNull();
  return within(linha as HTMLElement).getAllByRole('cell').map(c => c.textContent ?? '');
}

beforeEach(() => {
  estado.ingereBaixa = false;
  estado.rows = [];
});

describe('drill-down de recebíveis — fonte sem ingestão da baixa', () => {
  beforeEach(() => { estado.rows = [CR_LIQUIDADO]; });

  it('mostra "—" em Recebido e Saldo — nunca R$ 0,00 nem o valor de face como saldo', async () => {
    render(<CockpitDrillDown type="cr_vencido" onClose={() => {}} />);
    const cels = await celulas('ACME');

    expect(cels[5]).toContain('1.000,00'); // Valor: medido, fica
    expect(cels[6]).toBe('—');             // Recebido
    expect(cels[7]).toBe('—');             // Saldo
  });

  it('não afirma um Total no cabeçalho: ele é a mesma subtração', async () => {
    render(<CockpitDrillDown type="cr_vencido" onClose={() => {}} />);

    const badge = await screen.findByText(/registros/);
    expect(badge.textContent).toContain('—');
    expect(badge.textContent).not.toContain('0,00');
  });

  it('DIZ por que degradou — um "—" mudo é lido como bug da tela', async () => {
    render(<CockpitDrillDown type="cr_vencido" onClose={() => {}} />);

    expect(await screen.findByText(new RegExp(MOTIVO_BAIXA_NAO_INGERIDA, 'i'))).toBeTruthy();
  });
});

describe('drill-down de contas a pagar — fonte sem ingestão da baixa', () => {
  beforeEach(() => { estado.rows = [CP_LIQUIDADO]; });

  it('mostra "—" em Pago e Saldo', async () => {
    render(<CockpitDrillDown type="cp_aberto" onClose={() => {}} />);
    const cels = await celulas('FORN');

    expect(cels[5]).toContain('2.000,00');
    expect(cels[6]).toBe('—');
    expect(cels[7]).toBe('—');
  });
});

describe('CONTROLE — fonte confiável: zero é FATO e aparece como R$ 0,00', () => {
  it('recebido 0 medido sai como moeda, e o saldo é a subtração de verdade', async () => {
    estado.ingereBaixa = true;
    estado.rows = [CR_LIQUIDADO];
    render(<CockpitDrillDown type="cr_vencido" onClose={() => {}} />);
    const cels = await celulas('ACME');

    expect(cels[6]).not.toBe('—');
    expect(cels[6]).toContain('0,00');
    expect(cels[7]).toContain('1.000,00');
    expect(screen.queryByText(new RegExp(MOTIVO_BAIXA_NAO_INGERIDA, 'i'))).toBeNull();
  });

  it('com baixa parcial medida, saldo é documento menos recebido', async () => {
    estado.ingereBaixa = true;
    estado.rows = [{ ...CR_LIQUIDADO, valor_recebido: 400 }];
    render(<CockpitDrillDown type="cr_vencido" onClose={() => {}} />);
    const cels = await celulas('ACME');

    expect(cels[6]).toContain('400,00');
    expect(cels[7]).toContain('600,00');
  });

  it('o total do cabeçalho volta a ser afirmado quando a fonte ingere a baixa', async () => {
    estado.ingereBaixa = true;
    estado.rows = [{ ...CR_LIQUIDADO, valor_recebido: 400 }];
    render(<CockpitDrillDown type="cr_vencido" onClose={() => {}} />);

    await waitFor(async () => {
      expect((await screen.findByText(/registros/)).textContent).toContain('600,00');
    });
  });
});
