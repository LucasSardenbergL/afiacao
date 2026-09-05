import { describe, expect, it } from 'vitest';

import {
  cobreOPiso,
  coberturaPct,
  julgar,
  lerPiso,
  parsearObservacoes,
  PISO_COBERTURA_PADRAO,
  SEM_MAPA,
} from './lib/pendencias-deploy';
import { SQL } from './pendencias-deploy';

const MAPA = { 'edge-a': 'aaa111', 'edge-b': 'bbb222' };
const obs2 = (edge: string, fonte: string) => ({
  edge,
  fonte,
  criado: '2026-08-27 21:00:00+00',
  versao: 'v1',
});
const obs = (edge: string, fonte: string, criado = '2026-08-27 21:00:00+00', versao = 'v1') => ({
  edge,
  fonte,
  criado,
  versao,
});

describe('parsearObservacoes', () => {
  it('o SET do wrapper NÃO conta como ruído — senão o aviso dispararia em toda execução', () => {
    const { observacoes, linhasIgnoradas } = parsearObservacoes(
      'SET\nSET\nedge-a|v1|aaa111|2026-08-27 21:00:00+00\n',
    );
    expect(observacoes).toEqual([obs('edge-a', 'aaa111')]);
    expect(linhasIgnoradas).toBe(0);
  });

  it('mas ruído DE VERDADE continua contado — o filtro é do chatter conhecido, não de tudo', () => {
    const { observacoes, linhasIgnoradas } = parsearObservacoes(
      'SET\nERROR: alguma coisa\nedge-a|v1|aaa111|hoje\n',
    );
    expect(observacoes).toHaveLength(1);
    expect(linhasIgnoradas).toBe(1);
  });

  it('CONTA a linha malformada — engolir ruído fabricaria NAO_OBSERVADA numa edge que respondeu', () => {
    const { observacoes, linhasIgnoradas } = parsearObservacoes('edge-a|v1|\nedge-b|v1|bbb222|hoje\n');
    expect(observacoes.map((o) => o.edge)).toEqual(['edge-b']);
    expect(linhasIgnoradas).toBe(1);
  });
});

describe('julgar', () => {
  it('CONFERE só quando o fonte observado é igual ao commitado', () => {
    const r = julgar(MAPA, [obs('edge-a', 'aaa111'), obs('edge-b', 'bbb222')]);
    expect(r.vereditos.every((v) => v.estado === 'CONFERE')).toBe(true);
    expect(r.totalDivergentes).toBe(0);
  });

  it('ARMADILHA 1 — edge sem sonda na janela é NAO_OBSERVADA, JAMAIS CONFERE', () => {
    const r = julgar(MAPA, [obs('edge-a', 'aaa111')]);
    const b = r.vereditos.find((v) => v.edge === 'edge-b');
    expect(b?.estado).toBe('NAO_OBSERVADA');
    expect(b?.estado).not.toBe('CONFERE');
    // e ela NÃO conta como observada — senão a cobertura mentiria
    expect(r.totalObservadas).toBe(1);
  });

  it('ARMADILHA 2 — fonte "nao-mapeada" é DIVERGÊNCIA, não ausência', () => {
    const r = julgar(MAPA, [obs('edge-a', SEM_MAPA), obs('edge-b', 'bbb222')]);
    expect(r.vereditos.find((v) => v.edge === 'edge-a')?.estado).toBe('SEM_MAPA_NO_BUNDLE');
    expect(r.totalDivergentes).toBe(1);
  });

  it('ARMADILHA 3 — zero observações não vira relatório limpo', () => {
    const r = julgar(MAPA, []);
    expect(r.totalObservadas).toBe(0);
    expect(r.totalDivergentes).toBe(0); // e é JUSTAMENTE por isso que o CLI trata 0 observações
    expect(r.vereditos.every((v) => v.estado === 'NAO_OBSERVADA')).toBe(true); // como exit 2
  });

  it('fonte diferente do commitado é DEPLOY PENDENTE, com os dois lados no veredito', () => {
    const r = julgar(MAPA, [obs('edge-a', 'ANTIGO0'), obs('edge-b', 'bbb222')]);
    const a = r.vereditos.find((v) => v.edge === 'edge-a');
    expect(a?.estado).toBe('DIVERGE');
    expect(a?.esperado).toBe('aaa111');
    expect(a?.observado).toBe('ANTIGO0');
  });

  it('a observação MAIS RECENTE vence quando a janela tem várias da mesma edge', () => {
    const r = julgar(MAPA, [
      obs('edge-a', 'ANTIGO0', '2026-08-27 10:00:00+00'),
      obs('edge-a', 'aaa111', '2026-08-27 21:00:00+00'),
      obs('edge-b', 'bbb222'),
    ]);
    expect(r.vereditos.find((v) => v.edge === 'edge-a')?.estado).toBe('CONFERE');
  });

  it('edge que prod serve e a main não mapeia aparece, em vez de sumir do relatório', () => {
    const r = julgar(MAPA, [obs('edge-a', 'aaa111'), obs('edge-b', 'bbb222'), obs('fantasma', 'xxx')]);
    expect(r.vereditos.find((v) => v.edge === 'fantasma')?.estado).toBe('FORA_DO_MAPA');
    expect(r.totalDivergentes).toBe(1);
  });
});

describe('piso de cobertura', () => {
  const rel = (obs: number, mapeadas: number) =>
    julgar(
      Object.fromEntries(Array.from({ length: mapeadas }, (_, i) => [`e${i}`, `f${i}`])),
      Array.from({ length: obs }, (_, i) => obs2(`e${i}`, `f${i}`)),
    );

  it('cobertura é observadas/mapeadas em %', () => {
    expect(coberturaPct(rel(2, 39))).toBeCloseTo(5.13, 1);
    expect(coberturaPct(rel(39, 39))).toBe(100);
  });

  it('mapa vazio devolve 0, NÃO 100 por vacuidade', () => {
    expect(coberturaPct(julgar({}, []))).toBe(0);
  });

  it('O CASO REAL: 2/39 não cobre o piso padrão — era isto que saía exit 0 calado', () => {
    expect(cobreOPiso(rel(2, 39), PISO_COBERTURA_PADRAO)).toBe(false);
  });

  it('cobertura exatamente no piso PASSA (comparação é >=)', () => {
    expect(cobreOPiso(rel(5, 10), 50)).toBe(true);
  });

  it('piso 0 desliga a regra — válvula para o comportamento antigo', () => {
    expect(cobreOPiso(rel(1, 39), 0)).toBe(true);
  });

  it('lerPiso: ausente/vazio cai no padrão', () => {
    expect(lerPiso(undefined)).toBe(PISO_COBERTURA_PADRAO);
    expect(lerPiso('  ')).toBe(PISO_COBERTURA_PADRAO);
  });

  it('lerPiso: número válido vence o padrão', () => {
    expect(lerPiso('90')).toBe(90);
    expect(lerPiso('0')).toBe(0);
  });

  it('lerPiso: LANÇA no inválido em vez de cair no padrão calado', () => {
    for (const mau of ['cinquenta', '-1', '101', 'NaN']) {
      expect(() => lerPiso(mau), `deveria lançar em ${mau}`).toThrow(
        /PENDENCIAS_COBERTURA_MINIMA inválido/,
      );
    }
  });
});

/**
 * O SQL como TEXTO — o único gate desta correção que roda no CI.
 *
 * A prova de verdade é `db/test-pendencias-deploy-eco-passivo.sh`, que EXECUTA a query num PG17
 * com fixtures e falsifica. Mas `db/test-*.sh` precisa de Postgres local e não roda no CI, então
 * sozinha ela não impede alguém de reintroduzir o filtro `probe:true` num refactor. Estas
 * asserções são o cão de guarda barato: leem a query como texto e casam a MARCA de cada ramo.
 * Não substituem a execução — ninguém prova filtro lendo string —, só tornam a regressão ruidosa.
 */
describe('SQL da varredura — as duas vias', () => {
  const semEspacos = SQL.replace(/\s+/g, ' ');

  it('aceita o ECO PASSIVO: `probe` AUSENTE com edge+versao ainda conta', () => {
    expect(semEspacos).toContain("NOT (r.c ? 'probe')");
  });

  it('não regrediu a SONDA ATIVA', () => {
    expect(semEspacos).toContain("(r.c ->> 'probe') = 'true'");
  });

  it('NÃO exige mais `probe` no filtro textual — era ele que cegava o eco passivo', () => {
    expect(semEspacos).not.toContain('LIKE \'%"probe"%\'');
  });

  it('a chave ausente NÃO é testada por `<> true` (NULL-blind reintroduziria o bug)', () => {
    expect(semEspacos).not.toContain("(r.c ->> 'probe') <> 'true'");
  });

  it('o guard textual antes do cast continua, e mais estrito', () => {
    expect(semEspacos).toContain("left(ltrim(content), 1) = '{'");
    expect(semEspacos).toContain('content IS JSON OBJECT');
    expect(semEspacos).toContain('LIKE \'%"edge"%\'');
    expect(semEspacos).toContain('LIKE \'%"versao"%\'');
  });

  it('o veredito segue julgando o FONTE: sem o coalesce, eco sem fingerprint sumiria', () => {
    expect(semEspacos).toContain("coalesce(r.c ->> 'fonte', 'sem-campo')");
  });
});

describe('julgar — o eco passivo chega inteiro na lib', () => {
  it('O CASO REAL: analytics-outbox-drain respondeu sem `probe` e é CONFERE, não NAO_OBSERVADA', () => {
    // `fonte` batendo com o mapa: era isto que prod devolvia 72x/janela enquanto o relatório
    // dizia "⚪ sem sonda na janela (ausência de dado)".
    const rel = julgar({ 'analytics-outbox-drain': 'b03bbf88' }, [
      obs('analytics-outbox-drain', 'b03bbf88', '2026-09-04 10:05:00+00', 'v1.1-guard'),
    ]);
    expect(rel.vereditos[0].estado).toBe('CONFERE');
    expect(rel.totalObservadas).toBe(1);
  });

  it('eco SEM fonte vira `sem-campo` → DIVERGE, e ainda assim CONTA como observada', () => {
    const rel = julgar({ 'edge-a': 'aaa111' }, [obs('edge-a', 'sem-campo')]);
    expect(rel.vereditos[0].estado).toBe('DIVERGE');
    expect(rel.totalObservadas).toBe(1);
    expect(rel.totalDivergentes).toBe(1);
  });
});
