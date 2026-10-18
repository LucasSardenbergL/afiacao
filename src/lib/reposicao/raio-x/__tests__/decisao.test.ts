import { describe, expect, it } from 'vitest';
import { classificar } from '../classificar';
import {
  alvoDoMotor,
  argsEstadoSalvo,
  destinoEfetivo,
  empresaDoRaioX,
  estadoMotor,
  fornecedorEfetivo,
  lerNumero,
  seloFaseA,
  sugestaoInicial,
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
