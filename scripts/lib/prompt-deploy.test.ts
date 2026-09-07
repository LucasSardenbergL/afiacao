import { describe, expect, it } from 'vitest';

import type { Estado, Veredito } from './pendencias-deploy';
import {
  conferirCobertura,
  type EdgeParaDeploy,
  ESTADOS_DE_DEPLOY,
  montarPrompt,
  numeral,
  selecionarParaDeploy,
} from './prompt-deploy';

const MAPA = 'supabase/functions/_shared/sonda-fingerprints.ts';

function veredito(edge: string, estado: Estado): Veredito {
  return {
    edge,
    estado,
    esperado: 'abc123',
    observado: estado === 'NUNCA_ATESTADA' ? null : 'def456',
    versaoEsperada: 'v2',
    versao: 'v1',
    via: 'sonda',
    criado: '2026-09-07 12:00:00+00',
    idadeHoras: 3,
    diasPendente: 1,
    escalada: false,
  };
}

/** Fatia bem-formada: o index, um `_shared` importado, o marcador de versão e o MAPA. */
function fatia(edge: string): EdgeParaDeploy {
  return {
    edge,
    arquivos: [
      `supabase/functions/${edge}/index.ts`,
      `supabase/functions/${edge}/versao.ts`,
      'supabase/functions/_shared/sonda-versao.ts',
      MAPA,
    ],
  };
}

describe('ESTADOS_DE_DEPLOY — o conjunto é a decisão de produto, não detalhe', () => {
  it('é EXATAMENTE a divergência medida: nem mais, nem menos', () => {
    // Fixado de propósito. Acrescentar `NUNCA_ATESTADA` aqui faria o gerador pedir deploy de edge
    // cujo estado ANTES é desconhecido — ausência de dado virando ordem de deploy, que é o gasto
    // redundante que o ledger existe para evitar. Quem mudar este conjunto quebra este teste e
    // tem de justificar no PR.
    expect([...ESTADOS_DE_DEPLOY].sort()).toEqual([
      'DIVERGE_P1',
      'DIVERGE_P2',
      'INCOERENTE',
      'SEM_MAPA_NO_BUNDLE',
    ]);
  });
});

describe('selecionarParaDeploy', () => {
  it('pega os quatro estados de divergência medida', () => {
    const vs = [
      veredito('a', 'DIVERGE_P1'),
      veredito('b', 'DIVERGE_P2'),
      veredito('c', 'INCOERENTE'),
      veredito('d', 'SEM_MAPA_NO_BUNDLE'),
    ];
    expect(selecionarParaDeploy(vs)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('NÃO pede deploy de NUNCA_ATESTADA nem de SEM_FONTE_NO_ECO — é ausência de dado, pede SONDA', () => {
    const vs = [veredito('nunca', 'NUNCA_ATESTADA'), veredito('sem-fonte', 'SEM_FONTE_NO_ECO')];
    expect(selecionarParaDeploy(vs)).toEqual([]);
  });

  it('não pede deploy de CONFERE nem de FORA_DO_MAPA', () => {
    const vs = [veredito('ok', 'CONFERE'), veredito('orfa', 'FORA_DO_MAPA')];
    expect(selecionarParaDeploy(vs)).toEqual([]);
  });

  it('ordena por nome — dois runs sobre o mesmo ledger dão o MESMO prompt', () => {
    const vs = [
      veredito('zulu', 'DIVERGE_P1'),
      veredito('alfa', 'DIVERGE_P1'),
      veredito('mike', 'DIVERGE_P1'),
    ];
    expect(selecionarParaDeploy(vs)).toEqual(['alfa', 'mike', 'zulu']);
  });
});

describe('montarPrompt — 1 edge', () => {
  const prompt = montarPrompt([fatia('minha-edge')]);

  it('nomeia TODOS os arquivos da fatia, não só o index', () => {
    expect(conferirCobertura(prompt, [fatia('minha-edge')])).toEqual({ ok: true, faltando: [] });
  });

  it('carrega as travas que impedem o Lovable de "melhorar" o código', () => {
    expect(prompt).toContain('**verbatim**');
    expect(prompt).toContain('do NOT modify');
    expect(prompt).toContain('**Active**');
  });
});

describe('montarPrompt — leva', () => {
  const edges = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(fatia);
  const prompt = montarPrompt(edges);

  it('declara o total por extenso e proíbe pular', () => {
    expect(prompt).toContain('**eight**');
    expect(prompt).toContain('Deploy every function listed; do not');
    expect(prompt).toContain('skip any');
  });

  it('numera uma seção por edge, de 1 a N', () => {
    expect(prompt).toContain('**1. `a`**');
    expect(prompt).toContain('**8. `h`**');
  });

  it('fecha pedindo confirmação item a item', () => {
    expect(prompt).toContain('confirm that **each one** shows **Active**');
  });

  it('cobre as 8 fatias inteiras', () => {
    expect(conferirCobertura(prompt, edges).ok).toBe(true);
  });
});

describe('conferirCobertura — o check que segura o modo de falha', () => {
  it('FALSIFICAÇÃO: prompt montado SEM o mapa fica VERMELHO contra a fatia com o mapa', () => {
    // Isto é exatamente o bug de docs/historico/closure-de-hash-nao-e-lista-de-deploy.md:
    // derivar a fatia da `fecharGrafo()` (que exclui o mapa de propósito) e não somar o mapa.
    // O bundle BOOTA e serve FONTE_SHA256 velho — a sonda nasce cega. Se esta asserção ficar
    // verde, o check é decorativo e o gerador não segura nada.
    const semMapa: EdgeParaDeploy = {
      edge: 'minha-edge',
      arquivos: fatia('minha-edge').arquivos.filter((a) => a !== MAPA),
    };
    const promptCego = montarPrompt([semMapa]);

    const r = conferirCobertura(promptCego, [fatia('minha-edge')]);
    expect(r.ok).toBe(false);
    expect(r.faltando).toEqual([`minha-edge:${MAPA}`]);
  });

  it('CONTROLE: a MESMA fatia, com o mapa, fica verde — senão o vermelho acima não prova nada', () => {
    const completa = fatia('minha-edge');
    expect(conferirCobertura(montarPrompt([completa]), [completa]).ok).toBe(true);
  });

  it('não se deixa enganar por substring — `sonda-versao.ts` ⊄ `sonda-versao_test.ts`', () => {
    const pedido: EdgeParaDeploy = {
      edge: 'x',
      arquivos: ['supabase/functions/_shared/sonda-versao.ts'],
    };
    const promptErrado: EdgeParaDeploy = {
      edge: 'x',
      arquivos: ['supabase/functions/_shared/sonda-versao_test.ts'],
    };
    expect(conferirCobertura(montarPrompt([promptErrado]), [pedido]).ok).toBe(false);
  });

  it('acusa edge inteira ausente do prompt', () => {
    const prompt = montarPrompt([fatia('a')]);
    const r = conferirCobertura(prompt, [fatia('a'), fatia('esquecida')]);
    expect(r.ok).toBe(false);
    expect(r.faltando).toContain('edge:esquecida');
  });
});

describe('recusas', () => {
  it('leva vazia LANÇA — colagem que não deploya nada pareceria trabalho feito', () => {
    expect(() => montarPrompt([])).toThrow(/leva vazia/);
  });

  it('fatia vazia LANÇA — o closure nunca é vazio, então é falha de leitura', () => {
    expect(() => montarPrompt([{ edge: 'x', arquivos: [] }])).toThrow(/fatia vazia/);
  });
});

describe('numeral', () => {
  it('escreve por extenso até 12 e cai no dígito acima disso', () => {
    expect(numeral(1)).toBe('one');
    expect(numeral(8)).toBe('eight');
    expect(numeral(12)).toBe('twelve');
    expect(numeral(13)).toBe('13');
  });
});
