import { describe, it, expect } from 'vitest';
import { consolidarTitulos, TITULOS_INDISPONIVEIS, type TotaisTitulos } from '@/lib/financeiro/resumo-titulos';

const conhecidos = (receber: number, pagar: number, vencR = 0, vencP = 0): TotaisTitulos => ({
  total_a_receber: receber,
  total_a_pagar: pagar,
  total_vencido_receber: vencR,
  total_vencido_pagar: vencP,
  posicao_liquida: receber - pagar,
  titulos_motivo: null,
});

describe('consolidarTitulos', () => {
  it('soma os CNPJs quando todos têm títulos conhecidos', () => {
    expect(consolidarTitulos([conhecidos(100, 30, 10, 5), conhecidos(50, 80, 0, 20)])).toEqual({
      total_a_receber: 150,
      total_a_pagar: 110,
      total_vencido_receber: 10,
      total_vencido_pagar: 25,
      posicao_liquida: 40,
      titulos_motivo: null,
    });
  });

  it('zero conhecido continua zero (carteira sem título aberto é fato, não ausência)', () => {
    expect(consolidarTitulos([conhecidos(0, 0)])).toMatchObject({ total_a_receber: 0, posicao_liquida: 0, titulos_motivo: null });
  });

  it('um CNPJ indisponível anula o grupo inteiro e carrega o motivo — nunca o total dos que responderam', () => {
    const r = consolidarTitulos([conhecidos(100, 30), TITULOS_INDISPONIVEIS('saldo de títulos indisponível (colacor): sem_acesso')]);
    expect(r).toEqual(TITULOS_INDISPONIVEIS('saldo de títulos indisponível (colacor): sem_acesso'));
  });

  it('junta os motivos de todos os CNPJs indisponíveis', () => {
    const r = consolidarTitulos([TITULOS_INDISPONIVEIS('a'), conhecidos(1, 1), TITULOS_INDISPONIVEIS('b')]);
    expect(r.titulos_motivo).toBe('a · b');
    expect(r.total_a_pagar).toBeNull();
  });

  it('lista vazia é indisponível, não R$ 0 (o reduce de [] dava zero)', () => {
    expect(consolidarTitulos([])).toEqual(TITULOS_INDISPONIVEIS('nenhuma empresa no resumo'));
  });

  it('total null sem motivo (forma inconsistente) também anula, com motivo genérico', () => {
    const r = consolidarTitulos([{ ...conhecidos(1, 1), total_vencido_pagar: null }]);
    expect(r).toEqual(TITULOS_INDISPONIVEIS('títulos de alguma empresa indisponíveis'));
  });
});
