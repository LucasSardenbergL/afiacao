import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OMIE_NAO_CALIBRADO, ResumoDiarioExtrato } from '../ResumoDiarioExtrato';
import { montarMovimentoOmie } from '@/lib/financeiro/extrato/omie-realizado';
import { INDISPONIVEL } from '../formatar';
import type { ResumoDia } from '@/services/financeiroExtratoBancario';

const diaNaoCoberto: ResumoDia = { data: '2026-11-10', coberto: false, creditos: null, debitos: null, saldoFinal: null, saldoOmie: null };
const diaCobertoSemMovimento: ResumoDia = { data: '2026-11-11', coberto: true, creditos: 0, debitos: 0, saldoFinal: 150000, saldoOmie: 148000 };

describe('ResumoDiarioExtrato — ausente ≠ zero', () => {
  it('dia NÃO coberto mostra "indisponível" e nunca R$ 0,00', () => {
    const { container } = render(<ResumoDiarioExtrato dias={[diaNaoCoberto]} />);
    expect(screen.getAllByText('indisponível').length).toBeGreaterThanOrEqual(3);
    expect(container.textContent).not.toContain('R$ 0,00');
    expect(container.textContent).not.toMatch(/R\$\s?0,00/);
  });

  it('dia coberto com créditos 0 mostra R$ 0,00 (zero real)', () => {
    const { container } = render(<ResumoDiarioExtrato dias={[diaCobertoSemMovimento]} />);
    expect(container.textContent).toMatch(/R\$\s?0,00/);
    expect(container.textContent).toMatch(/R\$\s?1\.500,00/);
  });

  it('dia coberto com saldo null (arquivos divergentes) mostra indisponível no saldo, não 0', () => {
    const { container } = render(
      <ResumoDiarioExtrato dias={[{ ...diaCobertoSemMovimento, saldoFinal: null }]} />,
    );
    expect(screen.getAllByText('indisponível').length).toBeGreaterThanOrEqual(2); // saldo + Omie
    expect(container.textContent).toMatch(/R\$\s?0,00/); // créditos/débitos reais
  });

  it('coluna Omie mostra o saldo da foto (saldoOmie) e "indisponível" quando é null — nunca 0', () => {
    const { container, rerender } = render(<ResumoDiarioExtrato dias={[diaCobertoSemMovimento]} />);
    expect(container.querySelector('tbody')?.textContent).toMatch(/R\$\s?1\.480,00/);
    rerender(<ResumoDiarioExtrato dias={[{ ...diaCobertoSemMovimento, saldoOmie: null }]} />);
    const linha = container.querySelector('tbody tr');
    expect(linha?.lastElementChild?.textContent).toBe('indisponível');
  });

  it('dia NÃO coberto ainda mostra a foto Omie (independe da cobertura do extrato)', () => {
    const { container } = render(<ResumoDiarioExtrato dias={[{ ...diaNaoCoberto, saldoOmie: 99900 }]} />);
    expect(container.querySelector('tbody tr')?.lastElementChild?.textContent).toMatch(/R\$\s?999,00/);
  });
});

describe('Diferença do corte', () => {
  const dias: ResumoDia[] = [
    { data: '2026-11-10', coberto: true, creditos: 0, debitos: 0, saldoFinal: 100000, saldoOmie: 90000 },
    { data: '2026-11-11', coberto: true, creditos: 0, debitos: 0, saldoFinal: 150000, saldoOmie: 148000 },
    { data: '2026-11-12', coberto: false, creditos: null, debitos: null, saldoFinal: null, saldoOmie: 1 },
  ];

  it('usa o ÚLTIMO dia com saldo Itaú conhecido (não o último da janela) e rotula "não calibrada"', () => {
    render(<ResumoDiarioExtrato dias={dias} />);
    const bloco = screen.getByTestId('diferenca-do-corte');
    expect(bloco.textContent).toContain('não calibrada');
    expect(bloco.textContent).toContain('Ainda não medimos a que dia a foto do saldo Omie corresponde');
    expect(bloco.textContent).toContain('11/11/2026');
    expect(screen.getByTestId('diferenca-valor').textContent).toMatch(/R\$\s?20,00/); // 1.500,00 − 1.480,00
  });

  it('saldo Omie null no corte → diferença "indisponível", nunca o saldo Itaú inteiro', () => {
    render(<ResumoDiarioExtrato dias={[{ ...dias[1], saldoOmie: null }]} />);
    expect(screen.getByTestId('diferenca-valor').textContent).toBe('indisponível');
  });

  it('nenhum dia com saldo Itaú conhecido → data de corte e diferença "indisponível"', () => {
    render(<ResumoDiarioExtrato dias={[diaNaoCoberto, { ...dias[0], data: '2026-11-09', saldoFinal: null }]} />);
    const bloco = screen.getByTestId('diferenca-do-corte');
    expect(screen.getByTestId('diferenca-valor').textContent).toBe('indisponível');
    expect(bloco.textContent).not.toMatch(/R\$\s?0,00/);
    expect(bloco.textContent).toContain('não calibrada');
  });

  it('diferença zero REAL (Itaú = Omie) mostra R$ 0,00', () => {
    render(<ResumoDiarioExtrato dias={[{ ...dias[1], saldoOmie: 150000 }]} />);
    expect(screen.getByTestId('diferenca-valor').textContent).toMatch(/R\$\s?0,00/);
  });
  it('sem dia coberto, a data de corte mostra INDISPONIVEL', () => {
    render(<ResumoDiarioExtrato dias={[diaNaoCoberto]} />);
    expect(screen.getAllByText(INDISPONIVEL).length).toBeGreaterThanOrEqual(4);
  });
});

describe('Movimento Omie por dia — gate fail-closed (F1 Task 9)', () => {
  const dia: ResumoDia = { data: '2026-10-05', coberto: true, creditos: 15000, debitos: 3000, saldoFinal: 150000, saldoOmie: null };
  const colunasOmie = (c: HTMLElement) => {
    const tds = c.querySelectorAll('tbody tr td');
    return [tds[4]?.textContent, tds[5]?.textContent];
  };
  const rpc = (cal_c: boolean, cal_d: boolean) =>
    montarMovimentoOmie([
      { data: '2026-10-05', creditos_centavos: 15000, debitos_centavos: 3000, regra_versao: 'v1', creditos_calibrado: cal_c, debitos_calibrado: cal_d },
    ]);

  it('sem calibração (omie ausente) as duas colunas dizem "indisponível (regra não calibrada)" e nenhum número Omie', () => {
    const { container } = render(<ResumoDiarioExtrato dias={[dia]} />);
    expect(colunasOmie(container)).toEqual([OMIE_NAO_CALIBRADO, OMIE_NAO_CALIBRADO]);
    expect(screen.getByText('Créditos Omie')).toBeTruthy();
  });

  it('calibração reprovada nos dois lados → as duas colunas fechadas', () => {
    const { container } = render(<ResumoDiarioExtrato dias={[dia]} omie={rpc(false, false)} />);
    expect(colunasOmie(container)).toEqual([OMIE_NAO_CALIBRADO, OMIE_NAO_CALIBRADO]);
  });

  it('só créditos calibrados → crédito aparece, débito fechado', () => {
    const { container } = render(<ResumoDiarioExtrato dias={[dia]} omie={rpc(true, false)} />);
    const [c, d] = colunasOmie(container);
    expect(c).toMatch(/R\$\s?150,00/);
    expect(d).toBe(OMIE_NAO_CALIBRADO);
  });

  it('calibrado e dia sem linha Omie → "indisponível", nunca R$ 0,00', () => {
    const outro = { ...dia, data: '2026-10-06' };
    const { container } = render(<ResumoDiarioExtrato dias={[outro]} omie={rpc(true, true)} />);
    expect(colunasOmie(container)).toEqual(['indisponível', 'indisponível']);
  });
});
