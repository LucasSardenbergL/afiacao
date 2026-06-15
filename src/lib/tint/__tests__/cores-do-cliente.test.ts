import { describe, it, expect } from 'vitest';
import { extrairCoresDoHistorico, filtrarCores, normalizarBusca, termoBuscaCor } from '../cores-do-cliente';
import type { PedidoHistorico } from '../cores-do-cliente';

const pedido = (over: Partial<PedidoHistorico> = {}): PedidoHistorico => ({
  id: 'p1',
  omie_pedido_id: 111,
  omie_numero_pedido: '000000000010736',
  created_at: '2026-06-01T12:00:00Z',
  account: 'oben',
  items: [],
  ...over,
});

const itemCor = (nome: string, over: Record<string, unknown> = {}) => ({
  descricao: 'BASE BRILH BRANC PU WFBB.6045QT',
  quantidade: 2,
  valor_unitario: 100,
  tint_nome_cor: nome,
  omie_codigo_produto: 4495328577,
  ...over,
});

describe('extrairCoresDoHistorico', () => {
  it('agrupa por cor com ocorrências ordenadas da mais recente pra mais antiga', () => {
    const pedidos = [
      pedido({ id: 'a', omie_pedido_id: 1, created_at: '2026-01-10T00:00:00Z', items: [itemCor('VERDE AFIAÇÃO')] }),
      pedido({ id: 'b', omie_pedido_id: 2, created_at: '2026-03-05T00:00:00Z', items: [itemCor('VERDE AFIAÇÃO', { descricao: 'BASE FOSCO PU WFBB.6045GL' })] }),
      pedido({ id: 'c', omie_pedido_id: 3, created_at: '2026-02-01T00:00:00Z', items: [itemCor('OVO H101 - BS')] }),
    ];

    const cores = extrairCoresDoHistorico(pedidos);

    expect(cores).toHaveLength(2);
    const verde = cores.find((c) => c.nome === 'VERDE AFIAÇÃO')!;
    expect(verde.ocorrencias).toHaveLength(2);
    expect(verde.ocorrencias[0].baseDescricao).toBe('BASE FOSCO PU WFBB.6045GL'); // mar > jan
    expect(verde.ocorrencias[1].baseDescricao).toBe('BASE BRILH BRANC PU WFBB.6045QT');
  });

  it('ordena as CORES pela ocorrência mais recente', () => {
    const pedidos = [
      pedido({ id: 'a', omie_pedido_id: 1, created_at: '2026-01-01T00:00:00Z', items: [itemCor('ANTIGA')] }),
      pedido({ id: 'b', omie_pedido_id: 2, created_at: '2026-06-01T00:00:00Z', items: [itemCor('RECENTE')] }),
    ];
    expect(extrairCoresDoHistorico(pedidos).map((c) => c.nome)).toEqual(['RECENTE', 'ANTIGA']);
  });

  it('dedup wizard×sync: mesmo omie_pedido_id vira UMA ocorrência', () => {
    const pedidos = [
      pedido({ id: 'wizard', omie_pedido_id: 555, items: [itemCor('OVO H101 - BS')] }),
      pedido({ id: 'sync', omie_pedido_id: 555, items: [itemCor('OVO H101 - BS')] }),
    ];
    const cores = extrairCoresDoHistorico(pedidos);
    expect(cores).toHaveLength(1);
    expect(cores[0].ocorrencias).toHaveLength(1);
  });

  it('sem omie_pedido_id (null) NÃO deduplica entre si (fallback id)', () => {
    const pedidos = [
      pedido({ id: 'x', omie_pedido_id: null, created_at: '2026-01-01T00:00:00Z', items: [itemCor('AZUL')] }),
      pedido({ id: 'y', omie_pedido_id: null, created_at: '2026-02-01T00:00:00Z', items: [itemCor('AZUL')] }),
    ];
    expect(extrairCoresDoHistorico(pedidos)[0].ocorrencias).toHaveLength(2);
  });

  it('agrupa a mesma cor com caixa/espacos diferentes; exibe a grafia mais recente', () => {
    const pedidos = [
      pedido({ id: 'a', omie_pedido_id: 1, created_at: '2026-01-01T00:00:00Z', items: [itemCor('ovo h101 - bs')] }),
      pedido({ id: 'b', omie_pedido_id: 2, created_at: '2026-05-01T00:00:00Z', items: [itemCor('OVO H101 - BS ')] }),
    ];
    const cores = extrairCoresDoHistorico(pedidos);
    expect(cores).toHaveLength(1);
    expect(cores[0].nome).toBe('OVO H101 - BS');
    expect(cores[0].ocorrencias).toHaveLength(2);
  });

  it('item sem tint_nome_cor é ignorado; pedido sem nenhum some', () => {
    const pedidos = [
      pedido({ id: 'a', omie_pedido_id: 1, items: [{ descricao: 'CATALISADOR', quantidade: 1, valor_unitario: 50 }] }),
      pedido({ id: 'b', omie_pedido_id: 2, items: [itemCor('VERDE'), { descricao: 'THINNER', quantidade: 1, valor_unitario: 30 }] }),
    ];
    const cores = extrairCoresDoHistorico(pedidos);
    expect(cores).toHaveLength(1);
    expect(cores[0].ocorrencias).toHaveLength(1);
  });

  it('ocorrência carrega data, base, quantidade, PV (sem zeros à esquerda), empresa e código do produto', () => {
    const cores = extrairCoresDoHistorico([
      pedido({ items: [itemCor('OVO H101 - BS')], omie_numero_pedido: '000000000010736', account: 'oben' }),
    ]);
    const oc = cores[0].ocorrencias[0];
    expect(oc).toMatchObject({
      data: '2026-06-01T12:00:00Z',
      baseDescricao: 'BASE BRILH BRANC PU WFBB.6045QT',
      quantidade: 2,
      pv: '10736',
      account: 'oben',
      omieCodigoProduto: 4495328577,
    });
  });

  it('items malformado (null/não-array) não quebra', () => {
    const pedidos = [
      pedido({ id: 'a', omie_pedido_id: 1, items: null as unknown as PedidoHistorico['items'] }),
      pedido({ id: 'b', omie_pedido_id: 2, items: 'lixo' as unknown as PedidoHistorico['items'] }),
      pedido({ id: 'c', omie_pedido_id: 3, items: [itemCor('VERDE')] }),
    ];
    expect(extrairCoresDoHistorico(pedidos)).toHaveLength(1);
  });
});

describe('filtrarCores / normalizarBusca', () => {
  const cores = extrairCoresDoHistorico([
    pedido({ id: 'a', omie_pedido_id: 1, items: [itemCor('VERDE AFIAÇÃO')] }),
    pedido({ id: 'b', omie_pedido_id: 2, items: [itemCor('OVO H101 - BS')] }),
    pedido({ id: 'c', omie_pedido_id: 3, items: [itemCor('CINZA G155 - BS')] }),
  ]);

  it('busca acento-insensitive: "afiacao" acha "AFIAÇÃO"', () => {
    expect(filtrarCores(cores, 'verde afiacao').map((c) => c.nome)).toEqual(['VERDE AFIAÇÃO']);
  });

  it('busca por pedaço do código da cor', () => {
    expect(filtrarCores(cores, 'h101').map((c) => c.nome)).toEqual(['OVO H101 - BS']);
  });

  it('termo vazio/espacos retorna tudo', () => {
    expect(filtrarCores(cores, '')).toHaveLength(3);
    expect(filtrarCores(cores, '   ')).toHaveLength(3);
  });

  it('sem match retorna vazio', () => {
    expect(filtrarCores(cores, 'ROXO INEXISTENTE')).toEqual([]);
  });

  it('normalizarBusca: minúsculas + sem acento + trim', () => {
    expect(normalizarBusca('  Afiação ')).toBe('afiacao');
  });
});

describe('termoBuscaCor', () => {
  it('regressão: rótulo cru com embalagem → código líder (o bug do "Pedir de novo")', () => {
    // "346J - PLATINA BIANCA 900ML" como busca não casava com cor_id "346J - ACRIL BS"
    // nem nome_cor "PLATINA BIANCA" → "nenhuma cor encontrada". Agora vira "346J".
    expect(termoBuscaCor('346J - PLATINA BIANCA 900ML')).toBe('346J');
  });

  it('código líder em grafias variadas do mesmo histórico', () => {
    expect(termoBuscaCor('346J - ACRIL BS - PLATINA BIANCA')).toBe('346J');
    expect(termoBuscaCor('346J ACRIL BS - PLATINA BIANCA')).toBe('346J');
    expect(termoBuscaCor('339H - ACRIL BS - GRAFITE - BS')).toBe('339H');
    expect(termoBuscaCor('985H - ACRIL BS - ONIX I - BS')).toBe('985H');
  });

  it('descarta nota após "|" e embalagem no fim', () => {
    expect(termoBuscaCor('346J PLATINA BIANCA 900ML QT|TULIO LEVOU ESSA')).toBe('346J');
  });

  it('cor_id puramente numérico que lidera (RAL etc.)', () => {
    expect(termoBuscaCor('1247 - AZUL RAL 5010 - QT')).toBe('1247');
  });

  it('nome-líder com código embutido → pega o código (letra+dígito), não a embalagem', () => {
    expect(termoBuscaCor('OVO H101 - BS')).toBe('H101');
    expect(termoBuscaCor('CINZA G155 - BS')).toBe('G155');
  });

  it('cor só por nome (sem código) → rótulo limpo INTEIRO, não a 1ª palavra', () => {
    // Codex P1: "AZUL" sozinho some entre dezenas de azuis (cap de 20/50).
    expect(termoBuscaCor('VERDE AFIAÇÃO')).toBe('VERDE AFIAÇÃO');
    expect(termoBuscaCor('AZUL RAL 5010')).toBe('AZUL RAL 5010');
  });

  it('nome sem código + embalagem no fim → tira só a embalagem', () => {
    expect(termoBuscaCor('AZUL RAL 5010 900ML')).toBe('AZUL RAL 5010');
    expect(termoBuscaCor('VERDE AFIAÇÃO - QT')).toBe('VERDE AFIAÇÃO');
  });

  it('vazio/espaços não quebra', () => {
    expect(termoBuscaCor('')).toBe('');
    expect(termoBuscaCor('   ')).toBe('');
  });
});
