import { describe, expect, it } from 'vitest';
import {
  avisoTelefoneCompartilhado, lerAtendimentosAtivos, lerResultadoAtendimento, mensagemRecusa, rotuloAtendimento,
  TETO_LEITURA_ATENDIMENTOS,
} from '@/lib/radar/atendimento';

const linha = (o: Record<string, unknown> = {}) => ({
  cnpj: '11111111000101', dono_user_id: 'u1', dono_nome: 'Vendedor Um',
  assumido_em: '2026-10-29T12:00:00Z', expira_em: '2026-11-05T12:00:00Z', eh_meu: false, ...o,
});

describe('lerAtendimentosAtivos', () => {
  it('indexa por CNPJ', () => {
    const m = lerAtendimentosAtivos([linha(), linha({ cnpj: '22222222000102', eh_meu: true })], 'f');
    expect(m.get('11111111000101')?.donoNome).toBe('Vendedor Um');
    expect(m.get('22222222000102')?.ehMeu).toBe(true);
  });
  it('dono sem nome vira null, não some', () => {
    expect(lerAtendimentosAtivos([linha({ dono_nome: null })], 'f').get('11111111000101')?.donoNome).toBeNull();
  });
  it('forma inesperada LANÇA (nunca "sem dono")', () => {
    expect(() => lerAtendimentosAtivos(null, 'f')).toThrow('f: resposta fora da forma esperada (lista)');
    expect(() => lerAtendimentosAtivos([linha({ eh_meu: 'sim' })], 'f')).toThrow('f: resposta fora da forma esperada');
  });
  it('no teto do PostgREST é ERRO: a lista pode estar cortada', () => {
    const muitas = Array.from({ length: TETO_LEITURA_ATENDIMENTOS }, (_, i) => linha({ cnpj: String(i).padStart(14, '0') }));
    expect(() => lerAtendimentosAtivos(muitas, 'f')).toThrow('no teto da leitura');
  });
});

describe('lerResultadoAtendimento', () => {
  it('assumiu', () => {
    expect(lerResultadoAtendimento({ ok: true, renovado: false, expira_em: '2026-11-05T12:00:00Z' }, 'f'))
      .toEqual({ ok: true, renovado: false, jaLivre: false, expiraEm: '2026-11-05T12:00:00Z' });
  });
  it('em atendimento por outro', () => {
    expect(lerResultadoAtendimento({ ok: false, motivo: 'em_atendimento', dono_nome: 'Vendedor Um', expira_em: null }, 'f'))
      .toEqual({ ok: false, motivo: 'em_atendimento', donoNome: 'Vendedor Um', expiraEm: null });
  });
  it('limite', () => {
    expect(lerResultadoAtendimento({ ok: false, motivo: 'limite', limite: 100 }, 'f')).toEqual({ ok: false, motivo: 'limite', limite: 100 });
  });
  it('motivo desconhecido LANÇA', () => {
    expect(() => lerResultadoAtendimento({ ok: false, motivo: 'outro' }, 'f')).toThrow('f: resposta fora da forma esperada (motivo conhecido)');
    expect(() => lerResultadoAtendimento('x', 'f')).toThrow('f: resposta fora da forma esperada ({ok, …})');
  });
});

describe('textos', () => {
  it('chip: meu × de outro (data em São Paulo)', () => {
    const base = lerAtendimentosAtivos([linha({ expira_em: '2026-11-05T02:00:00Z' })], 'f').get('11111111000101')!;
    expect(rotuloAtendimento(base)).toBe('em atendimento por Vendedor Um até 04/11');
    expect(rotuloAtendimento({ ...base, ehMeu: true })).toBe('com você até 04/11');
  });
  it('recusas', () => {
    expect(mensagemRecusa({ ok: false, motivo: 'nao_e_dono', donoNome: null, expiraEm: null })).toBe('Só o dono ou um gestor pode liberar este lead');
    expect(mensagemRecusa({ ok: false, motivo: 'ja_cliente' })).toBe('Esta empresa já é cliente: não há o que prospectar');
  });
  it('telefone compartilhado é aviso só a partir de 1 outra raiz', () => {
    expect(avisoTelefoneCompartilhado(0)).toBeNull();
    expect(avisoTelefoneCompartilhado(1)).toBe('Este número também aparece em 1 empresa de outra raiz de CNPJ');
    expect(avisoTelefoneCompartilhado(23)).toBe('Este número aparece em 23 empresas de raízes diferentes');
  });
});
