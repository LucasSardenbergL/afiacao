import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AncoraManualExtrato } from '../AncoraManualExtrato';
import type { AncoraConta } from '@/services/financeiroExtratoBancario';

const ancoras: AncoraConta[] = [
  { id: 'a1', data: '2026-11-19', saldo: 150000, origem: 'manual', registradoEm: '2026-11-21T10:00:00Z' },
  { id: 'a2', data: '2026-11-18', saldo: null, origem: 'cnab', registradoEm: '2026-11-20T10:00:00Z' },
];

function montar(onRegistrar = vi.fn(), extra: Partial<React.ComponentProps<typeof AncoraManualExtrato>> = {}) {
  render(
    <AncoraManualExtrato
      ancoras={ancoras}
      carregando={false}
      erro={null}
      registrando={false}
      hoje="2026-11-21"
      onRegistrar={onRegistrar}
      {...extra}
    />,
  );
  return onRegistrar;
}
const preencher = (data: string, saldo: string) => {
  fireEvent.change(screen.getByLabelText('Data'), { target: { value: data } });
  fireEvent.change(screen.getByLabelText(/Saldo ao fim do dia/), { target: { value: saldo } });
};

describe('AncoraManualExtrato', () => {
  it('valor BR válido chama onRegistrar com centavos exatos (e sinal)', () => {
    const on = montar();
    preencher('2026-11-19', '-12.345,67');
    fireEvent.click(screen.getByRole('button', { name: /Registrar saldo/ }));
    expect(on).toHaveBeenCalledWith('2026-11-19', -1234567);
  });
  it('texto ambíguo (12.345) é recusado SEM chamar a RPC e mostra erro', () => {
    const on = montar();
    preencher('2026-11-19', '12.345');
    fireEvent.click(screen.getByRole('button', { name: /Registrar saldo/ }));
    expect(on).not.toHaveBeenCalled();
    expect(screen.getByText(/formato 12\.345,67/)).toBeTruthy();
  });
  it('saldo vazio nunca vira 0: não chama', () => {
    const on = montar();
    preencher('2026-11-19', '');
    fireEvent.click(screen.getByRole('button', { name: /Registrar saldo/ }));
    expect(on).not.toHaveBeenCalled();
  });
  it('data de hoje é recusada', () => {
    const on = montar();
    preencher('2026-11-21', '1,00');
    fireEvent.click(screen.getByRole('button', { name: /Registrar saldo/ }));
    expect(on).not.toHaveBeenCalled();
    expect(screen.getByText(/Use um dia já fechado/)).toBeTruthy();
  });
  it('lista as âncoras marcadas manual/cnab; saldo ausente é "indisponível", não R$ 0,00', () => {
    montar();
    expect(screen.getByText('manual')).toBeTruthy();
    expect(screen.getByText('cnab')).toBeTruthy();
    expect(screen.getByText('indisponível')).toBeTruthy();
    expect(document.body.textContent).toMatch(/R\$\s?1\.500,00/);
    expect(document.body.textContent).not.toMatch(/R\$\s?0,00/);
  });
  it('mostra erro de carregamento da lista', () => {
    montar(vi.fn(), { ancoras: [], erro: 'falhou' });
    expect(screen.getByText(/falhou/)).toBeTruthy();
  });
  it('explica a véspera e o reenvio do arquivo', () => {
    montar();
    expect(screen.getByText(/véspera/)).toBeTruthy();
    expect(screen.getByText(/reenvie o arquivo/)).toBeTruthy();
  });
  it('data sugerida (véspera do pendente) vem pré-preenchida', () => {
    montar(vi.fn(), { dataSugerida: '2026-11-09' });
    expect((screen.getByLabelText('Data') as HTMLInputElement).value).toBe('2026-11-09');
  });
  it('sem sugestão, a data fica vazia', () => {
    montar();
    expect((screen.getByLabelText('Data') as HTMLInputElement).value).toBe('');
  });
});
