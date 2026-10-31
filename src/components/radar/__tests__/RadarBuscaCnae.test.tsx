import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const track = vi.fn();
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => track(...a) }));

import { RadarBuscaCnae } from '../RadarBuscaCnae';

beforeEach(() => track.mockClear());

describe('RadarBuscaCnae — CNAE pelo nome da atividade', () => {
  it('nome digitado NÃO vai ao filtro; escolher a sugestão aplica o código formatado', () => {
    const onChange = vi.fn();
    render(<RadarBuscaCnae valor="" onChange={onChange} />);
    const campo = screen.getByRole('combobox');
    fireEvent.focus(campo);
    fireEvent.change(campo, { target: { value: 'marmore' } });
    expect(onChange).not.toHaveBeenCalled();
    const opcao = screen.getByRole('option', { name: /marmorarias/i });
    fireEvent.mouseDown(opcao);
    expect(onChange).toHaveBeenCalledWith('2391-5/03');
    expect(track).toHaveBeenCalledWith('radar.cnae_escolhido', { codigo: '2391503', por_nome: true });
  });

  it('código digitado passa direto ao filtro (o comportamento de antes)', () => {
    const onChange = vi.fn();
    render(<RadarBuscaCnae valor="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '3101' } });
    expect(onChange).toHaveBeenLastCalledWith('3101');
  });

  it('Enter escolhe a sugestão ativa; sair sem escolher volta o campo ao filtro real', () => {
    const onChange = vi.fn();
    render(<RadarBuscaCnae valor="3101-2/00" onChange={onChange} />);
    const campo = screen.getByRole('combobox') as HTMLInputElement;
    fireEvent.focus(campo);
    fireEvent.change(campo, { target: { value: 'serraria' } });
    fireEvent.blur(campo);
    expect(campo.value).toBe('3101-2/00');
    fireEvent.focus(campo);
    fireEvent.change(campo, { target: { value: 'serraria' } });
    fireEvent.keyDown(campo, { key: 'ArrowDown' });
    fireEvent.keyDown(campo, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('1610-2/04');
  });
});
