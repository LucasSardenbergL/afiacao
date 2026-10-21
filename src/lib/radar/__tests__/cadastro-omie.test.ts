import { describe, expect, it, vi } from 'vitest';
import {
  validarRespostaCriarCliente,
  cadastrarEmpresaNoOmie,
  documentoCadastravelNoOmie,
  FalhaCadastro,
  ehThrottlingOmie,
  ehSemConfirmacaoDoServidor,
  DivergenciaCadastro,
  divergenciaDaRpc,
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

  // A RPC exige a confirmação que a EDGE gravou (migration 20261021120000). Sem ela, "Gravar de novo" com o mesmo
  // código recusaria em laço: a falha volta para a etapa omie SEM código, e o retry passa pela edge (lookup).
  const SEM_CONFIRMACAO = {
    message: 'RADAR_SEM_CONFIRMACAO_OMIE: o servidor não confirmou o cliente 777 no Omie/Oben para este CNPJ — o lead fica na fila',
    code: 'P0001',
  };
  it('RPC recusa por falta de confirmação do servidor → etapa omie SEM código (retry pela edge, não pelo atalho)', async () => {
    const d = deps({ registrarNoRadar: vi.fn(async () => { throw SEM_CONFIRMACAO; }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toBeInstanceOf(FalhaCadastro);
    expect(err).toMatchObject({ etapa: 'omie', codigo: null });
    expect(err.message).toContain('RADAR_SEM_CONFIRMACAO_OMIE:');
  });

  it('o mesmo vale no retry do atalho (codigoConhecido): a recusa não devolve o código para outro atalho', async () => {
    const d = deps({ registrarNoRadar: vi.fn(async () => { throw SEM_CONFIRMACAO; }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d, { codigoConhecido: '777' }).catch((e) => e);
    expect(err).toMatchObject({ etapa: 'omie', codigo: null });
    expect(d.criarNoOmie).not.toHaveBeenCalled();
  });

  it('ehSemConfirmacaoDoServidor: só a marca no INÍCIO da mensagem (outro P0001 segue etapa radar)', () => {
    expect(ehSemConfirmacaoDoServidor(SEM_CONFIRMACAO)).toBe(true);
    expect(ehSemConfirmacaoDoServidor(new Error('cnpj inválido'))).toBe(false);
    expect(ehSemConfirmacaoDoServidor({ message: 'falhou: RADAR_SEM_CONFIRMACAO_OMIE: eco' })).toBe(false);
    expect(ehSemConfirmacaoDoServidor(null)).toBe(false);
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

/**
 * Codex ALTO 3 do bloco 5 (migration 20261021120500): a RPC passou a ser idempotente pelo vínculo e recusa
 * conflito com SQLSTATE própria. Conflito de identidade Radar×Omie é TERMINAL — nunca sucesso, nunca o
 * "Gravar de novo" (que releria o vínculo antigo e o devolveria como "recuperado").
 */
describe('cadastrarEmpresaNoOmie — conflito de vínculo (RD001/RD002/lookup)', () => {
  // O erro do PostgREST chega como objeto PLANO (não Error) — a classificação é pela SQLSTATE, não pela mensagem.
  const RD001 = { message: 'RADAR_VINCULO_DIVERGENTE: CNPJ 12345678000195 já vinculado ao cliente Omie 555, recebido 777', code: 'RD001', details: null, hint: null };
  const RD002 = { message: 'RADAR_CODIGO_DE_OUTRO_CNPJ: cliente Omie 777 já vinculado a outro CNPJ (recebido para 12345678000195)', code: 'RD002', details: null, hint: null };

  it('RPC recusa com RD001 → DivergenciaCadastro vinculo_divergente, etapa radar, SEM código para "Gravar de novo"', async () => {
    const d = deps({ registrarNoRadar: vi.fn(async () => { throw RD001; }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ etapa: 'radar', motivo: 'vinculo_divergente', codigo: null, codigoRecebido: '777' });
    expect(err.message).toContain('RADAR_VINCULO_DIVERGENTE:');
  });

  it('RPC recusa com RD002 → DivergenciaCadastro codigo_de_outro_cnpj', async () => {
    const d = deps({ registrarNoRadar: vi.fn(async () => { throw RD002; }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ etapa: 'radar', motivo: 'codigo_de_outro_cnpj', codigo: null, codigoRecebido: '777' });
  });

  it('a classificação é pela SQLSTATE: mesma mensagem com outro code segue falha comum (etapa radar COM código)', async () => {
    const d = deps({ registrarNoRadar: vi.fn(async () => { throw { ...RD001, code: 'P0001' }; }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).not.toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ etapa: 'radar', codigo: '777' });
    expect(divergenciaDaRpc({ code: 'RD001' })).toBe('vinculo_divergente');
    expect(divergenciaDaRpc({ code: 'RD002' })).toBe('codigo_de_outro_cnpj');
    expect(divergenciaDaRpc(new Error('RD001'))).toBeNull();
    expect(divergenciaDaRpc(null)).toBeNull();
  });

  it('retomada com código conhecido K e vínculo relido V ≠ K → conflito, NUNCA "recuperado" com V', async () => {
    const d = deps({ lerVinculo: vi.fn(async () => '555') });
    const err = await cadastrarEmpresaNoOmie(empresa, d, { codigoConhecido: '777' }).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ etapa: 'radar', motivo: 'vinculo_divergente', codigo: null, codigoRecebido: '777' });
    expect(d.criarNoOmie).not.toHaveBeenCalled();
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
  });

  it('retomada com código conhecido IGUAL ao vínculo (espaços à parte) → recuperado, sem tocar Omie nem RPC', async () => {
    const d = deps({ lerVinculo: vi.fn(async () => ' 777 ') });
    const r = await cadastrarEmpresaNoOmie(empresa, d, { codigoConhecido: '777' });
    expect(r).toMatchObject({ jaExistia: true, recuperado: true });
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
  });

  it('edge acusa OMIE_LOOKUP_DIVERGENTE (lança) → DivergenciaCadastro lookup_divergente, etapa omie, sem gravar', async () => {
    const d = deps({ criarNoOmie: vi.fn(async () => { throw new Error('OMIE_LOOKUP_DIVERGENTE (oben): o ListarClientes devolveu um cliente com OUTRO documento'); }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ etapa: 'omie', motivo: 'lookup_divergente', codigo: null, codigoRecebido: null });
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
  });

  it('edge devolve success:false com OMIE_LOOKUP_DIVERGENTE no corpo → mesmo conflito terminal', async () => {
    const d = deps({ criarNoOmie: vi.fn(async () => ({ success: false, error: 'OMIE_LOOKUP_DIVERGENTE (oben): outro documento' })) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ etapa: 'omie', motivo: 'lookup_divergente' });
  });

  // Codex (revisão do código, ALTA): a recusa RADAR_SEM_CONFIRMACAO_OMIE descartava K; a retentativa relia um
  // vínculo V ≠ K e devolvia "recuperado" com V. K agora vai como EVIDÊNCIA (codigoVisto), sem reabrir o atalho.
  it('sem confirmação guarda K como evidência (codigoVisto), sem habilitar o atalho (codigo null)', async () => {
    const d = deps({ registrarNoRadar: vi.fn(async () => { throw { message: 'RADAR_SEM_CONFIRMACAO_OMIE: …', code: 'P0001' }; }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toMatchObject({ etapa: 'omie', codigo: null, codigoVisto: '777' });
  });

  it('retentativa com codigoVisto K e vínculo relido V ≠ K → conflito, NUNCA "recuperado" com V', async () => {
    const d = deps({ lerVinculo: vi.fn(async () => '555') });
    const err = await cadastrarEmpresaNoOmie(empresa, d, { retentativa: true, codigoVisto: '777' }).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ motivo: 'vinculo_divergente', codigo: null, codigoRecebido: '777' });
    expect(d.criarNoOmie).not.toHaveBeenCalled();
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
  });

  it('retentativa SEM evidência e vínculo existente → recuperado (não há com o que comparar)', async () => {
    const d = deps({ lerVinculo: vi.fn(async () => '555') });
    const r = await cadastrarEmpresaNoOmie(empresa, d, { retentativa: true });
    expect(r).toMatchObject({ codigo: '555', recuperado: true });
  });

  it('falha comum do Omie (rede/timeout) NÃO vira conflito — segue retentável', async () => {
    const d = deps({ criarNoOmie: vi.fn(async () => { throw new Error('Failed to fetch'); }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toBeInstanceOf(FalhaCadastro);
    expect(err).not.toBeInstanceOf(DivergenciaCadastro);
  });
});
