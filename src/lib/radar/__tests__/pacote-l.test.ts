import { describe, it, expect } from 'vitest';
import { opcoesTelefoneCadastro, telefonePadraoCadastro } from '@/lib/radar/telefone-cadastro';
import type { ContatoContabil, LeituraContatoContabil } from '@/lib/radar/contato-contabil';
import { resumoAgendaHoje } from '@/lib/radar/agenda-hoje';
import { lerDesfazer, lerRegistroContato } from '@/lib/radar/borda-rpc';
import { textoPosseDoContato } from '@/lib/radar/atendimento';
import { msAteViradaBRT } from '@/lib/radar/useHojeBRT';

/**
 * Pacote L do Radar (migration 20261111134000). O que pegaria a saída errada:
 *  · telefone da contabilidade sugerido para o Omie (o defeito do `telefone1 || telefone2`);
 *  · agenda que some quando há retorno, ou que aparece "vazia" com RPC antiga;
 *  · posse com forma inesperada transformando um contato GRAVADO em erro (o vendedor repetiria o registro);
 *  · virada do dia calculada no fuso do aparelho.
 */

const contato = (campo: ContatoContabil['campo'], efetivo: boolean | null): ContatoContabil => ({
  campo, tipo: campo === 'email' ? 'email' : 'telefone', automatico: efetivo, motivos: [], grupos: null,
  corroborado: null, correcaoId: null, veredito: null, efetivo,
});
const leitura = (...cs: ContatoContabil[]): LeituraContatoContabil => ({
  contatos: new Map(cs.map((c) => [c.campo, c])), visitar: false, calculadoEm: '2026-11-08T03:00:00Z',
});

describe('telefone do cadastro no Omie', () => {
  it('telefone1 da contabilidade: a sugestão é o telefone2, e o telefone1 vem marcado', () => {
    const op = opcoesTelefoneCadastro({ telefone1: '3732220001', telefone2: '3799990002' },
      leitura(contato('telefone1', true), contato('telefone2', false)));
    expect(op).toEqual([
      { campo: 'telefone1', numero: '3732220001', contabil: true },
      { campo: 'telefone2', numero: '3799990002', contabil: false },
    ]);
    expect(telefonePadraoCadastro(op)).toBe('3799990002');
  });

  it('só o da contabilidade: a sugestão é NÃO enviar telefone (null), nunca o número do escritório', () => {
    const op = opcoesTelefoneCadastro({ telefone1: '3732220001', telefone2: null }, leitura(contato('telefone1', true)));
    expect(telefonePadraoCadastro(op)).toBeNull();
  });

  it('leitura da contabilidade ausente: não afirma nada (contabil null) e sugere o 1º número, como antes', () => {
    const op = opcoesTelefoneCadastro({ telefone1: ' 3732220001 ', telefone2: '' }, undefined);
    expect(op).toEqual([{ campo: 'telefone1', numero: '3732220001', contabil: null }]);
    expect(telefonePadraoCadastro(op)).toBe('3732220001');
  });

  it('o mesmo número nos dois campos aparece uma vez só', () => {
    expect(opcoesTelefoneCadastro({ telefone1: '(37) 3222-0001', telefone2: '3732220001' }, null)).toHaveLength(1);
  });
});

describe('agenda "Hoje" do /radar', () => {
  const ret = (cnpj: string, atrasado = false) => ({
    cnpj, razaoSocial: null, nomeFantasia: null, municipioNome: null, uf: null, tipo: 'conversa' as const,
    retornoEm: '2026-11-09', atrasado, nota: null,
  });

  it('retornos e posses vencendo: não está vazia, conta atrasados e o que ficou fora dos itens', () => {
    const r = resumoAgendaHoje({
      retornos: { total: 3, itens: [ret('A', true), ret('B')] },
      posses: { vencendo: [{ atendimentoId: 1, cnpj: 'C', razaoSocial: null, nomeFantasia: null, expiraEm: '2026-11-10T12:00:00Z' }], vencidas7d: 2 },
    });
    expect(r.vazia).toBe(false);
    expect(r.retornosFora).toBe(1);
    expect(r.rotulo).toBe('3 retornos (1 atrasado) · 1 posse vencendo');
  });

  it('só posses já vencidas não é ação: a agenda some', () => {
    expect(resumoAgendaHoje({ retornos: { total: 0, itens: [] }, posses: { vencendo: [], vencidas7d: 4 } }).vazia).toBe(true);
  });

  it('RPC anterior ao pacote G (campos null) não vira "nada para hoje" mostrado — some', () => {
    const r = resumoAgendaHoje({ retornos: null, posses: null });
    expect(r.vazia).toBe(true);
    expect(r.totalRetornos).toBe(0);
  });
});

describe('posse na resposta do registro', () => {
  const base = { id: 'c1', deduped: false, nota_gravada: true, retorno_em: '2026-11-16' };

  it('posse nova, renovada e de outro vendedor são lidas e viram a frase do toast', () => {
    const nova = lerRegistroContato({ ...base, posse: { ok: true, renovado: false, expira_em: '2026-11-16T15:00:00+00:00' } }, 't');
    expect(nova.posse).toEqual({ ok: true, renovado: false, expiraEm: '2026-11-16T15:00:00+00:00' });
    expect(textoPosseDoContato(nova.posse)).toBe('O lead ficou com você até 16/11.');
    const outro = lerRegistroContato({ ...base, posse: { ok: false, motivo: 'em_atendimento', dono_nome: 'Regina', expira_em: null } }, 't');
    expect(textoPosseDoContato(outro.posse)).toContain('em atendimento por Regina');
    const renov = lerRegistroContato({ ...base, posse: { ok: true, renovado: true, expira_em: null } }, 't');
    expect(textoPosseDoContato(renov.posse)).toBe('Segue com você.');
  });

  it('banco anterior (sem a chave), já-cliente e forma inesperada: posse null, e o registro NÃO vira erro', () => {
    expect(lerRegistroContato(base, 't').posse).toBeNull();
    expect(textoPosseDoContato(lerRegistroContato({ ...base, posse: { ok: false, motivo: 'ja_cliente' } }, 't').posse)).toBeNull();
    expect(lerRegistroContato({ ...base, posse: { ok: 'talvez' } }, 't')).toMatchObject({ id: 'c1', posse: null });
  });

  it('desfazer diz quando a posse saiu junto; banco anterior não afirma', () => {
    expect(lerDesfazer({ deleted: true, status_restaurado: true, posse_desfeita: true }, 't').posseDesfeita).toBe(true);
    expect(lerDesfazer({ deleted: true, status_restaurado: true }, 't').posseDesfeita).toBe(false);
  });
});

describe('virada do "hoje" em BRT', () => {
  it('23:59:30 em São Paulo (02:59:30 UTC) vira em 30 s (+ folga), não às 21h do UTC', () => {
    expect(msAteViradaBRT(new Date('2026-11-10T02:59:30Z'))).toBe(31_000);
  });
  it('21:30 em São Paulo (00:30 UTC do dia seguinte): faltam 2h30 — o dia UTC já virou, o de SP não', () => {
    expect(msAteViradaBRT(new Date('2026-11-10T00:30:00Z'))).toBe(2.5 * 3600_000 + 1_000);
  });
});
