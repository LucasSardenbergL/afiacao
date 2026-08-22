import { describe, it, expect } from 'vitest';
import { estadoDeLeitura, naoConsegui, type EstadoLeitura, type FatiaDeQuery } from '../leitura/estado-de-leitura';

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
