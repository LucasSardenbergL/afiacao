import { describe, it, expect } from 'vitest';
import {
  impedimentoDoEnvio,
  lerPainelEmailSemanal,
  listaMunicipios,
  resumoUltimoEnvio,
  type UsuarioEmailSemanal,
} from '../radar-email-semanal';

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

  it('pacote E: território compartilhado e motivo do vazio; campos ausentes (front antes da migration) não quebram', () => {
    const p = lerPainelEmailSemanal(
      {
        cron: null,
        usuarios: [
          usuario({ territorio: [{ municipio: 'DIVINÓPOLIS', uf: 'MG', clientes: 2, compartilhado: true }] }),
          usuario({ user_id: 'u2', territorio: [], territorio_motivo: 'carteira_sem_municipio' }),
          usuario({ user_id: 'u3', territorio: [], territorio_motivo: 'codigo_do_futuro' }),
        ],
      },
      'x',
    );
    expect(p.usuarios.map((x) => [x.territorio[0]?.compartilhado ?? null, x.territorioMotivo])).toEqual([
      [true, null],
      [null, 'carteira_sem_municipio'],
      [null, null],
    ]);
    expect(lerPainelEmailSemanal({ cron: null, usuarios: [usuario()] }, 'x').usuarios[0].territorio[0].compartilhado).toBe(false);
    expect(() =>
      lerPainelEmailSemanal({ cron: null, usuarios: [usuario({ territorio: [{ municipio: 'A', clientes: 1, compartilhado: 'sim' }] })] }, 'rpc'),
    ).toThrow('rpc: resposta fora do formato (usuarios[0].territorio[0])');
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
    // Território vazio: a copy segue o motivo do banco (a antiga "Sem carteira com endereço" mentia para quem tem
    // carteira e é 2º em todas as cidades); sem motivo (front antes da migration), a genérica.
    expect(impedimentoDoEnvio(u({ territorio: [], territorioMotivo: 'sem_carteira' }))).toMatch(/^Sem carteira atribuída/);
    expect(impedimentoDoEnvio(u({ territorio: [], territorioMotivo: 'nao_e_vendedor' }))).toMatch(/^Sem papel de vendedor/);
    expect(impedimentoDoEnvio(u({ territorio: [], territorioMotivo: 'carteira_sem_municipio' }))).toMatch(
      /^Os clientes da carteira não têm endereço em um município do Radar/,
    );
    expect(impedimentoDoEnvio(u({ territorio: [], territorioMotivo: null }))).toMatch(/^Sem território: /);
    expect(impedimentoDoEnvio(u({ territorio: [] }))).toMatch(/Só sai e-mail se o gestor passar leads/);
    expect(impedimentoDoEnvio(u({ email: null }))).toMatch(/^Sem e-mail no cadastro/);
    expect(impedimentoDoEnvio(u({ email: null, modo: 'teste' }))).toBeNull();
  });

  it('lista de municípios e resumo do envio', () => {
    expect(listaMunicipios([])).toBe('—');
    expect(
      listaMunicipios([{ municipio: 'A', uf: 'MG', clientes: 1, compartilhado: false }, { municipio: 'B', uf: 'MG', clientes: 1, compartilhado: false }]),
    ).toBe('A e B');
    expect(listaMunicipios([{ municipio: 'A', uf: 'MG', clientes: 2, compartilhado: true }])).toBe(
      'A (sem município próprio: divide com o dono)',
    );
    expect(resumoUltimoEnvio(null)).toBe('Nenhum envio ainda');
    expect(
      resumoUltimoEnvio({ semana: '2026-11-02', ehTeste: false, nLeads: 5, elegiveis: 972, destinatario: 'r@x.com', status: 'pendente_notificacao' }),
    ).toBe('semana de 02/11 · 5 de 972 · real · na fila');
  });
});
