// Prova dos helpers puros do Prime (PR-2 admin).
// O que MORDE aqui: (1) valorAfiacao divergir do round(q×p,2) do Postgres por
// float → 23514 em prod; (2) competência derivada fora de America/Sao_Paulo →
// P0001 de vigência na virada de mês; (3) payload de INSERT violar os CHECKs
// por tipo (valor em operacional = fabricação de R$); (4) tradutor de erro
// deixar o staff sem entender o guard do banco.
import { describe, expect, it } from 'vitest';
import { formatMes, gerarMesesVigencia, mesDe, valorAfiacao } from './competencia';
import { traduzirErroPrime } from './erros';
import { formatBRL, formatData } from './format';
import {
  montarInsertUso,
  parseValorBR,
  usoFormSchema,
  VALOR_BR_REGEX,
  type UsoFormValues,
} from './uso-form';

describe('valorAfiacao — espelho exato do CHECK valor = round(q × snapshot, 2)', () => {
  it('96 dentes × R$1,20 = R$115,20 exato (caso da spec — float daria 115.19999…)', () => {
    expect(valorAfiacao(96, 1.2)).toBe(115.2);
  });

  it('200 × 1.20 = 240.00 (franquia cheia)', () => {
    expect(valorAfiacao(200, 1.2)).toBe(240);
  });

  it('casos de arredondamento binário hostil ficam exatos em centavos', () => {
    // 3 × 0.1 em float = 0.30000000000000004 — em centavos inteiros, 0.3 exato.
    expect(valorAfiacao(3, 0.1)).toBe(0.3);
    expect(valorAfiacao(7, 1.15)).toBe(8.05);
    expect(valorAfiacao(1, 0.29)).toBe(0.29);
  });

  it('com preço a 2 casas × quantidade inteira, o resultado já tem 2 casas (round do banco vira no-op)', () => {
    for (const [q, p] of [
      [96, 1.2],
      [33, 0.07],
      [500, 2.55],
      [1, 0.01],
    ] as const) {
      const v = valorAfiacao(q, p);
      expect(Math.round(v * 100) / 100).toBe(v);
    }
  });
});

describe('parseValorBR + VALOR_BR_REGEX', () => {
  it('aceita vírgula e ponto, até 2 casas', () => {
    expect(VALOR_BR_REGEX.test('1,20')).toBe(true);
    expect(VALOR_BR_REGEX.test('1.20')).toBe(true);
    expect(VALOR_BR_REGEX.test('99')).toBe(true);
    expect(parseValorBR('1,20')).toBe(1.2);
    expect(parseValorBR('115.20')).toBe(115.2);
  });
  it('rejeita 3 casas (meio-centavo → round do banco divergiria do JS) e lixo', () => {
    expect(VALOR_BR_REGEX.test('1,205')).toBe(false);
    expect(VALOR_BR_REGEX.test('')).toBe(false);
    expect(VALOR_BR_REGEX.test('abc')).toBe(false);
    expect(VALOR_BR_REGEX.test('1,2,3')).toBe(false);
  });
});

describe('format — ausente ≠ zero na exibição', () => {
  it('formatBRL: null/undefined vira "—", NUNCA R$ 0,00 fabricado', () => {
    expect(formatBRL(null)).toBe('—');
    expect(formatBRL(undefined)).toBe('—');
    expect(formatBRL(115.2)).toMatch(/115,20/);
    expect(formatBRL(0)).toMatch(/0,00/); // zero REAL continua zero
  });
  it('formatData: posicional (sem Date/TZ), null vira "—"', () => {
    expect(formatData('2026-07-01')).toBe('01/07/2026');
    expect(formatData(null)).toBe('—');
  });
});

describe('competência', () => {
  it('mesDe trunca para o dia 1', () => {
    expect(mesDe('2026-07-11')).toBe('2026-07-01');
    expect(mesDe('2026-12-31')).toBe('2026-12-01');
  });

  it('formatMes é posicional (sem Date/TZ)', () => {
    expect(formatMes('2026-07-01')).toBe('jul/2026');
    expect(formatMes('2025-01-01')).toBe('jan/2025');
    expect(formatMes('lixo')).toBe('lixo');
  });

  it('gerarMesesVigencia: do início ao mês final, decrescente, cruzando virada de ano', () => {
    expect(gerarMesesVigencia('2025-11-15', '2026-02-01')).toEqual([
      '2026-02-01',
      '2026-01-01',
      '2025-12-01',
      '2025-11-01',
    ]);
  });

  it('gerarMesesVigencia: início no mês corrente = 1 opção; início futuro = vazio', () => {
    expect(gerarMesesVigencia('2026-07-01', '2026-07-01')).toEqual(['2026-07-01']);
    expect(gerarMesesVigencia('2026-08-01', '2026-07-01')).toEqual([]);
  });

  it('gerarMesesVigencia: cap defensivo mantém os mais recentes', () => {
    const meses = gerarMesesVigencia('2020-01-01', '2026-07-01', 3);
    expect(meses).toEqual(['2026-07-01', '2026-06-01', '2026-05-01']);
  });
});

describe('montarInsertUso — payload espelha os CHECKs por tipo', () => {
  const base: UsoFormValues = {
    assinatura_id: 'a1',
    tipo: 'afiacao_dentes',
    quantidade: '96',
    preco_unitario: '1,20',
    valor_desconto: '',
    competencia: '2026-07-01',
    referencia: ' PV-123 ',
    descricao: '',
  };

  it('afiação: valor = q × preço (vírgula BR), snapshot preenchido, referência trimada', () => {
    const insert = montarInsertUso(base, 'user-1');
    expect(insert).toMatchObject({
      tipo: 'afiacao_dentes',
      quantidade: 96,
      valor_tabela: 115.2,
      preco_unitario_snapshot: 1.2,
      referencia: 'PV-123',
      descricao: null,
      created_by: 'user-1',
    });
  });

  it('bônus: valor NULL (crédito não monetiza — ausente ≠ zero), sem snapshot', () => {
    const insert = montarInsertUso(
      { ...base, tipo: 'bonus_dentes', quantidade: '50', preco_unitario: '', referencia: '' },
      'user-1',
    );
    expect(insert.valor_tabela).toBeNull();
    expect(insert.preco_unitario_snapshot).toBeNull();
    expect(insert.quantidade).toBe(50);
    expect(insert.referencia).toBeNull();
  });

  it('desconto: quantidade forçada 1, valor manual, sem snapshot', () => {
    const insert = montarInsertUso(
      { ...base, tipo: 'desconto_abrasivo', quantidade: '99', valor_desconto: '25,50' },
      'user-1',
    );
    expect(insert.quantidade).toBe(1);
    expect(insert.valor_tabela).toBe(25.5);
    expect(insert.preco_unitario_snapshot).toBeNull();
  });

  it('evento operacional: quantidade forçada 1 e valor NULL (nunca R$ em operacional)', () => {
    for (const tipo of [
      'atendimento_tecnico',
      'prioridade_entrega',
      'prioridade_separacao',
      'coleta_rota',
    ] as const) {
      const insert = montarInsertUso(
        { ...base, tipo, quantidade: '7', preco_unitario: '', referencia: '' },
        'user-1',
      );
      expect(insert.quantidade).toBe(1);
      expect(insert.valor_tabela).toBeNull();
      expect(insert.preco_unitario_snapshot).toBeNull();
    }
  });
});

describe('usoFormSchema — validação por tipo (campos string, idioma BR)', () => {
  const valido = {
    assinatura_id: 'a1',
    tipo: 'afiacao_dentes',
    quantidade: '96',
    preco_unitario: '1,20',
    valor_desconto: '',
    competencia: '2026-07-01',
    referencia: 'PV-1',
    descricao: '',
  };

  it('aceita afiação válida (preço com vírgula)', () => {
    expect(usoFormSchema.safeParse(valido).success).toBe(true);
  });

  it('rejeita dentes fracionados, vazios e não-numéricos', () => {
    expect(usoFormSchema.safeParse({ ...valido, quantidade: '96,5' }).success).toBe(false);
    expect(usoFormSchema.safeParse({ ...valido, quantidade: '' }).success).toBe(false);
    expect(usoFormSchema.safeParse({ ...valido, quantidade: '0' }).success).toBe(false);
  });

  it('rejeita afiação sem preço/dente, preço zero e 3 casas', () => {
    expect(usoFormSchema.safeParse({ ...valido, preco_unitario: '' }).success).toBe(false);
    expect(usoFormSchema.safeParse({ ...valido, preco_unitario: '0' }).success).toBe(false);
    expect(usoFormSchema.safeParse({ ...valido, preco_unitario: '1,205' }).success).toBe(false);
  });

  it('rejeita monetizável sem referência (lastro Omie obrigatório)', () => {
    expect(usoFormSchema.safeParse({ ...valido, referencia: '  ' }).success).toBe(false);
    expect(
      usoFormSchema.safeParse({
        ...valido,
        tipo: 'desconto_abrasivo',
        valor_desconto: '10',
        referencia: '',
      }).success,
    ).toBe(false);
  });

  it('rejeita bônus acima do teto de 50', () => {
    const r = usoFormSchema.safeParse({
      ...valido,
      tipo: 'bonus_dentes',
      quantidade: '60',
      preco_unitario: '',
      referencia: '',
    });
    expect(r.success).toBe(false);
  });

  it('aceita evento operacional sem valor nem referência', () => {
    const r = usoFormSchema.safeParse({
      ...valido,
      tipo: 'coleta_rota',
      quantidade: '',
      preco_unitario: '',
      referencia: '',
    });
    expect(r.success).toBe(true);
  });

  it('rejeita competência que não seja dia 1º', () => {
    expect(usoFormSchema.safeParse({ ...valido, competencia: '2026-07-15' }).success).toBe(false);
  });
});

describe('traduzirErroPrime — guards do banco viram mensagem clara', () => {
  it('P0001: sobreposição de ciclo', () => {
    expect(
      traduzirErroPrime({
        code: 'P0001',
        message:
          'cliente já tem assinatura cobrindo o mês de início (competência não pode duplicar no extrato)',
      }),
    ).toMatch(/já tem assinatura cobrindo esse mês/);
  });

  it('P0001: janela esconderia uso vivo → manda estornar antes', () => {
    expect(
      traduzirErroPrime({
        code: 'P0001',
        message:
          'a janela da assinatura deixaria uso VIVO fora do extrato — estorne os usos fora do período antes',
      }),
    ).toMatch(/Estorne os usos fora do período/);
  });

  it('P0001: uso em suspensa/cancelada', () => {
    expect(
      traduzirErroPrime({
        code: 'P0001',
        message: 'assinatura suspensa — uso bloqueado (suspensa/cancelada congela franquia)',
      }),
    ).toMatch(/franquia está congelada/);
  });

  it('P0001: grandfathering (campos contratuais imutáveis)', () => {
    expect(
      traduzirErroPrime({
        code: 'P0001',
        message:
          'campos contratuais da assinatura são imutáveis (grandfathering) — mudança de condição = cancelar e abrir novo ciclo',
      }),
    ).toMatch(/grandfathering/);
  });

  it('23505: bônus 1/mês e assinatura viva única (nome do índice na message)', () => {
    expect(
      traduzirErroPrime({
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_prime_bonus_mes"',
      }),
    ).toMatch(/limite: 1 por mês/);
    expect(
      traduzirErroPrime({
        code: '23505',
        message: 'duplicate key value violates unique constraint "uq_prime_assinatura_viva"',
      }),
    ).toMatch(/assinatura viva/);
  });

  it('23514: contrafactual e teto de bônus', () => {
    expect(
      traduzirErroPrime({
        code: '23514',
        message:
          'new row for relation "prime_beneficio_uso" violates check constraint "prime_uso_afiacao_consistente"',
      }),
    ).toMatch(/quantidade × preço\/dente/);
    expect(
      traduzirErroPrime({
        code: '23514',
        message: 'violates check constraint "prime_uso_bonus_teto"',
      }),
    ).toMatch(/máximo de 50/);
  });

  it('estorno: já estornado é imutável', () => {
    expect(
      traduzirErroPrime({ code: 'P0001', message: 'registro já estornado é imutável' }),
    ).toMatch(/já foi estornado/);
  });

  it('fallback: repassa a mensagem do banco (nunca engole o erro)', () => {
    expect(traduzirErroPrime({ code: 'P0001', message: 'guarda nova do futuro' })).toBe(
      'guarda nova do futuro',
    );
    expect(traduzirErroPrime('string solta')).toBe('string solta');
    expect(traduzirErroPrime(null)).toBe('Erro inesperado ao falar com o banco.');
  });

  it('42501: RLS defensivo', () => {
    expect(traduzirErroPrime({ code: '42501', message: 'permission denied' })).toMatch(/staff/);
  });
});
