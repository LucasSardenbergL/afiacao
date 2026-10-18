import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gerarCarga } from './carga-fase-a';

const UID = '414a9727-ad1d-4998-914e-9c6ccf26cf50';
const DESTINOS = ['trocar', 'venda_dirigida', 'liquidar', 'manter_suspender_recompra', 'estrategico', 'erro_cadastro'];

function fixture(n = 17) {
  const decisoes = [];
  const itens = [];
  for (let i = 0; i < n; i++) {
    const sku = 1000 + i;
    decisoes.push({
      id: String(sku),
      decidido_em: '2026-10-15T08:39:39Z',
      decidido_por: 'u_artifact',
      destino: DESTINOS[i % 6],
    });
    itens.push({
      sku,
      codigo: `PRD${i}`,
      saldo: 10 + i,
      cmc: 2.5 + i,
      valor: (10 + i) * (2.5 + i),
      categoria: i === 0 ? "Tinta d'água" : 'Cat',
    });
  }
  return { decisoes, retrato: { meta: { hoje: '2026-10-15', gerado_em: 'x' }, itens } };
}

describe('gerarCarga', () => {
  it('17 docs -> 17 tuplas com foto do retrato e marcadores', () => {
    const { decisoes, retrato } = fixture();
    const { sql } = gerarCarga(decisoes, retrato, UID);
    const tuplas = sql.split('\n').filter((l) => l.startsWith('  ('));
    expect(tuplas).toHaveLength(17);
    expect(tuplas[0]).toBe(
      `  ('oben', 1000, 'trocar', '${UID}', '2026-10-15T08:39:39Z'::timestamptz, 10, 2.5, 25, 'Tinta d''água', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),`,
    );
    expect(tuplas[16].endsWith(')')).toBe(true);
    expect(sql.startsWith('begin;')).toBe(true);
    expect(sql).toContain('on conflict do nothing;');
    expect(sql).toContain("origem = 'artifact_fase_a'");
    expect(sql).toMatch(/<> 17 then/);
    expect(sql).toContain('commit;');
    expect(sql.trimEnd().split('\n').pop()).toBe('-- CARGA-FASE-A-OK');
    expect(sql).not.toContain('u_artifact');
  });

  it('tabela legível com totais por destino', () => {
    const { decisoes, retrato } = fixture(6);
    const { tabela } = gerarCarga(decisoes, retrato, UID);
    expect(tabela).toContain('PRD0');
    expect(tabela).toContain('TOTAL trocar');
    expect(tabela).toContain('TOTAL geral');
  });

  it('SKU ausente no retrato aborta', () => {
    const { decisoes, retrato } = fixture(3);
    retrato.itens.pop();
    expect(() => gerarCarga(decisoes, retrato, UID)).toThrow(/SKU_AUSENTE/);
  });

  it('destino fora dos 6 aborta', () => {
    const { decisoes, retrato } = fixture(3);
    decisoes[1].destino = 'descartar';
    expect(() => gerarCarga(decisoes, retrato, UID)).toThrow(/DESTINO_INVALIDO/);
  });

  it('cmc nulo, zero ou negativo aborta', () => {
    for (const cmc of [null, 0, -1]) {
      const { decisoes, retrato } = fixture(3);
      (retrato.itens[0] as { cmc: number | null }).cmc = cmc;
      expect(() => gerarCarga(decisoes, retrato, UID)).toThrow(/CMC_INVALIDO/);
    }
  });

  it('saldo e valor nulos abortam (nunca viram 0)', () => {
    const a = fixture(3);
    (a.retrato.itens[0] as { saldo: number | null }).saldo = null;
    expect(() => gerarCarga(a.decisoes, a.retrato, UID)).toThrow(/SALDO_INVALIDO/);
    const b = fixture(3);
    (b.retrato.itens[0] as { valor: number | null }).valor = null;
    expect(() => gerarCarga(b.decisoes, b.retrato, UID)).toThrow(/VALOR_INVALIDO/);
  });

  it('SKU duplicado, inválido e lista vazia abortam', () => {
    const a = fixture(3);
    a.decisoes[1].id = a.decisoes[0].id;
    expect(() => gerarCarga(a.decisoes, a.retrato, UID)).toThrow(/SKU_DUPLICADO/);
    const b = fixture(3);
    b.decisoes[0].id = 'abc';
    expect(() => gerarCarga(b.decisoes, b.retrato, UID)).toThrow(/SKU_INVALIDO/);
    expect(() => gerarCarga([], fixture(1).retrato, UID)).toThrow(/DECISOES_VAZIA/);
  });

  it('uid e decidido_em inválidos abortam', () => {
    const { decisoes, retrato } = fixture(2);
    expect(() => gerarCarga(decisoes, retrato, "x'; drop table t;--")).toThrow(/UID_INVALIDO/);
    decisoes[0].decidido_em = 'ontem';
    expect(() => gerarCarga(decisoes, retrato, UID)).toThrow(/DATA_INVALIDA/);
  });
});

describe('CLI de ponta a ponta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carga-fase-a-'));
  const script = join(process.cwd(), 'scripts/raio-x/carga-fase-a.ts');
  function rodar(decisoes: unknown, retrato: unknown) {
    const d = join(dir, 'd.json');
    const r = join(dir, 'r.json');
    writeFileSync(d, JSON.stringify(decisoes));
    writeFileSync(r, JSON.stringify(retrato));
    return spawnSync('bun', [script, '--decisoes', d, '--retrato', r, '--uid', UID], { encoding: 'utf8' });
  }

  it('sucesso: exit 0, marcador no stdout, tabela no stderr', () => {
    const { decisoes, retrato } = fixture(17);
    const res = rodar(decisoes, retrato);
    expect(res.status).toBe(0);
    expect(res.stdout.trimEnd().split('\n').pop()).toBe('-- CARGA-FASE-A-OK');
    expect(res.stderr).toContain('TOTAL geral');
  }, 30000);

  it('aborto: exit != 0, stdout vazio, marca no stderr', () => {
    const { decisoes, retrato } = fixture(3);
    retrato.itens.pop();
    const res = rodar(decisoes, retrato);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('SKU_AUSENTE');
  }, 30000);
});
