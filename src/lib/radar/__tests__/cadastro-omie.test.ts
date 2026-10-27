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
import type { ConflitoCadastro, EstadoCadastro } from '../conflito-cadastro';

/**
 * Money-path (escrita no ERP + mudança de funil): o P0 do consult Codex (2026-10-18) era
 * `success:true, codigo_cliente:null` — a edge devolve isso quando `callOmieVendasApi`
 * retorna null pós rate-limit — e o front marcava `ja_cliente=true`, tirando o lead da
 * fila SEM cliente no Omie. Resposta incompleta é INDETERMINADA, nunca cadastro.
 */
const empresa = { cnpj: '12345678000195', razao_social: 'ACME' };

type Fn = ReturnType<typeof vi.fn>;
/** Conflito como o servidor devolve (já parseado). */
function conflito(over: Partial<ConflitoCadastro> = {}): ConflitoCadastro {
  return {
    id: 41, cnpj: '12345678000195', motivo: 'vinculo_divergente', codigoRecebido: '777', codigoVinculado: '555', cnpjDoCodigo: null,
    detalhe: 'RADAR_VINCULO_DIVERGENTE: …', ocorrencias: 1, versao: 1, ultimaEm: '2026-10-27T15:00:00Z', resolvidoEm: null, notaResolucao: null,
    ...over,
  };
}
/** `lerEstado` com o vínculo V e os conflitos ABERTOS dados. */
const estado = (vinculo: string | null, conflitos: ConflitoCadastro[] = []) => vi.fn(async (): Promise<EstadoCadastro> => ({ vinculo, conflitos }));

function deps(over: Partial<DepsCadastro> = {}): DepsCadastro & { criarNoOmie: Fn; registrarNoRadar: Fn; lerEstado: Fn; registrarConflito: Fn } {
  return {
    criarNoOmie: vi.fn(async () => ({ success: true, created: true, codigo_cliente: 777 })),
    registrarNoRadar: vi.fn(async () => ({ ok: true, deduped: false })),
    lerEstado: estado(null),
    registrarConflito: vi.fn(async (_c: string, motivo: ConflitoCadastro['motivo'], codigo: string | null) => conflito({ id: 99, motivo, codigoRecebido: codigo })),
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
    expect(d.lerEstado).toHaveBeenCalledWith('12345678000195');
    expect(d.registrarNoRadar).toHaveBeenCalledWith('12345678000195', '777', true);
    expect(r).toEqual({ codigo: '777', jaExistia: true, recuperado: true });
  });

  it('retomada com vínculo JÁ gravado: não repete a RPC (ela insere outro contato a cada chamada)', async () => {
    const d = deps({ lerEstado: estado('777') });
    const r = await cadastrarEmpresaNoOmie(empresa, d, { codigoConhecido: '777' });
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
    expect(r).toEqual({ codigo: '777', jaExistia: true, recuperado: true });
  });

  it('retentativa (resposta perdida): relê o vínculo ANTES da edge — já gravado → não toca Omie nem Radar', async () => {
    const d = deps({ lerEstado: estado('555') });
    const r = await cadastrarEmpresaNoOmie(empresa, d, { retentativa: true });
    expect(d.criarNoOmie).not.toHaveBeenCalled();
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
    expect(r).toEqual({ codigo: '555', jaExistia: true, recuperado: true });
  });

  it('retentativa sem vínculo: segue pela edge (anti-dup pelo CNPJ) e grava', async () => {
    const d = deps({ criarNoOmie: vi.fn(async () => ({ success: true, created: false, codigo_cliente: 9 })) });
    const r = await cadastrarEmpresaNoOmie(empresa, d, { retentativa: true });
    expect(d.lerEstado).toHaveBeenCalledTimes(1);
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

  it('RD001 CRU (ex.: a v1 respondendo) → DivergenciaCadastro vinculo_divergente, SEM código para "Gravar de novo", registrado à parte', async () => {
    const d = deps({ registrarNoRadar: vi.fn(async () => { throw RD001; }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ etapa: 'radar', motivo: 'vinculo_divergente', codigo: null, codigoRecebido: '777', bloqueio: false });
    expect(err.message).toContain('RADAR_VINCULO_DIVERGENTE:');
    expect(d.registrarConflito).toHaveBeenCalledWith('12345678000195', 'vinculo_divergente', '777', RD001.message);
    expect(err.conflito).toMatchObject({ id: 99 });
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
    const d = deps({ lerEstado: estado('555') });
    const err = await cadastrarEmpresaNoOmie(empresa, d, { codigoConhecido: '777' }).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ etapa: 'radar', motivo: 'vinculo_divergente', codigo: null, codigoRecebido: '777' });
    expect(d.criarNoOmie).not.toHaveBeenCalled();
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
  });

  it('retomada com código conhecido IGUAL ao vínculo (o parser já apara) → recuperado, sem tocar Omie nem RPC', async () => {
    const d = deps({ lerEstado: estado('777') });
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
    const d = deps({ lerEstado: estado('555') });
    const err = await cadastrarEmpresaNoOmie(empresa, d, { retentativa: true, codigoVisto: '777' }).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ motivo: 'vinculo_divergente', codigo: null, codigoRecebido: '777' });
    expect(d.criarNoOmie).not.toHaveBeenCalled();
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
  });

  it('retentativa SEM evidência e vínculo existente → recuperado (não há com o que comparar)', async () => {
    const d = deps({ lerEstado: estado('555') });
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

/**
 * Achado 3 do Codex no PR #3293 (migration 20261027160000): o aviso de conflito mora no SERVIDOR. A aba A, cujo
 * lote local perdeu o `divergente` da aba B, NÃO pode devolver "recuperado" com o vínculo antigo — o conflito
 * aberto, lido JUNTO com o vínculo, barra o CNPJ em todo caminho. Bloqueio não é observação nova.
 */
describe('cadastrarEmpresaNoOmie — conflito registrado no servidor', () => {
  it.each([
    ['cadastro novo (ficha/oferta/lote)', {}],
    ['retentativa sem evidência — a aba A do defeito', { retentativa: true }],
    ['retentativa com codigoVisto', { retentativa: true, codigoVisto: '777' }],
    ['atalho codigoConhecido', { codigoConhecido: '777' }],
  ])('conflito ABERTO no servidor barra %s: nem Omie, nem RPC, nem registro novo', async (_n, opcoes) => {
    const aberto = conflito({ id: 7, codigoVinculado: '555' });
    const d = deps({ lerEstado: estado('555', [aberto]) });
    const err = await cadastrarEmpresaNoOmie(empresa, d, opcoes).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ bloqueio: true, conflito: { id: 7 }, codigo: null });
    expect(err.message).toMatch(/^RADAR_CONFLITO_ABERTO: /);
    expect(d.criarNoOmie).not.toHaveBeenCalled();
    expect(d.registrarNoRadar).not.toHaveBeenCalled();
    expect(d.registrarConflito).not.toHaveBeenCalled();
  });

  it('leitura do estado FALHA → bloqueia (nunca "zero conflitos"): não chama o Omie', async () => {
    const d = deps({ lerEstado: vi.fn(async () => { throw new Error('Failed to fetch'); }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toBeInstanceOf(FalhaCadastro);
    expect(err).not.toBeInstanceOf(DivergenciaCadastro);
    expect(err.message).toMatch(/^não consegui ler o vínculo e os conflitos no Radar — nada foi feito: /);
    expect(d.criarNoOmie).not.toHaveBeenCalled();
  });

  it('leitura falha numa retomada com K: guarda K como evidência para a próxima comparação', async () => {
    const d = deps({ lerEstado: vi.fn(async () => { throw new Error('timeout'); }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d, { retentativa: true, codigoVisto: '777' }).catch((e) => e);
    expect(err).toMatchObject({ etapa: 'omie', codigo: null, codigoVisto: '777' });
  });

  it('v2 devolve {ok:false} (RD001 JÁ registrado pelo servidor) → DivergenciaCadastro com o conflito, sem registrar de novo', async () => {
    const c = conflito({ id: 12 });
    const d = deps({ registrarNoRadar: vi.fn(async () => ({ ok: false as const, bloqueado: false, conflito: c })) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ etapa: 'radar', motivo: 'vinculo_divergente', codigo: null, codigoRecebido: '777', bloqueio: false, conflito: { id: 12 } });
    expect(d.registrarConflito).not.toHaveBeenCalled();
  });

  it('v2 devolve bloqueado (conflito apareceu entre a leitura e a gravação) → bloqueio, não observação', async () => {
    const d = deps({ registrarNoRadar: vi.fn(async () => ({ ok: false as const, bloqueado: true, conflito: conflito({ id: 13, motivo: 'codigo_de_outro_cnpj' }) })) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(err).toMatchObject({ bloqueio: true, motivo: 'codigo_de_outro_cnpj', conflito: { id: 13 } });
    expect(err.message).toMatch(/^RADAR_CONFLITO_ABERTO: /);
  });

  it('retomada K≠V observada no front → registra no servidor (vinculo_divergente, K) e lança com o registro', async () => {
    const d = deps({ lerEstado: estado('555') });
    const err = await cadastrarEmpresaNoOmie(empresa, d, { codigoConhecido: '777' }).catch((e) => e);
    expect(d.registrarConflito).toHaveBeenCalledWith('12345678000195', 'vinculo_divergente', '777', expect.stringMatching(/^RADAR_VINCULO_DIVERGENTE: /));
    expect(err).toMatchObject({ bloqueio: false, conflito: { id: 99 }, erroRegistro: null });
  });

  it('registro do conflito FALHA → o conflito continua (local, não sincronizado), nunca sucesso', async () => {
    const d = deps({ lerEstado: estado('555'), registrarConflito: vi.fn(async () => { throw new Error('Failed to fetch'); }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d, { retentativa: true, codigoVisto: '777' }).catch((e) => e);
    expect(err).toBeInstanceOf(DivergenciaCadastro);
    expect(err).toMatchObject({ conflito: null, erroRegistro: 'Failed to fetch', motivo: 'vinculo_divergente' });
  });

  it('lookup divergente da edge → registrado como lookup_divergente sem código', async () => {
    const d = deps({ criarNoOmie: vi.fn(async () => { throw new Error('OMIE_LOOKUP_DIVERGENTE (oben): outro documento'); }) });
    const err = await cadastrarEmpresaNoOmie(empresa, d).catch((e) => e);
    expect(d.registrarConflito).toHaveBeenCalledWith('12345678000195', 'lookup_divergente', null, expect.stringContaining('OMIE_LOOKUP_DIVERGENTE'));
    expect(err).toMatchObject({ etapa: 'omie', motivo: 'lookup_divergente', conflito: { id: 99 } });
  });

  it('falha comum do Omie NÃO registra conflito', async () => {
    const d = deps({ criarNoOmie: vi.fn(async () => { throw new Error('Failed to fetch'); }) });
    await cadastrarEmpresaNoOmie(empresa, d).catch(() => undefined);
    expect(d.registrarConflito).not.toHaveBeenCalled();
  });
});
