import { describe, expect, it, vi } from 'vitest';
import {
  validarRespostaCriarCliente,
  cadastrarEmpresaNoOmie,
  documentoCadastravelNoOmie,
  FalhaCadastro,
  ehThrottlingOmie,
  type DepsCadastro,
} from '../cadastro-omie';

/**
 * Money-path (escrita no ERP + mudança de funil): o P0 do consult Codex (2026-10-18) era
 * `success:true, codigo_cliente:null` — a edge devolve isso quando `callOmieVendasApi`
 * retorna null pós rate-limit — e o front marcava `ja_cliente=true`, tirando o lead da
 * fila SEM cliente no Omie. Resposta incompleta é INDETERMINADA, nunca cadastro.
 */
const empresa = { cnpj: '12345678000195', razao_social: 'ACME' };

function deps(over: Partial<DepsCadastro> = {}): DepsCadastro & { criarNoOmie: ReturnType<typeof vi.fn>; registrarNoRadar: ReturnType<typeof vi.fn>; lerVinculo: ReturnType<typeof vi.fn> } {
  return {
    criarNoOmie: vi.fn(async () => ({ success: true, created: true, codigo_cliente: 777 })),
    registrarNoRadar: vi.fn(async () => undefined),
    lerVinculo: vi.fn(async () => null),
    ...over,
  } as never;
}

describe('validarRespostaCriarCliente', () => {
  it('aceita created:true com código numérico → string', () => {
    expect(validarRespostaCriarCliente({ success: true, created: true, codigo_cliente: 777 })).toEqual({ codigo: '777', jaExistia: false });
  });
  it('aceita created:false (já existia) com código', () => {
    expect(validarRespostaCriarCliente({ success: true, created: false, codigo_cliente: '12' })).toEqual({ codigo: '12', jaExistia: true });
  });
  it.each([
    ['success true sem código (P0)', { success: true, created: true, codigo_cliente: null }],
    ['created não-booleano', { success: true, codigo_cliente: 1 }],
    ['código vazio', { success: true, created: true, codigo_cliente: '' }],
    ['resposta nula', null],
    ['resposta string', 'ok'],
  ])('%s → INDETERMINADO (marca no erro)', (_n, data) => {
    expect(() => validarRespostaCriarCliente(data)).toThrow(/OMIE_RESPOSTA_INDETERMINADA/);
  });
  it('success:false → erro com a mensagem da edge, marca FALHA_OMIE', () => {
    expect(() => validarRespostaCriarCliente({ success: false, error: 'CNPJ inválido' })).toThrow(/FALHA_OMIE.*CNPJ inválido/);
  });
});

describe('cadastrarEmpresaNoOmie', () => {
  it('caminho feliz: Omie confirma → grava no Radar com o código e ja_existia=false', async () => {
    const d = deps();
    const r = await cadastrarEmpresaNoOmie(empresa, d);
    expect(r).toEqual({ codigo: '777', jaExistia: false, recuperado: false });
    expect(d.registrarNoRadar).toHaveBeenCalledWith('12345678000195', '777', false);
  });

  it('CNPJ alfanumérico VÁLIDO (exemplo oficial RFB 12.ABC.345/01DE-35) → vai à edge INTACTO e grava no Radar com as letras', async () => {
    const d = deps();
    const r = await cadastrarEmpresaNoOmie({ cnpj: '12ABC34501DE35', razao_social: 'ALFA' }, d);
    expect(r).toEqual({ codigo: '777', jaExistia: false, recuperado: false });
    expect(d.criarNoOmie).toHaveBeenCalledWith({ cnpj: '12ABC34501DE35', razao_social: 'ALFA' });
    expect(d.registrarNoRadar).toHaveBeenCalledWith('12ABC34501DE35', '777', false);
  });
  it.each([
    ['DV errado', '12ABC34501DE36'],
    ['minúscula (não normaliza — fail-closed)', '12abc34501DE35'],
    ['13 posições', '12ABC34501DE3'],
    ['letra fora do formato (viraria CPF de OUTRA pessoa após o \\D)', '123ABC45678909'],
  ])('CNPJ com letra que NÃO é alfanumérico válido — %s → falha na etapa omie ANTES de chamar a edge', async (_n, cnpj) => {
    const d = deps();
    const err = await cadastrarEmpresaNoOmie({ cnpj }, d).catch((e) => e);
    expect(err).toBeInstanceOf(FalhaCadastro);
    expect((err as FalhaCadastro).etapa).toBe('omie');
    expect((err as FalhaCadastro).message).toMatch(/CNPJ inválido para cadastro no Omie/);
    expect(d.criarNoOmie).not.toHaveBeenCalled();
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
  });
  it('documentoCadastravelNoOmie: numérico de 14 dígitos passa sem conferir DV (como sempre); alfanumérico só com DV', () => {
    expect(documentoCadastravelNoOmie('12345678000195')).toBe(true);
    expect(documentoCadastravelNoOmie('00000000000000')).toBe(true);
    expect(documentoCadastravelNoOmie('12ABC34501DE35')).toBe(true);
    expect(documentoCadastravelNoOmie('12ABC34501DE36')).toBe(false);
    expect(documentoCadastravelNoOmie('12.ABC.345/01DE-35')).toBe(false);
  });
  it('P0: código nulo → NÃO grava no Radar e falha na etapa omie', async () => {
    const d = deps({ criarNoOmie: vi.fn(async () => ({ success: true, created: true, codigo_cliente: null })) });
    await expect(cadastrarEmpresaNoOmie(empresa, d)).rejects.toMatchObject({ etapa: 'omie' });
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
  });

  it('Omie confirmou mas a RPC falhou → FalhaCadastro etapa radar COM o código (retry só da gravação)', async () => {
    const d = deps({ registrarNoRadar: vi.fn(async () => { throw new Error('permission denied'); }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toBeInstanceOf(FalhaCadastro);
    expect(err).toMatchObject({ etapa: 'radar', codigo: '777' });
  });

  it('retomada só do Radar (codigoConhecido): não chama o Omie, relê o vínculo e grava se faltar', async () => {
    const d = deps();
    const r = await cadastrarEmpresaNoOmie(empresa, d, { codigoConhecido: '777' });
    expect(d.criarNoOmie).not.toHaveBeenCalled();
    expect(d.lerVinculo).toHaveBeenCalledWith('12345678000195');
    expect(d.registrarNoRadar).toHaveBeenCalledWith('12345678000195', '777', true);
    expect(r).toEqual({ codigo: '777', jaExistia: true, recuperado: true });
  });

  it('retomada com vínculo JÁ gravado: não repete a RPC (ela insere outro contato a cada chamada)', async () => {
    const d = deps({ lerVinculo: vi.fn(async () => '777') });
    const r = await cadastrarEmpresaNoOmie(empresa, d, { codigoConhecido: '777' });
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
    expect(r).toEqual({ codigo: '777', jaExistia: true, recuperado: true });
  });

  it('retentativa (resposta perdida): relê o vínculo ANTES da edge — já gravado → não toca Omie nem Radar', async () => {
    const d = deps({ lerVinculo: vi.fn(async () => '555') });
    const r = await cadastrarEmpresaNoOmie(empresa, d, { retentativa: true });
    expect(d.criarNoOmie).not.toHaveBeenCalled();
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
    expect(r).toEqual({ codigo: '555', jaExistia: true, recuperado: true });
  });

  it('retentativa sem vínculo: segue pela edge (anti-dup pelo CNPJ) e grava', async () => {
    const d = deps({ criarNoOmie: vi.fn(async () => ({ success: true, created: false, codigo_cliente: 9 })) });
    const r = await cadastrarEmpresaNoOmie(empresa, d, { retentativa: true });
    expect(d.lerVinculo).toHaveBeenCalledTimes(1);
    expect(d.criarNoOmie).toHaveBeenCalledTimes(1);
    expect(d.registrarNoRadar).toHaveBeenCalledWith('12345678000195', '9', true);
    expect(r).toEqual({ codigo: '9', jaExistia: true, recuperado: true });
  });

  it('erro de rede na edge → etapa omie, sem gravar', async () => {
    const d = deps({ criarNoOmie: vi.fn(async () => { throw new Error('Failed to fetch'); }) });
    await expect(cadastrarEmpresaNoOmie(empresa, d)).rejects.toMatchObject({ etapa: 'omie' });
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
  });
});

describe('ehThrottlingOmie', () => {
  it('reconhece a marca da edge (OMIE_TRANSIENT/rate limit) e ignora o resto', () => {
    expect(ehThrottlingOmie(new Error('OMIE_TRANSIENT (oben): rate limit persistiu após 3 tentativas'))).toBe(true);
    expect(ehThrottlingOmie(new FalhaCadastro('omie', 'FALHA_OMIE: Rate limit'))).toBe(true);
    expect(ehThrottlingOmie(new Error('CNPJ inválido'))).toBe(false);
    expect(ehThrottlingOmie('x')).toBe(false);
  });
});
