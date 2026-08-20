/**
 * Testes do motor `edges-guardrails-afetados.ts`.
 *
 * NOTA DE AUTO-REFERÊNCIA: este arquivo não pode escrever por extenso o nome da API de leitura
 * síncrona do `node:fs` — por isso o `LEITURA` partido abaixo, e por isso esta nota não o soletra.
 * O motor classifica um `*.test.ts` como guardrail-de-forma quando ele cita `supabase/functions`
 * E lê o disco, e este arquivo cita edges o tempo todo (fixtures). O teste de integração usa
 * `carregarIndice()` justamente para não ler o disco por conta própria. Sem esse cuidado o motor
 * aponta a si mesmo e a lista do nudge nasce com um falso-positivo fixo — não é hipótese: a 1ª
 * versão desta nota soletrou o nome e o motor passou a se listar (o teste abaixo pega).
 */
import { describe, expect, it } from 'vitest';

import {
  alcanceCobre,
  carregarIndice,
  ehGuardrailDeForma,
  extrairAlcances,
  formatarNudge,
  guardrailsAfetados,
} from './edges-guardrails-afetados';

const LEITURA = 'readFile' + 'Sync'; // partido para não se auto-classificar (ver nota acima)

describe('extrairAlcances — o literal ENTRE ASPAS é o que conta', () => {
  it('pega literal em aspas simples, duplas e template', () => {
    const fonte = [
      "const A = 'supabase/functions/omie-cliente/index.ts';",
      'const B = "supabase/functions/omie-sync/index.ts";',
      'const C = `supabase/functions/_shared/paginate.ts`;',
    ].join('\n');
    expect(extrairAlcances(fonte).sort()).toEqual([
      'supabase/functions/_shared/paginate.ts',
      'supabase/functions/omie-cliente/index.ts',
      'supabase/functions/omie-sync/index.ts',
    ]);
  });

  it('pega a RAIZ quando o teste varre o diretório', () => {
    expect(extrairAlcances("const DIRS = ['src', 'supabase/functions', 'scripts'];")).toEqual([
      'supabase/functions',
    ]);
  });

  it('ignora menção em PROSA (comentário sem aspas) — citar não é ler', () => {
    expect(extrairAlcances('// vide supabase/functions/generate-tactical-plan → injetava no prompt')).toEqual([]);
  });

  it('deduplica o mesmo literal citado várias vezes', () => {
    const fonte = "a('supabase/functions/omie-sync/index.ts'); b('supabase/functions/omie-sync/index.ts');";
    expect(extrairAlcances(fonte)).toEqual(['supabase/functions/omie-sync/index.ts']);
  });

  it('normaliza o prefixo ./', () => {
    expect(extrairAlcances("resolve(R, './supabase/functions/omie-sync/index.ts')")).toEqual([
      'supabase/functions/omie-sync/index.ts',
    ]);
  });
});

describe('ehGuardrailDeForma — citar edge + LER o disco', () => {
  it('cita edge e lê o disco → é guardrail de forma', () => {
    expect(ehGuardrailDeForma(`const s = ${LEITURA}('supabase/functions/omie-sync/index.ts', 'utf8');`)).toBe(true);
  });

  it('cita edge mas não lê o disco → não é (teste de runtime, mock, doc)', () => {
    expect(ehGuardrailDeForma("vi.mock('supabase/functions/omie-sync/index.ts');")).toBe(false);
  });

  it('lê o disco mas não cita edge → não é (guardrail de src/, fora do escopo)', () => {
    expect(ehGuardrailDeForma(`const s = ${LEITURA}('src/lib/custo/motor.ts', 'utf8');`)).toBe(false);
  });
});

describe('alcanceCobre — prefixo por SEGMENTO, nunca por string', () => {
  it('a raiz cobre qualquer edge', () => {
    expect(alcanceCobre('supabase/functions', 'supabase/functions/omie-cliente/index.ts')).toBe(true);
  });

  it('o literal do arquivo cobre ele mesmo', () => {
    const f = 'supabase/functions/omie-cliente/index.ts';
    expect(alcanceCobre(f, f)).toBe(true);
  });

  it('o literal de um arquivo NÃO cobre um irmão', () => {
    expect(alcanceCobre('supabase/functions/omie-cliente/index.ts', 'supabase/functions/omie-sync/index.ts')).toBe(false);
  });

  it('FRONTEIRA DE SEGMENTO: `omie-sync` não cobre `omie-sync-pedidos-compra` (prefixo de string casaria)', () => {
    expect(alcanceCobre('supabase/functions/omie-sync', 'supabase/functions/omie-sync-pedidos-compra/index.ts')).toBe(false);
  });

  it('o literal de um DIRETÓRIO cobre os arquivos dentro dele', () => {
    expect(alcanceCobre('supabase/functions/omie-sync', 'supabase/functions/omie-sync/index.ts')).toBe(true);
  });

  it('caminho ABSOLUTO do worktree é normalizado para a raiz do repo', () => {
    expect(
      alcanceCobre('supabase/functions', '/Users/x/afiacao-wt/supabase/functions/omie-cliente/index.ts'),
    ).toBe(true);
  });
});

describe('guardrailsAfetados', () => {
  const indice = [
    { teste: 'src/__tests__/varredura.test.ts', alcances: ['supabase/functions'] },
    {
      teste: 'src/__tests__/especifico.test.ts',
      alcances: ['supabase/functions/omie-cliente/index.ts', 'supabase/functions/omie-sync/index.ts'],
    },
    { teste: 'src/__tests__/outro.test.ts', alcances: ['supabase/functions/carteira-rebuild/index.ts'] },
  ];

  it('devolve só os testes que leem o arquivo editado', () => {
    const r = guardrailsAfetados(indice, ['supabase/functions/omie-cliente/index.ts']);
    expect(r.map((g) => g.teste)).toEqual(['src/__tests__/especifico.test.ts', 'src/__tests__/varredura.test.ts']);
  });

  it('o ESPECÍFICO vem antes da varredura (mais informativo primeiro)', () => {
    const r = guardrailsAfetados(indice, ['supabase/functions/omie-cliente/index.ts']);
    expect(r[0].varredura).toBe(false);
    expect(r[0].alcance).toBe('supabase/functions/omie-cliente/index.ts');
    expect(r[1].varredura).toBe(true);
  });

  it('não duplica o teste que cita o mesmo arquivo por vários literais', () => {
    const r = guardrailsAfetados(indice, [
      'supabase/functions/omie-cliente/index.ts',
      'supabase/functions/omie-sync/index.ts',
    ]);
    expect(r.filter((g) => g.teste === 'src/__tests__/especifico.test.ts')).toHaveLength(1);
  });

  it('arquivo FORA de supabase/functions → lista vazia (o hook cala)', () => {
    expect(guardrailsAfetados(indice, ['src/pages/Home.tsx'])).toEqual([]);
  });
});

describe('formatarNudge', () => {
  it('entrega o comando pronto pra rodar SÓ os testes afetados', () => {
    const txt = formatarNudge(
      ['supabase/functions/omie-cliente/index.ts'],
      [{ teste: 'src/__tests__/a.test.ts', alcance: 'supabase/functions/omie-cliente/index.ts', varredura: false }],
    );
    expect(txt).toContain('src/__tests__/a.test.ts');
    expect(txt).toContain('bunx vitest run');
  });

  it('lista vazia → string vazia (nada a dizer, o hook não fala)', () => {
    expect(formatarNudge(['supabase/functions/x/index.ts'], [])).toBe('');
  });

  it('o número do RESUMO é o total, mesmo quando a lista trunca', () => {
    // A lista mostra 8 + uma linha "+N". Contar linhas mentiria: medido, 3 alvos reais dão 11
    // guardrails em 9 linhas. Quem lê o resumo (o `systemMessage` do hook) precisa do TOTAL.
    const muitos = Array.from({ length: 12 }, (_, i) => ({
      teste: `src/__tests__/g${i}.test.ts`,
      alcance: 'supabase/functions',
      varredura: true,
    }));
    const txt = formatarNudge(['supabase/functions/x/index.ts'], muitos);
    expect(txt.split('\n')[0]).toContain('12 teste(s)');
    expect(txt.split('\n').filter((l) => l.startsWith('  · '))).toHaveLength(9); // 8 + o "+4"
    expect(txt).toContain('+4');
    // e o comando roda TODOS os 12 — truncar a lista não pode truncar o que precisa rodar
    expect(txt.split('\n').at(-1)?.match(/\.test\.ts/g)).toHaveLength(12);
  });
});

describe('carregarIndice — o mapa REAL do repo (integração)', () => {
  const indice = carregarIndice();

  it('acha os guardrails de forma que existem hoje', () => {
    expect(indice.length).toBeGreaterThanOrEqual(15);
  });

  it('não se auto-inclui (este arquivo cita edges mas não lê o disco)', () => {
    expect(indice.map((g) => g.teste)).not.toContain('scripts/edges-guardrails-afetados.test.ts');
  });

  it('REGRESSÃO #1772: editar omie-cliente/index.ts acusa o edge-money-path-invariants', () => {
    const afetados = guardrailsAfetados(indice, ['supabase/functions/omie-cliente/index.ts']).map((g) => g.teste);
    expect(afetados).toContain('src/__tests__/edge-money-path-invariants.test.ts');
  });

  it('edge SEM literal próprio ainda cai nos gates que VARREM o diretório', () => {
    const afetados = guardrailsAfetados(indice, ['supabase/functions/_shared/inexistente-de-proposito.ts']);
    expect(afetados.length).toBeGreaterThan(0);
    expect(afetados.every((g) => g.varredura)).toBe(true);
  });
});
