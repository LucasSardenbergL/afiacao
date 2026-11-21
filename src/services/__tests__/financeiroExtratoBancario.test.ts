import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const rpc = vi.fn();
const from = vi.fn();
const upload = vi.fn();
const invoke = vi.fn();
const remove = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    from: (...a: unknown[]) => from(...a),
    storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a), remove: (...a: unknown[]) => remove(...a) }) },
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
  },
}));

import {
  ErroEnvioExtrato,
  MOTIVOS_PARSE,
  MOTIVOS_REGISTRO,
  ErroAncora,
  enviarExtrato,
  listarAncoras,
  marcarConferido,
  registrarAncoraManual,
  resumoDia,
  textoDoMotivo,
} from '../financeiroExtratoBancario';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resumoDia', () => {
  it('chama a RPC com p_de/p_ate e não lê banco_extrato_linha', async () => {
    rpc.mockResolvedValue({
      data: [
        { data: '2026-11-10', coberto: false, creditos_centavos: null, debitos_centavos: null, saldo_final_dia_centavos: null, saldo_omie_centavos: '7000' },
        { data: '2026-11-11', coberto: true, creditos_centavos: 0, debitos_centavos: '250', saldo_final_dia_centavos: 1000, saldo_omie_centavos: null },
      ],
      error: null,
    });
    const r = await resumoDia('c1', '2026-11-10', '2026-11-11');
    expect(rpc).toHaveBeenCalledWith('banco_extrato_resumo_dia', {
      p_banco_conta_id: 'c1',
      p_de: '2026-11-10',
      p_ate: '2026-11-11',
    });
    expect(from).not.toHaveBeenCalledWith('banco_extrato_linha');
    expect(r[0]).toMatchObject({ coberto: false, creditos: null, debitos: null, saldoFinal: null, saldoOmie: 7000 });
    expect(r[1]).toMatchObject({ coberto: true, creditos: 0, debitos: 250, saldoFinal: 1000, saldoOmie: null });
  });

  it('erro da RPC propaga (não vira lista vazia)', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });
    await expect(resumoDia('c1', '2026-11-01', '2026-11-30')).rejects.toThrow('boom');
  });
});

describe('mapa de motivo', () => {
  it('cobre todos os motivos de banco_extrato_registrar e do parse, com texto não vazio', () => {
    for (const m of [...MOTIVOS_REGISTRO, ...MOTIVOS_PARSE]) {
      expect(textoDoMotivo(m).length).toBeGreaterThan(5);
    }
  });

  it('a união de registro bate com TODA forma de emitir motivo na migration (sem motivo esquecido)', () => {
    const sql = readFileSync(resolve(__dirname, '../../../supabase/migrations/20261121123119_banco_extrato_f1.sql'), 'utf8');
    // Formas: (a) `v_motivo := 'x'`; (b) `'motivo', 'x'` em jsonb_build_object (RETURN direto).
    const noSql = new Set([...sql.matchAll(/(?:v_motivo :=|'motivo',)\s*'([a-z_]+)'/g)].map((m) => m[1]));
    expect([...noSql].sort()).toEqual([...MOTIVOS_REGISTRO].sort());
    // Nenhuma OUTRA forma: todo `'motivo',` e todo `v_motivo :=` tem RHS literal, NULL ou a variável v_motivo.
    const rhs = [...sql.matchAll(/(?:v_motivo :=|'motivo',)\s*([^;,)\s]+)/g)].map((m) => m[1]);
    for (const r of rhs) expect(r, `RHS de motivo não coberto pelo teste: ${r}`).toMatch(/^('[a-z_]+'|NULL|v_motivo)$/);
  });
});

describe('marcarConferido', () => {
  it('chama a RPC com p_arquivo_id', async () => {
    rpc.mockResolvedValue({ data: null, error: null });
    await marcarConferido('a1');
    expect(rpc).toHaveBeenCalledWith('banco_extrato_marcar_conferido', { p_arquivo_id: 'a1' });
  });
});

describe('enviarExtrato', () => {
  const arquivo = new File(['x'], 'extrato.OFX');
  const httpErr = (status: number, corpo: unknown) => ({
    message: 'Edge Function returned a non-2xx status code',
    context: new Response(JSON.stringify(corpo), { status }),
  });

  it('sobe em {conta}/{uuid}.{ext} e devolve a resposta aceita', async () => {
    upload.mockResolvedValue({ error: null });
    invoke.mockResolvedValue({
      data: { status: 'aceito', arquivo_id: 'a1', motivo: null, detalhe: null, qtd_linhas_novas: 3 },
      error: null,
    });
    const r = await enviarExtrato(arquivo, { id: 'conta-1' });
    const path = upload.mock.calls[0][0] as string;
    expect(path).toMatch(/^conta-1\/[0-9a-f-]{36}\.ofx$/);
    expect(invoke).toHaveBeenCalledWith('banco-extrato-importar', { body: { storage_path: path, banco_conta_id: 'conta-1' } });
    expect(r).toMatchObject({ status: 'aceito', arquivoId: 'a1', qtdLinhasNovas: 3 });
  });

  it('422 com erro_parse vira ErroEnvioExtrato parse com o motivo', async () => {
    upload.mockResolvedValue({ error: null });
    invoke.mockResolvedValue({ data: null, error: httpErr(422, { erro_parse: { motivo: 'data_invalida', detalhe: 'DTPOSTED' } }) });
    await expect(enviarExtrato(arquivo, { id: 'c' })).rejects.toMatchObject({ classe: 'parse', motivo: 'data_invalida' });
  });

  it('500 é falha interna, NÃO arquivo recusado', async () => {
    upload.mockResolvedValue({ error: null });
    invoke.mockResolvedValue({ data: null, error: httpErr(500, { erro: 'erro_interno' }) });
    const e = await enviarExtrato(arquivo, { id: 'c' }).catch((x) => x);
    expect(e).toBeInstanceOf(ErroEnvioExtrato);
    expect(e.classe).toBe('interno');
  });

  it('403 é acesso', async () => {
    upload.mockResolvedValue({ error: null });
    invoke.mockResolvedValue({ data: null, error: httpErr(403, { erro: 'forbidden' }) });
    await expect(enviarExtrato(arquivo, { id: 'c' })).rejects.toMatchObject({ classe: 'acesso' });
  });

  it('401 e 403 têm mensagem própria de permissão (não "falha interna")', async () => {
    for (const st of [401, 403]) {
      upload.mockResolvedValue({ error: null });
      invoke.mockResolvedValue({ data: null, error: httpErr(st, { erro: 'Forbidden' }) });
      const e = await enviarExtrato(arquivo, { id: 'c' }).catch((x) => x);
      expect(e).toBeInstanceOf(ErroEnvioExtrato);
      expect(e.classe).toBe('acesso');
      expect(e.message).toContain('permissão para importar extrato');
    }
  });

  it.each([400, 401, 403, 404, 422, 500])('%i: nunca remove o objeto do bucket (evidência, sem policy de DELETE)', async (st) => {
    upload.mockResolvedValue({ error: null });
    invoke.mockResolvedValue({
      data: null,
      error: httpErr(st, st === 422 ? { erro_parse: { motivo: 'data_invalida', detalhe: 'd' } } : { erro: 'x' }),
    });
    await expect(enviarExtrato(arquivo, { id: 'c' })).rejects.toBeInstanceOf(ErroEnvioExtrato);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('registrarAncoraManual', () => {
  it('chama banco_conta_registrar_ancora com os parâmetros certos e centavos inteiros', async () => {
    rpc.mockResolvedValue({ data: 'id-1', error: null });
    const id = await registrarAncoraManual('conta-1', '2026-11-19', -1234567);
    expect(rpc).toHaveBeenCalledWith('banco_conta_registrar_ancora', {
      p_banco_conta_id: 'conta-1',
      p_data: '2026-11-19',
      p_saldo_centavos: -1234567,
    });
    expect(id).toBe('id-1');
  });
  it('recusa centavos não inteiro/não finito sem chamar a RPC', async () => {
    await expect(registrarAncoraManual('c', '2026-11-19', 10.5)).rejects.toBeInstanceOf(ErroAncora);
    await expect(registrarAncoraManual('c', '2026-11-19', Number.NaN)).rejects.toBeInstanceOf(ErroAncora);
    expect(rpc).not.toHaveBeenCalled();
  });
  it.each([
    ['23514', 'divergente_arquivo', 'extrato já aceito'],
    ['23505', 'ja_existe', 'outro saldo'],
    ['22023', 'dia_aberto', 'ainda não fechou'],
    ['42501', 'sem_permissao', 'permissão'],
    ['P0002', 'conta', 'Conta'],
  ])('erro %s vira ErroAncora %s com texto próprio', async (code, classe, trecho) => {
    rpc.mockResolvedValue({ data: null, error: { code, message: 'banco_conta_registrar_ancora: x' } });
    const e = await registrarAncoraManual('c', '2026-11-19', 100).catch((x) => x);
    expect(e).toBeInstanceOf(ErroAncora);
    expect(e.classe).toBe(classe);
    expect(e.message).toContain(trecho);
  });
  it('erro desconhecido vira classe outro', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(registrarAncoraManual('c', '2026-11-19', 100)).rejects.toMatchObject({ classe: 'outro' });
  });
});

describe('listarAncoras', () => {
  it('lê banco_conta_ancora com ordem e limite explícitos e marca a origem', async () => {
    const chain: Record<string, unknown> = {};
    const calls: string[] = [];
    for (const m of ['select', 'eq', 'order', 'limit']) {
      chain[m] = (...a: unknown[]) => {
        calls.push(`${m}:${a.join(',')}`);
        return m === 'limit' ? Promise.resolve({ data: [
          { id: 'a1', data: '2026-11-19', saldo_final_dia_centavos: '150000', origem: 'manual', registrado_em: '2026-11-21T10:00:00Z' },
          { id: 'a2', data: '2026-11-18', saldo_final_dia_centavos: null, origem: 'cnab', registrado_em: '2026-11-20T10:00:00Z' },
        ], error: null }) : chain;
      };
    }
    from.mockReturnValue(chain);
    const r = await listarAncoras('conta-1');
    expect(from).toHaveBeenCalledWith('banco_conta_ancora');
    expect(calls.some((c) => c.startsWith('order:data'))).toBe(true);
    expect(calls.some((c) => c.startsWith('limit:'))).toBe(true);
    expect(calls).toContain('eq:banco_conta_id,conta-1');
    expect(r[0]).toMatchObject({ id: 'a1', origem: 'manual', saldo: 150000 });
    expect(r[1]).toMatchObject({ origem: 'cnab', saldo: null });
  });
});
