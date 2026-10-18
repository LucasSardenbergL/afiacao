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
      categoria: i === 0 ? 'Tinta água_2-x' : 'Cat',
    });
  }
  return { decisoes, retrato: { meta: { hoje: '2026-10-15', gerado_em: 'x' }, itens } };
}

// esperado = nº de decisões, salvo override (os testes de contagem passam outro).
const carga = (d: unknown[], r: unknown, uid = UID, n: number = d.length) => gerarCarga(d, r, uid, n);

describe('gerarCarga', () => {
  it('17 docs -> 17 tuplas com foto do retrato e marcadores', () => {
    const { decisoes, retrato } = fixture();
    const { sql } = carga(decisoes, retrato, UID);
    const tuplas = sql.split('\n').filter((l) => l.startsWith('  (\'oben\''));
    expect(tuplas).toHaveLength(34); // 17 no INSERT + 17 na CTE esperado (mesmo texto)
    expect(tuplas.slice(0, 17)).toEqual(tuplas.slice(17));
    expect(tuplas[0]).toBe(
      `  ('oben', 1000, 'trocar', '${UID}'::uuid, '2026-10-15T08:39:39.000Z'::timestamptz, 10::numeric, 2.5::numeric, 25::numeric, 'Tinta água_2-x', '2026-10-15 00:00 America/Sao_Paulo'::timestamptz, 'artifact_fase_a', false),`,
    );
    expect(sql).toContain('on conflict do nothing;');
    expect(sql).toMatch(/is distinct from 17 then/);
    expect(sql).not.toMatch(/^\s*(begin|commit|rollback|start transaction)\s*;/im);
    expect(sql.split('\n').some((l) => l.startsWith('\\'))).toBe(false);
    expect(sql.trimEnd().split('\n').pop()).toBe('-- CARGA-FASE-A-OK');
    expect(sql).not.toContain('u_artifact');
  });

  it('postcondição forte: join com a foto e as duas marcas', () => {
    const { decisoes, retrato } = fixture();
    const { sql } = carga(decisoes, retrato);
    expect(sql).toContain('join esperado e on d.empresa = e.empresa and d.sku_codigo_omie = e.sku');
    expect(sql).toContain("d.empresa = 'oben' and d.origem = 'artifact_fase_a'");
    for (const c of ['destino', 'decidido_por', 'decidido_em']) {
      expect(sql).toContain(`d.${c} is not distinct from e.${c}`);
    }
    for (const [c, e] of [['foto_saldo', 'saldo'], ['foto_cmc', 'cmc'], ['foto_valor', 'valor'], ['foto_categoria', 'categoria'], ['foto_em', 'foto_em']]) {
      expect(sql).toContain(`d.${c} is not distinct from e.${e}`);
    }
    expect(sql).toContain('POSTCONDICAO_TUPLAS');
    expect(sql).toContain('POSTCONDICAO_ORIGEM');
    expect(sql).toMatch(/where origem = 'artifact_fase_a';/);
    expect(sql).toContain('if v_exato is distinct from 17 then');
    expect(sql).toContain('if v_total is distinct from 17 then');
  });

  it('contagem esperada divergente aborta', () => {
    const { decisoes, retrato } = fixture(3);
    expect(() => carga(decisoes, retrato, UID, 17)).toThrow(/CONTAGEM_DIVERGENTE/);
    expect(() => carga(decisoes, retrato, UID, 2)).toThrow(/CONTAGEM_DIVERGENTE/);
  });

  it('categoria com barra/apóstrofo aborta (TEXTO_INVALIDO)', () => {
    for (const cat of ["a\\'b", "d'agua", 'a\\b', '']) {
      const { decisoes, retrato } = fixture(3);
      (retrato.itens[0] as { categoria: string }).categoria = cat;
      expect(() => carga(decisoes, retrato)).toThrow(/TEXTO_INVALIDO/);
    }
  });

  it('retrato com SKU duplicado aborta', () => {
    const { decisoes, retrato } = fixture(3);
    retrato.itens.push({ ...retrato.itens[0] });
    expect(() => carga(decisoes, retrato)).toThrow(/RETRATO_SKU_DUPLICADO/);
  });

  it('datas inexistentes abortam; ms preservados; sem ms normaliza', () => {
    const a = fixture(2);
    a.decisoes[0].decidido_em = '2026-02-30T10:00:00Z';
    expect(() => carga(a.decisoes, a.retrato)).toThrow(/DATA_INVALIDA/);
    const b = fixture(2);
    b.retrato.meta.hoje = '2026-02-30';
    expect(() => carga(b.decisoes, b.retrato)).toThrow(/HOJE_INVALIDO/);
    const c = fixture(2);
    c.decisoes[0].decidido_em = '2026-10-15T08:39:55.770Z';
    expect(carga(c.decisoes, c.retrato).sql).toContain("'2026-10-15T08:39:55.770Z'::timestamptz");
  });

  it('tabela legível com totais por destino', () => {
    const { decisoes, retrato } = fixture(6);
    const { tabela } = carga(decisoes, retrato, UID);
    expect(tabela).toContain('PRD0');
    expect(tabela).toContain('TOTAL trocar');
    expect(tabela).toContain('TOTAL geral');
  });

  it('SKU ausente no retrato aborta', () => {
    const { decisoes, retrato } = fixture(3);
    retrato.itens.pop();
    expect(() => carga(decisoes, retrato, UID)).toThrow(/SKU_AUSENTE/);
  });

  it('destino fora dos 6 aborta', () => {
    const { decisoes, retrato } = fixture(3);
    decisoes[1].destino = 'descartar';
    expect(() => carga(decisoes, retrato, UID)).toThrow(/DESTINO_INVALIDO/);
  });

  it('cmc nulo, zero ou negativo aborta', () => {
    for (const cmc of [null, 0, -1]) {
      const { decisoes, retrato } = fixture(3);
      (retrato.itens[0] as { cmc: number | null }).cmc = cmc;
      expect(() => carga(decisoes, retrato, UID)).toThrow(/CMC_INVALIDO/);
    }
  });

  it('saldo e valor nulos abortam (nunca viram 0)', () => {
    const a = fixture(3);
    (a.retrato.itens[0] as { saldo: number | null }).saldo = null;
    expect(() => carga(a.decisoes, a.retrato, UID)).toThrow(/SALDO_INVALIDO/);
    const b = fixture(3);
    (b.retrato.itens[0] as { valor: number | null }).valor = null;
    expect(() => carga(b.decisoes, b.retrato, UID)).toThrow(/VALOR_INVALIDO/);
  });

  it('SKU duplicado, inválido e lista vazia abortam', () => {
    const a = fixture(3);
    a.decisoes[1].id = a.decisoes[0].id;
    expect(() => carga(a.decisoes, a.retrato, UID)).toThrow(/SKU_DUPLICADO/);
    const b = fixture(3);
    b.decisoes[0].id = 'abc';
    expect(() => carga(b.decisoes, b.retrato, UID)).toThrow(/SKU_INVALIDO/);
    expect(() => carga([], fixture(1).retrato, UID, 1)).toThrow(/DECISOES_VAZIA/);
  });

  it('uid e decidido_em inválidos abortam', () => {
    const { decisoes, retrato } = fixture(2);
    expect(() => carga(decisoes, retrato, "x'; drop table t;--")).toThrow(/UID_INVALIDO/);
    decisoes[0].decidido_em = 'ontem';
    expect(() => carga(decisoes, retrato, UID)).toThrow(/DATA_INVALIDA/);
  });
});

describe('CLI de ponta a ponta', () => {
  const dir = mkdtempSync(join(tmpdir(), 'carga-fase-a-'));
  const script = join(process.cwd(), 'scripts/raio-x/carga-fase-a.ts');
  function rodar(decisoes: unknown, retrato: unknown, extra: string[] = ['--esperado', String((decisoes as unknown[]).length)]) {
    const d = join(dir, 'd.json');
    const r = join(dir, 'r.json');
    writeFileSync(d, JSON.stringify(decisoes));
    writeFileSync(r, JSON.stringify(retrato));
    return spawnSync('bun', [script, '--decisoes', d, '--retrato', r, '--uid', UID, ...extra], { encoding: 'utf8' });
  }

  it('sucesso: exit 0, marcador no stdout, tabela no stderr', () => {
    const { decisoes, retrato } = fixture(17);
    const res = rodar(decisoes, retrato);
    expect(res.status).toBe(0);
    expect(res.stdout.trimEnd().split('\n').pop()).toBe('-- CARGA-FASE-A-OK');
    expect(res.stderr).toContain('TOTAL geral');
  }, 30000);

  it('sem --esperado: exit != 0 e stdout vazio', () => {
    const { decisoes, retrato } = fixture(3);
    const res = rodar(decisoes, retrato, []);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('--esperado');
  }, 30000);

  it('--esperado divergente: exit != 0 e stdout vazio', () => {
    const { decisoes, retrato } = fixture(3);
    const res = rodar(decisoes, retrato, ['--esperado', '17']);
    expect(res.status).not.toBe(0);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('CONTAGEM_DIVERGENTE');
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
