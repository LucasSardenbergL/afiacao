import { describe, it, expect, vi, beforeEach } from 'vitest';

const trackMock = vi.fn((..._a: unknown[]) => undefined);
const ledgerMock = vi.fn((..._a: unknown[]) => Promise.resolve());
let lente = false;
vi.mock('@/lib/analytics', () => ({ track: (...a: unknown[]) => trackMock(...a) }));
vi.mock('@/lib/analytics-ledger', () => ({ registrarNoLedger: (...a: unknown[]) => ledgerMock(...a) }));
vi.mock('@/lib/impersonation/lens-write-guard', () => ({ isLensActive: () => lente }));

import {
  modoClientes, montarEventoClientes, normalizarFiltroSensor, registrarUsoClientes, type UsoClientes,
} from '../sensor-clientes';

/** Um uso de cada ação — a suíte anti-PII roda sobre TODOS. */
const USOS: UsoClientes[] = [
  { acao: 'lista_aberta', modo: 'prioridade' },
  { acao: 'modo_trocado', de: 'prioridade', para: 'nome', origem: 'menu' },
  { acao: 'filtro_saude', modo: 'nome', valor: 'critico' },
  { acao: 'busca_usada', modo: 'carteira_prioridade' },
  { acao: 'cliente_aberto', modo: 'prioridade', posicao: 3, filtroSaude: 'atencao', comBusca: true },
  { acao: 'pagina_carregada', modo: 'nome', pagina: 2 },
  { acao: 'modo_trocado', de: 'carteira_prioridade', para: 'carteira_nome', origem: 'cabecalho' },
  { acao: 'ficha_acao', ficha: 'cadastro', tipo: 'novo_pedido' },
  { acao: 'ficha_acao', ficha: '360', tipo: 'ligar' },
];

// ALLOWLIST de chaves do payload: campo novo (id, nome, termo…) tem de entrar aqui de propósito, com revisão de LGPD.
const CHAVES_PERMITIDAS = new Set(['modo', 'de', 'para', 'origem', 'valor', 'posicao', 'filtro_saude', 'com_busca', 'pagina', 'ficha', 'tipo']);
const VALOR_PERMITIDO = /^(prioridade|nome|carteira_prioridade|carteira_nome|cadastro|360|ligar|novo_pedido|abrir_360|ver_pedidos|menu|cabecalho|all|saudavel|estavel|atencao|critico|sem_historico|outro)$/;

beforeEach(() => {
  trackMock.mockClear();
  ledgerMock.mockClear();
  lente = false;
});

describe('sensorClientes — payload sem PII', () => {
  it.each(USOS.map((u) => [u.acao, u] as const))('%s: props só enums, inteiros, booleanos ou null', (_acao, uso) => {
    const { evento, chave, props } = montarEventoClientes(uso);
    expect(evento).toMatch(/^clientes\.[a-z_]+$/);
    expect(chave.length).toBeLessThanOrEqual(100);
    for (const [k, v] of Object.entries(props)) {
      expect(CHAVES_PERMITIDAS.has(k), `chave de payload fora da allowlist: ${k}`).toBe(true);
      if (typeof v === 'string') expect(v, `${k}=${v}`).toMatch(VALOR_PERMITIDO);
      else expect(v === null || typeof v === 'boolean' || Number.isInteger(v), `${k}=${String(v)}`).toBe(true);
    }
  });

  it('texto livre no filtro (URL editada à mão) vira "outro" — nem no payload nem na chave', () => {
    const lixo = 'joao@exemplo.com 12.345.678/0001-99';
    const f = montarEventoClientes({ acao: 'filtro_saude', modo: 'nome', valor: lixo });
    expect(f.props.valor).toBe('outro');
    expect(f.chave).toBe('nome:outro');
    const c = montarEventoClientes({ acao: 'cliente_aberto', modo: 'nome', posicao: 1, filtroSaude: lixo, comBusca: false });
    expect(JSON.stringify(c)).not.toContain('joao');
    expect(JSON.stringify(c)).not.toContain('12.345');
    expect(c.props.filtro_saude).toBe('outro');
  });

  it('normalizarFiltroSensor: enum conhecido passa, ausente = all, resto = outro', () => {
    expect(normalizarFiltroSensor('sem_historico')).toBe('sem_historico');
    expect(normalizarFiltroSensor(undefined)).toBe('all');
    expect(normalizarFiltroSensor(null)).toBe('all');
    expect(normalizarFiltroSensor('Critico')).toBe('outro');
  });

  it('posição/página inválidas viram null (nunca 0 fabricado) e marcam a chave com x', () => {
    for (const ruim of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = montarEventoClientes({ acao: 'cliente_aberto', modo: 'nome', posicao: ruim, filtroSaude: 'all', comBusca: false });
      expect(c.props.posicao, String(ruim)).toBeNull();
      expect(c.chave).toBe('nome:all:s:x');
      const p = montarEventoClientes({ acao: 'pagina_carregada', modo: 'nome', pagina: ruim });
      expect(p.props.pagina, String(ruim)).toBeNull();
    }
  });
});

describe('sensorClientes — chaves de dedup (1 linha por titular × chave × dia)', () => {
  it('cada ação tem a chave que responde "com qual valor"', () => {
    expect(USOS.map((u) => montarEventoClientes(u).chave)).toEqual([
      'prioridade',
      'prioridade>nome',
      'nome:critico',
      'carteira_prioridade',
      'prioridade:atencao:b:3',
      'nome:2',
      'carteira_prioridade>carteira_nome',
      'cadastro:novo_pedido',
      '360:ligar',
    ]);
  });

  it('cliente_aberto: mesma posição com e sem busca são linhas distintas', () => {
    const base = { acao: 'cliente_aberto', modo: 'prioridade', posicao: 1, filtroSaude: 'all' } as const;
    expect(montarEventoClientes({ ...base, comBusca: true }).chave)
      .not.toBe(montarEventoClientes({ ...base, comBusca: false }).chave);
  });
});

describe('modoClientes — carteira e base separadas no sinal', () => {
  it('a carteira grava a ordem que a vendedora VÊ', () => {
    expect(modoClientes(true, 'prioridade')).toBe('carteira_prioridade');
    expect(modoClientes(true, 'nome')).toBe('carteira_nome');
    expect(modoClientes(false, 'prioridade')).toBe('prioridade');
    expect(modoClientes(false, 'nome')).toBe('nome');
  });

  it('ficha_acao: evento próprio, sem id do cliente', () => {
    const e = montarEventoClientes({ acao: 'ficha_acao', ficha: 'cadastro', tipo: 'abrir_360' });
    expect(e).toEqual({ evento: 'clientes.ficha_acao', chave: 'cadastro:abrir_360', props: { ficha: 'cadastro', tipo: 'abrir_360' } });
  });
});

describe('registrarUsoClientes — os dois canais', () => {
  it('manda o MESMO evento e props ao PostHog e ao ledger', () => {
    registrarUsoClientes({ acao: 'cliente_aberto', modo: 'nome', posicao: 7, filtroSaude: 'critico', comBusca: false });
    const esperado = { modo: 'nome', posicao: 7, filtro_saude: 'critico', com_busca: false };
    expect(trackMock).toHaveBeenCalledWith('clientes.cliente_aberto', esperado);
    expect(ledgerMock).toHaveBeenCalledWith('clientes.cliente_aberto', 'nome:critico:s:7', esperado);
  });

  it('sob a lente "Ver como" não registra em NENHUM canal', () => {
    lente = true;
    registrarUsoClientes({ acao: 'lista_aberta', modo: 'prioridade' });
    expect(trackMock).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});
