import { describe, expect, it } from 'vitest';
import {
  ErroSituacaoReceita,
  formatarDataIsoBr,
  interpretarRespostaSituacao,
  seloReceita,
  type SituacaoReceita,
} from '../situacao-cliente';

const linha = (over: Record<string, unknown> = {}) => ({
  estado: 'irregular',
  cnpj: '11111111000191',
  situacao: '04',
  data_situacao: '2025-12-31',
  motivo_descricao: 'OMISSAO DE DECLARACOES',
  lote: '2026-10',
  lote_vigente: '2026-10',
  confirmado_no_vigente: true,
  ...over,
});

function motivoDoErro(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ErroSituacaoReceita) return e.motivo;
    return 'outro-erro';
  }
  return 'nao-lancou';
}

describe('interpretarRespostaSituacao', () => {
  it('1 linha irregular → ok com os campos mapeados', () => {
    const r = interpretarRespostaSituacao([linha()], null);
    expect(r).toEqual({
      tipo: 'ok',
      dado: {
        estado: 'irregular',
        cnpj: '11111111000191',
        situacao: '04',
        dataSituacao: '2025-12-31',
        motivoDescricao: 'OMISSAO DE DECLARACOES',
        lote: '2026-10',
        loteVigente: '2026-10',
        confirmadoNoVigente: true,
      },
    });
  });

  it('recusa de escopo só com 42501 + HINT fora_da_carteira', () => {
    expect(interpretarRespostaSituacao(null, { code: '42501', hint: 'fora_da_carteira', message: 'x' })).toEqual({
      tipo: 'sem_acesso',
    });
  });

  it('42501 SEM o discriminador é erro de fonte (privilégio de dependência ≠ fora da carteira)', () => {
    expect(motivoDoErro(() => interpretarRespostaSituacao(null, { code: '42501', hint: null, message: 'permission denied' }))).toBe(
      'fonte',
    );
  });

  it('erro qualquer é erro de fonte', () => {
    expect(motivoDoErro(() => interpretarRespostaSituacao(null, { code: 'PGRST202', message: 'not found' }))).toBe('fonte');
  });

  it('0 linhas, 2 linhas ou não-lista são erro de CONTRATO — nunca sem_dado', () => {
    expect(motivoDoErro(() => interpretarRespostaSituacao([], null))).toBe('contrato');
    expect(motivoDoErro(() => interpretarRespostaSituacao([linha(), linha()], null))).toBe('contrato');
    expect(motivoDoErro(() => interpretarRespostaSituacao(null, null))).toBe('contrato');
  });

  it('estado desconhecido e irregular sem situação são erro de contrato', () => {
    expect(motivoDoErro(() => interpretarRespostaSituacao([linha({ estado: 'ok' })], null))).toBe('contrato');
    expect(motivoDoErro(() => interpretarRespostaSituacao([linha({ situacao: null })], null))).toBe('contrato');
  });

  it('confirmado_no_vigente ausente/nulo vira false (nunca afirma atualidade sem dado)', () => {
    const r = interpretarRespostaSituacao([linha({ confirmado_no_vigente: null })], null);
    expect(r.tipo === 'ok' && r.dado.confirmadoNoVigente).toBe(false);
  });
});

const dado = (over: Partial<SituacaoReceita> = {}): SituacaoReceita => ({
  estado: 'irregular',
  cnpj: '11111111000191',
  situacao: '08',
  dataSituacao: '2026-03-15',
  motivoDescricao: null,
  lote: '2026-10',
  loteVigente: '2026-10',
  confirmadoNoVigente: true,
  ...over,
});

describe('seloReceita', () => {
  it('irregular confirmado no lote vigente: situação atual com data e base', () => {
    expect(seloReceita(dado())).toEqual({
      titulo: 'CNPJ baixado na Receita',
      detalhe: 'desde 15/03/2026 · base RFB 2026-10',
      confirmado: true,
    });
    expect(seloReceita(dado({ situacao: '03' }))?.titulo).toBe('CNPJ suspenso na Receita');
    expect(seloReceita(dado({ situacao: '04' }))?.titulo).toBe('CNPJ inapto na Receita');
  });

  it('irregular de lote velho é "último registro", com o lote vigente nomeado', () => {
    expect(seloReceita(dado({ lote: '2026-09', confirmadoNoVigente: false }))).toEqual({
      titulo: 'Último registro na Receita: CNPJ baixado',
      detalhe: 'desde 15/03/2026 · base RFB 2026-09 — sem confirmação no lote 2026-10',
      confirmado: false,
    });
  });

  it('sem data da situação: omite o "desde"', () => {
    expect(seloReceita(dado({ dataSituacao: null }))?.detalhe).toBe('base RFB 2026-10');
  });

  it('nenhum outro estado tem selo — ausente nunca vira ativa', () => {
    for (const estado of ['ativa', 'outra', 'sem_dado', 'sem_cnpj', 'sem_documento'] as const) {
      expect(seloReceita(dado({ estado, situacao: estado === 'outra' ? '01' : '02' }))).toBeNull();
    }
  });

  it('01 (nula) não vira selo mesmo se viesse marcada irregular', () => {
    expect(seloReceita(dado({ situacao: '01' }))).toBeNull();
  });
});

describe('formatarDataIsoBr', () => {
  it('converte sem Date e recusa fora do formato', () => {
    expect(formatarDataIsoBr('2025-12-31')).toBe('31/12/2025');
    expect(formatarDataIsoBr('2025-12-31T03:00:00Z')).toBeNull();
    expect(formatarDataIsoBr(null)).toBeNull();
  });
});
