import { describe, expect, it } from 'vitest';
import { MARCADOR_FIM, extrairJsonDaSaida, nomeConfere, sqlCandidatos } from './exportar';

describe('extrairJsonDaSaida — o psql-ro sai 0 com ERROR: o veredito é o MARCADOR, não o exit', () => {
  it('lê as linhas JSON: quando o marcador de fim está presente', () => {
    const saida = ['SET', 'SET', 'JSON:[{"a":1}]', 'JSON:{"b":2}', MARCADOR_FIM, ''].join('\n');
    expect(extrairJsonDaSaida(saida)).toEqual([[{ a: 1 }], { b: 2 }]);
  });

  it('sem marcador ⇒ LANÇA (o SQL não terminou — ausência de erro não é sucesso)', () => {
    expect(() => extrairJsonDaSaida('JSON:[]\n')).toThrow(/marcador/);
  });

  it('linha ERROR: ⇒ LANÇA mesmo com marcador', () => {
    expect(() => extrairJsonDaSaida(`ERROR:  relation "x" does not exist\nJSON:[]\n${MARCADOR_FIM}\n`)).toThrow(/ERROR/);
  });

  it('nenhuma linha JSON: ⇒ LANÇA (resultado vazio ≠ lista vazia)', () => {
    expect(() => extrairJsonDaSaida(`SET\n${MARCADOR_FIM}\n`)).toThrow(/JSON/);
  });
});

describe('sqlCandidatos — réplica de buscar_skus_candidatos (prod, pré-voo pg_get_functiondef)', () => {
  const sql = sqlCandidatos([
    { spec_id: '00000000-0000-0000-0000-000000000001', termos: ['FO20.6827.00', "O'BRIEN"] },
  ]);

  it('mesmos filtros, ordem e teto da RPC', () => {
    expect(sql).toContain('op.ativo IS NOT FALSE');
    expect(sql).toContain('ORDER BY op.account, op.descricao');
    expect(sql).toContain('LIMIT 100');
    expect(sql).toContain("ESCAPE '\\'");
  });

  it('escapa aspas simples dos termos', () => {
    expect(sql).toContain("'O''BRIEN'");
  });

  it('mede o total SEM o teto (para saber quando o LIMIT 100 cortou o candidato certo)', () => {
    expect(sql).toContain('n_total');
  });

  it('termina no marcador de fim', () => {
    expect(sql.trim().endsWith(`SELECT '${MARCADOR_FIM}';`)).toBe(true);
  });

  it('lista vazia de specs ⇒ LANÇA (VALUES vazio é erro de SQL, não "zero candidatos")', () => {
    expect(() => sqlCandidatos([])).toThrow(/vazia/);
  });
});

describe('nomeConfere — o seed (nota) bate com o nome real da categoria da empresa?', () => {
  it('compartilha palavra significativa ⇒ confere', () => {
    expect(nomeConfere('Aluguel e condomínio', 'ALUGUEL')).toBe(true);
    expect(nomeConfere('Tarifas bancárias', 'Tarifa bancaria')).toBe(true);
  });
  it('sem palavra em comum ⇒ não confere (o código do seed caiu em outra categoria)', () => {
    expect(nomeConfere('PIS', 'Material de escritório')).toBe(false);
  });
});
