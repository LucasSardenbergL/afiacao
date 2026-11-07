import { describe, it, expect } from 'vitest';
import {
  impedimentoDoEnvio,
  lerPainelEmailSemanal,
  listaMunicipios,
  resumoUltimoEnvio,
  type UsuarioEmailSemanal,
} from '../email-semanal';

const usuario = (extra: Record<string, unknown> = {}) => ({
  user_id: 'u1', nome: 'Regina', email: 'regina@exemplo.com', papel: 'employee', papel_comercial: 'farmer',
  acesso_radar: true, modo: 'ligado', email_teste: null, atualizado_em: null,
  territorio: [{ municipio: 'DIVINÓPOLIS', uf: 'MG', clientes: 358 }], ultimo_envio: null, ...extra,
});

describe('lerPainelEmailSemanal', () => {
  it('lê cron e usuários', () => {
    const p = lerPainelEmailSemanal({ cron: { ativo: true, agenda: '0 11 * * 1' }, usuarios: [usuario()] }, 'x');
    expect(p.cron).toEqual({ ativo: true, agenda: '0 11 * * 1' });
    expect(p.usuarios[0]).toMatchObject({ userId: 'u1', modo: 'ligado', acessoRadar: true, ultimoEnvio: null });
  });

  it('cron null é "não existe" (≠ desligado)', () => {
    expect(lerPainelEmailSemanal({ cron: null, usuarios: [] }, 'x').cron).toBeNull();
  });

  it('formato fora do contrato LANÇA, nunca vira lista vazia ou "desligado"', () => {
    expect(() => lerPainelEmailSemanal(null, 'rpc')).toThrow('rpc: resposta fora do formato (usuarios)');
    expect(() => lerPainelEmailSemanal({ cron: null, usuarios: [usuario({ modo: 'talvez' })] }, 'rpc')).toThrow(
      'rpc: resposta fora do formato (usuarios[0])',
    );
    expect(() => lerPainelEmailSemanal({ cron: { ativo: 'sim' }, usuarios: [] }, 'rpc')).toThrow(
      'rpc: resposta fora do formato (cron)',
    );
    expect(() =>
      lerPainelEmailSemanal({ cron: null, usuarios: [usuario({ acesso_radar: null })] }, 'rpc'),
    ).toThrow('rpc: resposta fora do formato (usuarios[0])');
    expect(() =>
      lerPainelEmailSemanal({ cron: null, usuarios: [usuario({ ultimo_envio: { semana: '2026-11-02' } })] }, 'rpc'),
    ).toThrow('rpc: resposta fora do formato (usuarios[0].ultimo_envio)');
  });
});

describe('textos da tela', () => {
  const u = (extra: Partial<UsuarioEmailSemanal>): UsuarioEmailSemanal => ({
    ...lerPainelEmailSemanal({ cron: null, usuarios: [usuario()] }, 'x').usuarios[0],
    ...extra,
  });

  it('impedimento: o mesmo motivo com que o envio pularia a pessoa', () => {
    expect(impedimentoDoEnvio(u({}))).toBeNull();
    expect(impedimentoDoEnvio(u({ acessoRadar: false }))).toBe('Sem acesso ao Radar: o e-mail seria pulado.');
    expect(impedimentoDoEnvio(u({ territorio: [] }))).toMatch(/^Sem carteira com endereço/);
    expect(impedimentoDoEnvio(u({ email: null }))).toMatch(/^Sem e-mail no cadastro/);
    expect(impedimentoDoEnvio(u({ email: null, modo: 'teste' }))).toBeNull();
  });

  it('lista de municípios e resumo do envio', () => {
    expect(listaMunicipios([])).toBe('—');
    expect(listaMunicipios([{ municipio: 'A', uf: 'MG', clientes: 1 }, { municipio: 'B', uf: 'MG', clientes: 1 }])).toBe('A e B');
    expect(resumoUltimoEnvio(null)).toBe('Nenhum envio ainda');
    expect(
      resumoUltimoEnvio({ semana: '2026-11-02', ehTeste: false, nLeads: 5, elegiveis: 972, destinatario: 'r@x.com', status: 'pendente_notificacao' }),
    ).toBe('semana de 02/11 · 5 de 972 · real · na fila');
  });
});
