import { describe, expect, it, vi } from 'vitest';
import {
  parsearConflito,
  parsearEstadoCadastro,
  parsearRegistroV2,
  situacaoConflito,
  type ConflitoCadastro,
} from '../conflito-cadastro';
import { sincronizarDivergentes, type LotePersistido } from '../lote-persistido';

// Migration 20261027160000 (achado 3 do Codex no PR #3293): a forma das respostas é CONFERIDA — desvio vira
// RADAR_RESPOSTA_INDETERMINADA, nunca "sem conflito" nem "gravado".
const linha = {
  id: 7, cnpj: '12345678000195', motivo: 'vinculo_divergente', codigo_recebido: '777', codigo_vinculado: '555', cnpj_do_codigo: null,
  detalhe: 'RADAR_VINCULO_DIVERGENTE: …', ocorrencias: 2, versao: 3, criado_em: '2026-10-27T15:00:00Z', ultima_em: '2026-10-27T16:00:00Z',
  resolvido_em: null, resolvido_por: null, nota_resolucao: null, criado_por: 'u', ultimo_por: 'u',
};
const c = (over: Partial<ConflitoCadastro> = {}): ConflitoCadastro => ({ ...parsearConflito(linha), ...over });

describe('parse das respostas do servidor', () => {
  it('linha da tabela/to_jsonb → camelCase com versão e ocorrências', () => {
    expect(parsearConflito(linha)).toMatchObject({ id: 7, motivo: 'vinculo_divergente', codigoRecebido: '777', codigoVinculado: '555', ocorrencias: 2, versao: 3, resolvidoEm: null });
  });
  it.each([
    ['motivo desconhecido', { ...linha, motivo: 'outro' }],
    ['versão ausente', { ...linha, versao: undefined }],
    ['id string', { ...linha, id: '7' }],
    ['versão zero', { ...linha, versao: 0 }],
    ['não-objeto', 'x'],
  ])('%s → RADAR_RESPOSTA_INDETERMINADA', (_n, v) => {
    expect(() => parsearConflito(v)).toThrow(/^RADAR_RESPOSTA_INDETERMINADA: /);
  });
  it('estado: vínculo aparado, vazio vira null, conflitos parseados', () => {
    expect(parsearEstadoCadastro({ vinculo: ' 555 ', conflitos: [linha] })).toMatchObject({ vinculo: '555', conflitos: [{ id: 7 }] });
    expect(parsearEstadoCadastro({ vinculo: '  ', conflitos: [] })).toEqual({ vinculo: null, conflitos: [] });
    expect(() => parsearEstadoCadastro({ vinculo: null })).toThrow(/^RADAR_RESPOSTA_INDETERMINADA: /);
  });
  it('v2: só as duas formas; o resto é indeterminado (nunca "gravado")', () => {
    expect(parsearRegistroV2({ ok: true, deduped: false })).toEqual({ ok: true, deduped: false });
    expect(parsearRegistroV2({ ok: false, bloqueado: true, conflito: linha })).toMatchObject({ ok: false, bloqueado: true, conflito: { id: 7 } });
    expect(() => parsearRegistroV2({ ok: true })).toThrow(/^RADAR_RESPOSTA_INDETERMINADA: /);
    expect(() => parsearRegistroV2({ ok: false, bloqueado: false })).toThrow(/^RADAR_RESPOSTA_INDETERMINADA: /);
    expect(() => parsearRegistroV2(null)).toThrow(/^RADAR_RESPOSTA_INDETERMINADA: /);
  });
});

describe('situacaoConflito — local × servidor (Codex 2026-10-27, g)', () => {
  const resolvido = c({ id: 7, resolvidoEm: '2026-10-27T17:00:00Z', notaResolucao: 'conferi' });
  it('aberto no servidor vence até um item local ok', () => {
    expect(situacaoConflito({ divergente: false, conflitoId: null }, [c()])).toMatchObject({ tipo: 'aberto', conflitos: [{ id: 7 }] });
  });
  it('divergente local cujo registro foi resolvido, sem outro aberto → conferido (não ok)', () => {
    expect(situacaoConflito({ divergente: true, conflitoId: 7 }, [resolvido])).toMatchObject({ tipo: 'conferido', conflito: { id: 7 } });
  });
  it('resolvido + OUTRO aberto → aberto (resolver um não libera os demais)', () => {
    expect(situacaoConflito({ divergente: true, conflitoId: 7 }, [resolvido, c({ id: 8 })]).tipo).toBe('aberto');
  });
  it('divergente local sem registro correspondente → não sincronizado (ausência no servidor não prova resolução)', () => {
    expect(situacaoConflito({ divergente: true, conflitoId: null }, []).tipo).toBe('nao_sincronizado');
    expect(situacaoConflito({ divergente: true, conflitoId: 9 }, [resolvido]).tipo).toBe('nao_sincronizado');
  });
  it('leitura falhou → indisponível para o divergente local (nunca "nenhum")', () => {
    expect(situacaoConflito({ divergente: true, conflitoId: 7 }, null).tipo).toBe('indisponivel');
  });
});

describe('sincronizarDivergentes — esquecer o lote não apaga a única evidência', () => {
  const lote = (): LotePersistido => ({
    v: 1, iniciadoEm: '2026-10-27T10:00:00Z', itens: [
      { cnpj: '11111111000111', nome: 'A', estado: { status: 'divergente', motivo: 'vinculo_divergente', erro: 'x', codigo: '777' } },
      { cnpj: '22222222000122', nome: 'B', estado: { status: 'divergente', motivo: 'lookup_divergente', erro: 'y', codigo: null, conflitoId: 5 } },
      { cnpj: '33333333000133', nome: 'C', estado: { status: 'ok', codigo: '1', jaExistia: false, recuperado: false } },
    ],
  });
  it('envia SÓ os não sincronizados e grava o id devolvido', async () => {
    const registrar = vi.fn(async () => ({ id: 42 }));
    const r = await sincronizarDivergentes(lote(), registrar, () => false);
    expect(registrar).toHaveBeenCalledTimes(1);
    expect(registrar).toHaveBeenCalledWith('11111111000111', 'vinculo_divergente', '777', 'x');
    expect(r.falhas).toEqual([]);
    expect(r.lote.itens[0].estado).toMatchObject({ status: 'divergente', conflitoId: 42 });
  });
  it('falha de rede → fica em `falhas` (o lote não pode ser esquecido) e sem id', async () => {
    const r = await sincronizarDivergentes(lote(), vi.fn(async () => { throw new Error('Failed to fetch'); }), () => false);
    expect(r.falhas).toEqual([{ cnpj: '11111111000111', erro: 'Failed to fetch' }]);
    expect(r.lote.itens[0].estado).not.toHaveProperty('conflitoId');
  });
  it('servidor desmente (RD003) → desmentido, não falha', async () => {
    const err = { code: 'RD003', message: 'RADAR_CONFLITO_NAO_CONFIRMADO: …' };
    const r = await sincronizarDivergentes(lote(), vi.fn(async () => { throw err; }), (e) => e === err);
    expect(r).toMatchObject({ falhas: [], desmentidos: ['11111111000111'] });
  });
  it('motivo desconhecido no storage → falha (não envia lixo)', async () => {
    const l = lote();
    l.itens[0] = { ...l.itens[0], estado: { status: 'divergente', motivo: 'velho', erro: 'x', codigo: null } };
    const registrar = vi.fn(async () => ({ id: 1 }));
    const r = await sincronizarDivergentes(l, registrar, () => false);
    expect(registrar).not.toHaveBeenCalled();
    expect(r.falhas[0]).toMatchObject({ cnpj: '11111111000111' });
  });
});
