// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAVE_DICA_DASHBOARD,
  carregadorDaDica,
  carregarCustomerDashboard,
  carregarStaffDashboard,
  gravarDicaDashboard,
  lerDicaDashboard,
} from '@/pages/home/dashboards-home';

// Plano v5, lote 6b. A dica escolhe qual dashboard o prefetch de `/` baixa no boot.

beforeEach(() => localStorage.clear());

describe('dica do dashboard da home', () => {
  it('sem dica, ou com valor fora do contrato, nada é pré-carregado', () => {
    expect(carregadorDaDica()).toBeNull();
    for (const lixo of ['master', 'Staff', '', '../x', '{"a":1}']) {
      localStorage.setItem(CHAVE_DICA_DASHBOARD, lixo);
      expect(lerDicaDashboard()).toBeNull();
      expect(carregadorDaDica()).toBeNull();
    }
  });

  it('dica staff devolve o MESMO carregador que o Index passa ao lazyRota; dica cliente, o do cliente', () => {
    gravarDicaDashboard('staff');
    expect(carregadorDaDica()).toBe(carregarStaffDashboard);
    gravarDicaDashboard('cliente');
    expect(carregadorDaDica()).toBe(carregarCustomerDashboard);
  });

  it('gravar null remove a dica (a home redirecionou)', () => {
    gravarDicaDashboard('staff');
    gravarDicaDashboard(null);
    expect(localStorage.getItem(CHAVE_DICA_DASHBOARD)).toBeNull();
    expect(carregadorDaDica()).toBeNull();
  });

  it('storage que lança: sem dica e sem exceção', () => {
    const ler = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const gravar = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(carregadorDaDica()).toBeNull();
    expect(() => gravarDicaDashboard('staff')).not.toThrow();
    ler.mockRestore();
    gravar.mockRestore();
  });
});

describe('um carregador só por dashboard (render e prefetch chamam a mesma função)', () => {
  it('o Index usa lazyRota com os carregadores de dashboards-home, sem import próprio dos dashboards', () => {
    const index = readFileSync('src/pages/Index.tsx', 'utf8');
    expect(index).toMatch(/const StaffDashboard = lazyRota\(carregarStaffDashboard\);/);
    expect(index).toMatch(/const CustomerDashboard = lazyRota\(carregarCustomerDashboard\);/);
    expect(index).not.toMatch(/import\(/);
    expect(index).not.toMatch(/\blazy\(/);
  });

  it('a rota `/` do App.tsx pré-carrega junto o dashboard da dica', () => {
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app).toMatch(
      /const Index = lazyRota\(\(\) => import\("\.\/pages\/Index"\), \{ prefetchJunto: carregadorDaDica \}\);/,
    );
  });
});
