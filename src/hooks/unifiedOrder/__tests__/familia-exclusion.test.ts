import { describe, it, expect } from 'vitest';
import {
  buildFamiliaExclusionOrFilter,
  buildExclusionQuery,
  EXCLUDED_FAMILIA_PATTERNS,
} from '../types';

/**
 * Footgun corrigido aqui (CLAUDE.md §10): a exclusão de família usava
 * `.not('familia','ilike',p)` encadeado, que vira `familia NOT ILIKE p` no
 * PostgREST. Com `familia IS NULL`, isso avalia para NULL → a linha é descartada
 * → todo produto sem família era silenciosamente excluído do catálogo de venda.
 * O filtro novo tolera NULL: `familia IS NULL OR (NOT ILIKE p1 AND ...)`.
 */
describe('buildFamiliaExclusionOrFilter', () => {
  it('inclui família NULL no predicado (familia.is.null como primeira cláusula do OR)', () => {
    // Sem o `familia.is.null` na frente, produto sem família volta a sumir — é o bug.
    expect(buildFamiliaExclusionOrFilter(['%imobilizado%'])).toBe(
      'familia.is.null,and(familia.not.ilike.%imobilizado%)',
    );
  });

  it('mantém a exclusão dos patterns como AND de not.ilike', () => {
    expect(buildFamiliaExclusionOrFilter(['%imobilizado%', 'jumbo%'])).toBe(
      'familia.is.null,and(familia.not.ilike.%imobilizado%,familia.not.ilike.jumbo%)',
    );
  });

  it('preserva % e espaços dos patterns (NÃO sanitiza os wildcards intencionais)', () => {
    // sanitizeForPostgrestOr removeria o %; aqui os patterns são constantes
    // confiáveis e o % é o que faz o ILIKE parcial funcionar.
    expect(buildFamiliaExclusionOrFilter(['%uso e consumo%'])).toContain(
      'familia.not.ilike.%uso e consumo%',
    );
  });

  it('lança se um pattern contém vírgula (quebraria o separador do .or())', () => {
    // Money-path: pattern mal-formado deve falhar alto, nunca virar query
    // silenciosamente errada (a vírgula seria lida como separador de cláusula).
    expect(() => buildFamiliaExclusionOrFilter(['%bombas, válvulas%'])).toThrow();
  });

  it('lança se um pattern contém parêntese ou aspas (quebraria o agrupamento do .or())', () => {
    expect(() => buildFamiliaExclusionOrFilter(['%a(b)%'])).toThrow();
    expect(() => buildFamiliaExclusionOrFilter(['%a"b%'])).toThrow();
  });

  it('lança se a lista de patterns for vazia (and() vazio é inválido no PostgREST)', () => {
    // Invariante money-path: sem patterns, geraria `familia.is.null,and()` →
    // 400 do parser → catálogo vira [] silencioso. Falha alto em vez disso.
    expect(() => buildFamiliaExclusionOrFilter([])).toThrow();
  });
});

describe('buildExclusionQuery', () => {
  it('aplica um único .or() tolerante a NULL com os patterns reais', () => {
    const calls: string[] = [];
    const fakeQuery = {
      or(filter: string) {
        calls.push(filter);
        return fakeQuery;
      },
    };

    const result = buildExclusionQuery(fakeQuery);

    expect(result).toBe(fakeQuery); // encadeável
    expect(calls).toHaveLength(1); // um .or(), não N .not()
    expect(calls[0]).toContain('familia.is.null');
    // primeiro pattern real continua excluído
    expect(calls[0]).toContain(`familia.not.ilike.${EXCLUDED_FAMILIA_PATTERNS[0]}`);
  });
});
