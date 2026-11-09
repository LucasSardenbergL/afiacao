import { describe, expect, it } from 'vitest';
import { classificar } from '../classificar';
import {
  alvoDoMotor,
  argsEstadoSalvo,
  assinaturaServidor,
  destinoEfetivo,
  empresaDoRaioX,
  estadoMotor,
  fornecedorEfetivo,
  lerNumero,
  seloFaseA,
  sugestaoInicial,
  argsConfirmarSugestao,
} from '../decisao';
import { decisao, fato, HOJE } from './fixtures';

const item = (o: Parameters<typeof fato>[0] = {}) => classificar([fato(o)], new Map(), 'oben', HOJE)[0];

describe('lerNumero (porte do logica.mjs, vírgula decimal pt-BR)', () => {
  it('distingue vazio de inválido', () => {
    expect(lerNumero('')).toEqual({ valor: null, erro: false });
    expect(lerNumero('   ')).toEqual({ valor: null, erro: false });
    expect(lerNumero('12')).toEqual({ valor: 12, erro: false });
    expect(lerNumero('12,5')).toEqual({ valor: 12.5, erro: false });
    expect(lerNumero('1.234,5')).toEqual({ valor: 1234.5, erro: false });
    expect(lerNumero('R$ 10,00')).toEqual({ valor: 10, erro: false });
    expect(lerNumero('abc')).toEqual({ valor: null, erro: true });
    expect(lerNumero('12.5')).toEqual({ valor: null, erro: true });
    expect(lerNumero('-3')).toEqual({ valor: null, erro: true });
    expect(lerNumero('NaN')).toEqual({ valor: null, erro: true });
  });
});

describe('empresaDoRaioX', () => {
  it('OBEN/COLACOR mapeiam; Colacor SC e demais ficam fora', () => {
    expect(empresaDoRaioX('OBEN')).toBe('oben');
    expect(empresaDoRaioX('COLACOR')).toBe('colacor');
    expect(empresaDoRaioX('COLACOR_SC')).toBeNull();
  });
});

describe('alvoDoMotor / estadoMotor (Ruling S3)', () => {
  it('só trocar/liquidar/manter têm alvo', () => {
    expect(alvoDoMotor('trocar')).toBe('descontinuado');
    expect(alvoDoMotor('liquidar')).toBe('descontinuado');
    expect(alvoDoMotor('manter_suspender_recompra')).toBe('sob_encomenda');
    expect(alvoDoMotor('venda_dirigida')).toBeNull();
    expect(alvoDoMotor(null)).toBeNull();
  });
  it('destino sem alvo → null (nada a mostrar)', () => {
    expect(estadoMotor('oben', item({ no_motor: true }), 'venda_dirigida')).toBeNull();
  });
  it('Colacor → colacor, mesmo com no_motor', () => {
    expect(estadoMotor('colacor', item({ no_motor: true }), 'liquidar')).toBe('colacor');
  });
  it('Oben sem sku_parametros → sem_parametro', () => {
    expect(estadoMotor('oben', item({ no_motor: false }), 'liquidar')).toBe('sem_parametro');
  });
  it('Oben já no alvo → ja_fora; alvo depende do destino', () => {
    const fora = item({ no_motor: true, habilitado_reposicao_automatica: false, tipo_reposicao: 'descontinuado' });
    expect(estadoMotor('oben', fora, 'liquidar')).toBe('ja_fora');
    expect(estadoMotor('oben', fora, 'manter_suspender_recompra')).toBe('pode_tirar');
  });
  it('Oben no motor (habilitado null/true) → pode_tirar', () => {
    expect(estadoMotor('oben', item({ no_motor: true, habilitado_reposicao_automatica: null }), 'trocar')).toBe('pode_tirar');
    expect(estadoMotor('oben', item({ no_motor: true, habilitado_reposicao_automatica: true, tipo_reposicao: 'descontinuado' }), 'trocar')).toBe('pode_tirar');
  });
});

describe('seloFaseA', () => {
  it('migrado da fase A, destino-alvo, motor não tocado', () => {
    expect(seloFaseA(decisao(1, { origem: 'artifact_fase_a', destino: 'liquidar' }))).toBe(true);
    expect(seloFaseA(decisao(1, { origem: 'artifact_fase_a', destino: 'liquidar', tirou_do_motor: true }))).toBe(false);
    expect(seloFaseA(decisao(1, { origem: 'app', destino: 'liquidar' }))).toBe(false);
    expect(seloFaseA(decisao(1, { origem: 'artifact_fase_a', destino: 'venda_dirigida' }))).toBe(false);
    expect(seloFaseA(undefined)).toBe(false);
  });
});

describe('argsEstadoSalvo (Ruling S2: estado COMPLETO)', () => {
  it('reenvia observação, fornecedor e crédito; categoria efetiva do item', () => {
    const a = argsEstadoSalvo(item({ sku_codigo_omie: 7 }), decisao(7, {
      destino: 'trocar', observacao: 'obs', fornecedor_informado: 'ACRE', credito_troca: 40,
    }), { tirarDoMotor: true });
    expect(a).toEqual({
      sku: 7, destino: 'trocar', categoria: 'mercadoria', observacao: 'obs', fornecedor: 'ACRE',
      creditoTroca: 40, tirarDoMotor: true, restaurarMotor: false,
    });
  });
  it('crédito só vai com destino trocar', () => {
    const a = argsEstadoSalvo(item({ sku_codigo_omie: 7 }), decisao(7, { destino: 'liquidar', credito_troca: 40 }), { restaurarMotor: true });
    expect(a.creditoTroca).toBeNull();
    expect(a.restaurarMotor).toBe(true);
    expect(a.tirarDoMotor).toBe(false);
  });
});

describe('destinoEfetivo / fornecedorEfetivo (Ruling S4: igual à coluna)', () => {
  it('decidido vence a sugestão', () => {
    const i = item({ sku_codigo_omie: 1 });
    expect(destinoEfetivo(i, decisao(1, { destino: 'estrategico' }))).toBe('estrategico');
    expect(destinoEfetivo(i, undefined)).toBe(i.destino_sugerido);
    expect(destinoEfetivo(i, decisao(1, { destino: null }))).toBe(i.destino_sugerido);
  });
  it('fornecedor informado vence o do cadastro', () => {
    const i = item({ sku_codigo_omie: 1, fornecedor: 'SAYERLACK' });
    expect(fornecedorEfetivo(i, decisao(1, { fornecedor_informado: 'ACRE' }))).toBe('ACRE');
    expect(fornecedorEfetivo(i, decisao(1))).toBe('SAYERLACK');
    expect(fornecedorEfetivo(item({ fornecedor: null }), undefined)).toBeNull();
  });
});

describe('sugestaoInicial (P10: só mercadoria parada pré-seleciona)', () => {
  it('mercadoria parada com destino real → pré-seleciona', () => {
    const i = { ...item(), categoria: 'mercadoria' as const, parado: true, destino_sugerido: 'liquidar' as const };
    expect(sugestaoInicial(i)).toBe('liquidar');
  });
  it('sugestão que não é destino (revisar/novo/sem histórico) → null', () => {
    const i = { ...item(), categoria: 'mercadoria' as const, parado: true, destino_sugerido: 'revisar' as const };
    expect(sugestaoInicial(i)).toBeNull();
  });
  it('uso e consumo → null', () => {
    const i = { ...item(), categoria: 'uso_consumo' as const, parado: true, destino_sugerido: 'liquidar' as const };
    expect(sugestaoInicial(i)).toBeNull();
  });
});

describe('assinaturaServidor (Ruling S9)', () => {
  it('muda com atualizado_em, tipo_reposicao ou habilitado; estável sem mudança', () => {
    const i = item({ tipo_reposicao: 'normal', habilitado_reposicao_automatica: true });
    const d = decisao(1, { atualizado_em: 'A' });
    const base = assinaturaServidor(i, d);
    expect(assinaturaServidor(i, decisao(1, { atualizado_em: 'A' }))).toBe(base);
    expect(assinaturaServidor(i, decisao(1, { atualizado_em: 'B' }))).not.toBe(base);
    expect(assinaturaServidor({ ...i, tipo_reposicao: 'descontinuado' }, d)).not.toBe(base);
    expect(assinaturaServidor({ ...i, habilitado_reposicao_automatica: false }, d)).not.toBe(base);
    expect(assinaturaServidor(i, undefined)).not.toBe(base);
  });
});

describe('argsConfirmarSugestao (UX 2 — 1 toque)', () => {
  const sayer = (o = {}) => classificar([fato({ sku_codigo_omie: 7, q12: 0, fornecedor: 'Sayerlack', no_motor: true, tipo_reposicao: 'automatica', habilitado_reposicao_automatica: true, ...o })], new Map(), 'oben', HOJE)[0];
  it('pendente com sugestão que é destino: decide a sugestão e tira do motor quando há o que tirar', () => {
    expect(argsConfirmarSugestao('oben', sayer(), undefined)).toEqual({
      sku: 7, destino: 'trocar', categoria: 'mercadoria', observacao: null, fornecedor: null, creditoTroca: null,
      tirarDoMotor: true, restaurarMotor: false,
    });
  });
  it('sem parâmetro no motor: não tenta tirar (RX001)', () => {
    expect(argsConfirmarSugestao('oben', sayer({ no_motor: false }), undefined)?.tirarDoMotor).toBe(false);
  });
  it('já decidido, linha histórica ou sugestão que não é destino: nada a confirmar', () => {
    expect(argsConfirmarSugestao('oben', sayer(), decisao(7, { destino: 'liquidar' }))).toBeNull();
    expect(argsConfirmarSugestao('oben', { ...sayer(), fora_do_estoque: true }, undefined)).toBeNull();
    expect(argsConfirmarSugestao('oben', { ...sayer(), destino_sugerido: 'revisar' }, undefined)).toBeNull();
  });
  it('linha sem destino (só contagem) preserva observação/fornecedor — a RPC apaga campo omitido', () => {
    const a = argsConfirmarSugestao('oben', sayer(), decisao(7, { observacao: 'conferido', fornecedor_informado: 'F', qtd_contada: 2 }));
    expect(a).toMatchObject({ destino: 'trocar', observacao: 'conferido', fornecedor: 'F' });
  });
  it('liquidar sem veredito inequívoco do servidor: nada a confirmar (2ª camada do bug 5)', () => {
    const liq = classificar([fato({ sku_codigo_omie: 8, q12: 0, fornecedor: 'Forn X' })], new Map(), 'oben', HOJE)[0];
    expect(liq.destino_sugerido).toBe('liquidar');
    expect(argsConfirmarSugestao('oben', liq, undefined)).toBeNull();
    expect(argsConfirmarSugestao('oben', { ...liq, inequivoco: false }, undefined)).toBeNull();
    expect(argsConfirmarSugestao('oben', { ...liq, inequivoco: true }, undefined)?.destino).toBe('liquidar');
  });
});
