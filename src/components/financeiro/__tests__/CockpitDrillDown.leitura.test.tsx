import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// M-05: o drill-down do cockpit lia com `.limit(500)`, somava no cliente e DESCARTAVA o `error`.
// Falha virava "0 registros · Total: R$ 0,00", e 659 títulos atrasados viravam "500 registros" com
// a soma dos 500 como se fosse o total. Agora: erro → "indisponível" + aviso + tentar de novo;
// janela menor que o universo (`count`) → "Mostrando N de X · Total: —".

type Resposta = { data: unknown[] | null; error: unknown; count: number | null };
let respostas: Resposta[] = [];
let leituras = 0;

function proxima(): Promise<Resposta> {
  leituras += 1;
  return Promise.resolve(respostas.length > 1 ? (respostas.shift() as Resposta) : respostas[0]);
}

vi.mock('@/integrations/supabase/client', () => {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'lt', 'order']) builder[m] = () => builder;
  builder.limit = () => proxima();
  // caixa não tem janela: o builder é aguardado direto.
  builder.then = (ok: (v: Resposta) => unknown, falha?: (e: unknown) => unknown) => proxima().then(ok, falha);
  return { supabase: { from: () => builder } };
});

import { CockpitDrillDown } from '../CockpitDrillDown';

const cr = (i: number) => ({
  id: `cr-${i}`, company: 'colacor', nome_cliente: `Cliente ${i}`, numero_documento: `NF-${i}`,
  data_vencimento: '2026-02-01', status_titulo: 'ATRASADO', valor_documento: 1_000, valor_recebido: 0,
});
const conta = (i: number, saldo: number | null) => ({
  id: `cc-${i}`, company: 'oben', banco: 'Banco', descricao: `Conta ${i}`, saldo_atual: saldo,
});
const TIMEOUT = { message: 'canceling statement due to statement timeout', code: '57014' };

beforeEach(() => {
  respostas = [];
  leituras = 0;
});

describe('CockpitDrillDown — a leitura que falha ou não cabe na janela não vira número', () => {
  it('erro no CR: "indisponível" e aviso — nunca "0 registros" nem R$ 0,00', async () => {
    respostas = [{ data: null, error: TIMEOUT, count: null }];
    render(<CockpitDrillDown type="cr_vencido" onClose={() => {}} />);
    const aviso = await screen.findByTestId('aviso-leitura-falhou');
    expect(aviso.getAttribute('data-estado')).toBe('erro');
    expect(screen.getByText('indisponível')).toBeTruthy();
    expect(screen.queryByText(/0 registros/)).toBeNull();
    expect(screen.queryByText(/R\$\s*0,00/)).toBeNull();
  });

  it('"Tentar novamente" relê, e a leitura boa substitui o aviso', async () => {
    respostas = [{ data: null, error: TIMEOUT, count: null }, { data: [cr(1)], error: null, count: 1 }];
    render(<CockpitDrillDown type="cr_vencido" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /Tentar novamente/ }));
    expect(await screen.findByText('Cliente 1')).toBeTruthy();
    expect(screen.queryByTestId('aviso-leitura-falhou')).toBeNull();
    expect(leituras).toBe(2);
  });

  it('resposta sem erro e sem dados é malformada: "indisponível", não lista vazia', async () => {
    respostas = [{ data: null, error: null, count: null }];
    render(<CockpitDrillDown type="cp_aberto" onClose={() => {}} />);
    expect(await screen.findByTestId('aviso-leitura-falhou')).toBeTruthy();
    expect(screen.getByText('indisponível')).toBeTruthy();
  });

  it('janela menor que o universo: "Mostrando 2 de 659 · Total: —" e a nota da janela', async () => {
    respostas = [{ data: [cr(1), cr(2)], error: null, count: 659 }];
    render(<CockpitDrillDown type="cr_vencido" onClose={() => {}} />);
    expect(await screen.findByText('Mostrando 2 de 659 · Total: —')).toBeTruthy();
    expect(screen.getByTestId('drill-janela')).toBeTruthy();
    expect(screen.queryByText(/2 registros/)).toBeNull();
  });

  it('erro no caixa: "indisponível" — o caixa nunca sai R$ 0,00 por falha de leitura', async () => {
    respostas = [{ data: null, error: TIMEOUT, count: null }];
    render(<CockpitDrillDown type="caixa" onClose={() => {}} />);
    expect(await screen.findByTestId('aviso-leitura-falhou')).toBeTruthy();
    expect(screen.getByText('indisponível')).toBeTruthy();
    expect(screen.queryByText(/R\$\s*0,00/)).toBeNull();
  });

  it('caixa completo soma as contas; uma conta sem saldo tira o total (não soma 0)', async () => {
    respostas = [{ data: [conta(1, 100), conta(2, 50)], error: null, count: 2 }];
    const { unmount } = render(<CockpitDrillDown type="caixa" onClose={() => {}} />);
    expect(await screen.findByText(/2 registros · Total: R\$\s*150,00/)).toBeTruthy();
    unmount();

    respostas = [{ data: [conta(1, 100), conta(2, null)], error: null, count: 2 }];
    render(<CockpitDrillDown type="caixa" onClose={() => {}} />);
    expect(await screen.findByText('2 registros · Total: —')).toBeTruthy();
  });
});
