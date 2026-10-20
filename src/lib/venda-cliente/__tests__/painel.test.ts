import { describe, expect, it } from 'vitest';
import { estadoTaxa, lerPreco, somarDias, validarAprovacao } from '../painel';

const c = (virou: number, nao_virou: number, nao_medivel: number, pendentes = 0) => ({
  virou,
  nao_virou,
  nao_medivel,
  pendentes,
});

describe('estadoTaxa — ausente ≠ zero', () => {
  const ativa = { baseConfiavel: true, exigeBaseConfiavel: false };

  it('com desfecho medível devolve o valor', () => {
    expect(estadoTaxa(c(1, 3, 0), 0.25, ativa)).toEqual({ tipo: 'valor', taxa: 0.25 });
  });

  it('nao_medivel acima de 20% das avaliadas → não consegui medir, nunca a taxa', () => {
    const e = estadoTaxa(c(2, 5, 2), 0.2857, ativa); // 2/9 = 22%
    expect(e.tipo).toBe('nao_medi');
  });

  it('nao_medivel em exatamente 20% ainda é medível', () => {
    expect(estadoTaxa(c(2, 2, 1), 0.5, ativa)).toEqual({ tipo: 'valor', taxa: 0.5 });
  });

  it('tudo pendente → aguardando janela; nada na lista → sem lista (nunca 0%)', () => {
    expect(estadoTaxa(c(0, 0, 0, 4), null, ativa)).toEqual({ tipo: 'aguardando', pendentes: 4 });
    expect(estadoTaxa(c(0, 0, 0, 0), null, ativa)).toEqual({ tipo: 'sem_lista' });
  });

  it('linha de base não confiável → não consegui medir mesmo com número', () => {
    const e = estadoTaxa(c(1, 3, 0), 0.25, { baseConfiavel: false, exigeBaseConfiavel: true });
    expect(e.tipo).toBe('nao_medi');
  });

  it('a taxa ativa não depende da base estar conferida', () => {
    expect(estadoTaxa(c(1, 1, 0), 0.5, { baseConfiavel: false, exigeBaseConfiavel: false }).tipo).toBe('valor');
  });
});

describe('validarAprovacao — espelho das recusas de venda_aprovar_repasse', () => {
  const hoje = '2026-10-20';
  const base = { ultimoPreco: 10, validoAte: '2026-12-01', hoje };

  it('alvo acima do último, em centavos, validade no intervalo → ok', () => {
    expect(validarAprovacao({ ...base, precoAlvo: 10.5 })).toEqual({ ok: true });
  });

  it('alvo igual ou abaixo do último preço → recusa (preço alvo nunca sugere baixar)', () => {
    expect(validarAprovacao({ ...base, precoAlvo: 10 }).ok).toBe(false);
    expect(validarAprovacao({ ...base, precoAlvo: 9.99 }).ok).toBe(false);
  });

  it('alvo acima de 2× o último → recusa (digitação)', () => {
    expect(validarAprovacao({ ...base, precoAlvo: 20.01 }).ok).toBe(false);
    expect(validarAprovacao({ ...base, precoAlvo: 20 }).ok).toBe(true);
  });

  it('mais de 2 casas → recusa', () => {
    expect(validarAprovacao({ ...base, precoAlvo: 10.555 }).ok).toBe(false);
  });

  it('validade hoje ou além de 1 ano → recusa; amanhã e hoje+365 → ok', () => {
    expect(validarAprovacao({ ...base, precoAlvo: 11, validoAte: hoje }).ok).toBe(false);
    expect(validarAprovacao({ ...base, precoAlvo: 11, validoAte: somarDias(hoje, 366) }).ok).toBe(false);
    expect(validarAprovacao({ ...base, precoAlvo: 11, validoAte: somarDias(hoje, 1) }).ok).toBe(true);
    expect(validarAprovacao({ ...base, precoAlvo: 11, validoAte: somarDias(hoje, 365) }).ok).toBe(true);
  });

  it('sem último preço provado ou sem alvo → recusa (nunca trata ausente como 0)', () => {
    expect(validarAprovacao({ ...base, ultimoPreco: null, precoAlvo: 11 }).ok).toBe(false);
    expect(validarAprovacao({ ...base, precoAlvo: null }).ok).toBe(false);
  });
});

describe('lerPreco', () => {
  it('aceita vírgula e ponto; vazio ou lixo é null', () => {
    expect(lerPreco('12,50')).toBe(12.5);
    expect(lerPreco('1.234,56')).toBe(1234.56);
    expect(lerPreco('12.5')).toBe(12.5);
    expect(lerPreco('')).toBeNull();
    expect(lerPreco('abc')).toBeNull();
  });
});

describe('somarDias', () => {
  it('atravessa virada de mês e de ano', () => {
    expect(somarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(somarDias('2026-03-01', -1)).toBe('2026-02-28');
  });
});
