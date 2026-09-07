import { describe, it, expect } from 'vitest';
import {
  estadoDeLeitura,
  naoConsegui,
  desatualizado,
  estadoDeRegistro,
  ehNaoEncontrado,
  PGRST_NENHUMA_LINHA,
  type EstadoLeitura,
  type FatiaDeQuery,
} from '../leitura/estado-de-leitura';

/**
 * O mapeamento (status × fetchStatus) → estado é EXAUSTIVO de propósito: estado sem nome
 * é estado que colapsa no vizinho, e o colapso é a classe inteira
 * (docs/historico/fase-sem-sinal.md). Por isso o teste enumera as 9 combinações em vez de
 * amostrar as "interessantes" — a que ninguém achava interessante era justamente o
 * offline (`pending` + `paused`), medido no #1874.
 */
const STATUS = ['pending', 'error', 'success'] as const;
const FETCH = ['fetching', 'paused', 'idle'] as const;

const ESPERADO: Record<string, EstadoLeitura> = {
  'pending/fetching': 'carregando',
  'pending/paused': 'sem-rede',
  'pending/idle': 'desabilitada',
  'error/fetching': 'erro',
  'error/paused': 'erro',
  'error/idle': 'erro',
  'success/fetching': 'pronta',
  'success/paused': 'pronta',
  'success/idle': 'pronta',
};

describe('estadoDeLeitura — as 9 combinações têm nome próprio', () => {
  for (const status of STATUS) {
    for (const fetchStatus of FETCH) {
      const chave = `${status}/${fetchStatus}`;
      it(`${chave} → ${ESPERADO[chave]}`, () => {
        expect(estadoDeLeitura({ status, fetchStatus } as FatiaDeQuery)).toBe(ESPERADO[chave]);
      });
    }
  }

  it('cobre TODAS as combinações — a tabela não pode encolher sem alguém notar', () => {
    expect(Object.keys(ESPERADO)).toHaveLength(STATUS.length * FETCH.length);
  });
});

describe('naoConsegui — a fronteira entre "não há" e "não sei"', () => {
  it('erro e sem-rede são os estados em que a tela NÃO pode afirmar vazio', () => {
    expect(naoConsegui('erro')).toBe(true);
    expect(naoConsegui('sem-rede')).toBe(true);
  });

  it('o offline NÃO é distinguível do vazio por isLoading/error — é por isso que ele entra', () => {
    // Reprodução da armadilha: em `pending` + `paused` o react-query v5 dá
    // isLoading=false (= isPending && isFetching), data=undefined e error=null. Quem
    // testa só `isLoading || !data` cai no ramo do vazio e afirma "não há".
    const offline: FatiaDeQuery = { status: 'pending', fetchStatus: 'paused' };
    const isLoading = offline.status === 'pending' && offline.fetchStatus === 'fetching';
    expect(isLoading).toBe(false);
    expect(naoConsegui(estadoDeLeitura(offline))).toBe(true);
  });

  it('carregando e desabilitada ficam de FORA — aviso ali seria alarme fabricado', () => {
    expect(naoConsegui('carregando')).toBe(false);
    expect(naoConsegui('desabilitada')).toBe(false);
    expect(naoConsegui('pronta')).toBe(false);
  });
});

describe('desatualizado — dado em mãos + leitura falha = mostre os DOIS', () => {
  it('sem dado NÃO há o que avisar aqui (o caso é naoConsegui + aviso sozinho)', () => {
    expect(desatualizado({ status: 'error', fetchStatus: 'idle' }, false)).toBeNull();
    expect(desatualizado({ status: 'pending', fetchStatus: 'paused' }, false)).toBeNull();
  });

  it('com dado: refetch que falha vira aviso de desatualizado, e o conteúdo fica', () => {
    expect(desatualizado({ status: 'error', fetchStatus: 'idle' }, true)).toBe('erro');
    expect(desatualizado({ status: 'pending', fetchStatus: 'paused' }, true)).toBe('sem-rede');
  });

  it('sem-rede tem PRECEDÊNCIA sobre erro quando os dois se sobrepõem', () => {
    // Só COM dado em cache eles coexistem: o `fetchState` do query-core zera `error` ao
    // iniciar um fetch apenas quando `data === undefined`. E o motivo acionável é o atual —
    // recarregar não resolve falta de sinal.
    expect(desatualizado({ status: 'error', fetchStatus: 'paused' }, true)).toBe('sem-rede');
  });

  it('leitura boa não inventa aviso', () => {
    expect(desatualizado({ status: 'success', fetchStatus: 'idle' }, true)).toBeNull();
    expect(desatualizado({ status: 'success', fetchStatus: 'fetching' }, true)).toBeNull();
  });
});

/**
 * ── LEITURA DE UM REGISTRO POR ID — os dois terminadores, dois mecanismos ─────────────
 *
 * `estadoDeLeitura` responde "a leitura aconteceu?". Não responde "esta linha existe?",
 * e é essa segunda pergunta que as telas de detalhe respondem ERRADO: `if (!registro)`
 * → "não encontrado" cobre também "o banco caiu" (achado 3 de
 * docs/historico/o-check-verde-que-a-falha-acende.md).
 *
 * O eixo que separa as duas NÃO é o mesmo nos dois terminadores do PostgREST, e é por isso
 * que um fix só não serve aos dois:
 *
 *   `.maybeSingle()` → a distinção EXISTE no dado: sucesso com `data === null` é
 *                      "não existe"; `undefined` só sai de loading ou erro. O componente
 *                      que escreve `if (!x)` DESCARTA o que o hook preservou.
 *   `.single()`      → a distinção NÃO existe sem ler o erro: 0 linhas LANÇA PGRST116,
 *                      e chega ao componente idêntico a uma queda de rede.
 *
 * Os dois casos abaixo são enumerados separados de propósito: uma implementação que
 * cubra só o `data === null` passa no primeiro bloco e reprova no segundo.
 */
describe('ehNaoEncontrado — só o código do PostgREST para "0 linhas" conta', () => {
  it('PGRST116 (o `.single()` que não achou a linha) é não-encontrado', () => {
    expect(ehNaoEncontrado({ code: PGRST_NENHUMA_LINHA })).toBe(true);
    expect(PGRST_NENHUMA_LINHA).toBe('PGRST116');
  });

  it('outro erro do PostgREST NÃO é não-encontrado — inclusive os plausíveis', () => {
    // PGRST301 = JWT expirado; 42501 = permissão negada por RLS. Ambos são falha de
    // leitura com cara de "sumiu", e é exatamente aí que a tela mentiria.
    expect(ehNaoEncontrado({ code: 'PGRST301' })).toBe(false);
    expect(ehNaoEncontrado({ code: '42501' })).toBe(false);
  });

  it('erro de rede (Error sem `code`) NÃO é não-encontrado', () => {
    expect(ehNaoEncontrado(new Error('Failed to fetch'))).toBe(false);
  });

  it('ausência de erro não é não-encontrado', () => {
    expect(ehNaoEncontrado(null)).toBe(false);
    expect(ehNaoEncontrado(undefined)).toBe(false);
  });

  it('a string solta não passa por erro — o eixo é `error.code`, não o texto', () => {
    // Um `includes('PGRST116')` sobre a mensagem passaria aqui e casaria também a
    // mensagem de UM erro embrulhado por outro. O contrato é o campo.
    expect(ehNaoEncontrado('PGRST116')).toBe(false);
    expect(ehNaoEncontrado(new Error('PGRST116: no rows'))).toBe(false);
  });
});

describe('estadoDeRegistro — `.maybeSingle()`: a distinção vem do DADO', () => {
  const ok = { status: 'success', fetchStatus: 'idle' } as const;

  it('respondeu e veio linha → pronta', () => {
    expect(estadoDeRegistro({ ...ok, error: null }, true)).toBe('pronta');
  });

  it('respondeu e veio null → inexistente (o hook sabia; o componente jogava fora)', () => {
    expect(estadoDeRegistro({ ...ok, error: null }, false)).toBe('inexistente');
  });

  it('LANÇOU sem registro → erro, NUNCA inexistente', () => {
    expect(estadoDeRegistro({ status: 'error', fetchStatus: 'idle', error: new Error('boom') }, false)).toBe('erro');
  });
});

describe('estadoDeRegistro — `.single()`: a distinção vem do CÓDIGO DO ERRO', () => {
  it('PGRST116 → inexistente (0 linhas, não falha)', () => {
    expect(
      estadoDeRegistro({ status: 'error', fetchStatus: 'idle', error: { code: PGRST_NENHUMA_LINHA } }, false),
    ).toBe('inexistente');
  });

  it('qualquer outro erro → erro, mesmo sem registro em mãos', () => {
    expect(
      estadoDeRegistro({ status: 'error', fetchStatus: 'idle', error: { code: 'PGRST301' } }, false),
    ).toBe('erro');
  });
});

describe('estadoDeRegistro — o 4º estado (offline) NÃO pode virar "inexistente"', () => {
  it('pending + paused → sem-rede, mesmo sem registro em mãos', () => {
    // `networkMode:'online'` sem rede: `isLoading` é FALSE e `data` é `undefined`. Quem
    // ramifica só por `isLoading`/`error` cai no ramo do "não encontrado" — o offline é o
    // estado que engana quem "já trata erro" (#1874).
    expect(estadoDeRegistro({ status: 'pending', fetchStatus: 'paused', error: null }, false)).toBe('sem-rede');
  });

  it('pending + fetching → carregando · pending + idle → desabilitada', () => {
    expect(estadoDeRegistro({ status: 'pending', fetchStatus: 'fetching', error: null }, false)).toBe('carregando');
    expect(estadoDeRegistro({ status: 'pending', fetchStatus: 'idle', error: null }, false)).toBe('desabilitada');
  });

  it('nenhum estado de pendência consulta `temRegistro` — não há dado para consultar', () => {
    for (const fetchStatus of ['fetching', 'paused', 'idle'] as const) {
      const q = { status: 'pending', fetchStatus, error: null } as const;
      expect(estadoDeRegistro(q, false)).toBe(estadoDeRegistro(q, true));
    }
  });
});

describe('naoConsegui — "inexistente" é resposta, não falha', () => {
  it('não aciona o aviso de leitura falhada', () => {
    expect(naoConsegui('inexistente')).toBe(false);
  });

  it('erro e sem-rede continuam acionando', () => {
    expect(naoConsegui('erro')).toBe(true);
    expect(naoConsegui('sem-rede')).toBe(true);
  });
});
