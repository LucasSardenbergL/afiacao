import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classificarLinhasRascunho,
  conferirCodigoNaLinha,
  decidirExecucaoRun,
  decidirLeituraEmbalagem,
  escolherGrupoSpike,
  parseBRL,
  podePersistirRun,
  type CapturaItemBruto,
} from './embalagem-captura-helpers';

// ---------------------------------------------------------------------------
// Paridade byte a byte com o espelho da edge (padrão cost-ladder): a edge
// importa supabase/functions/_shared/embalagem-captura-helpers.ts — que DEVE
// ser cópia idêntica deste módulo. Divergência = a regra testada aqui não é a
// que roda em produção.
// ---------------------------------------------------------------------------
describe('paridade src ↔ _shared', () => {
  it('espelho é byte a byte idêntico', () => {
    const src = readFileSync(join(__dirname, 'embalagem-captura-helpers.ts'), 'utf8');
    const espelho = readFileSync(
      join(__dirname, '../../../supabase/functions/_shared/embalagem-captura-helpers.ts'),
      'utf8',
    );
    expect(espelho).toBe(src);
  });
});

// ---------------------------------------------------------------------------
// classificarLinhasRascunho — decide auto-limpeza vs abort (rascunho humano).
// Também é interpolada via .toString() no código Browserless: precisa ser
// self-contained (sem template literal / símbolos externos).
// ---------------------------------------------------------------------------
describe('classificarLinhasRascunho', () => {
  const MAPA = ['WP01.3900QT', 'WP01.3900GL', 'WM16.3841.09GL'];

  it('todas as linhas do mapa → cancelável', () => {
    const r = classificarLinhasRascunho(
      ['1 WP01.3900QT SELADORA 74,43', '2 WM16.3841.09GL VERNIZ 306,49'],
      MAPA,
    );
    expect(r.cancelaveis).toBe(true);
    expect(r.desconhecidas).toEqual([]);
  });

  it('case-insensitive no texto da linha', () => {
    const r = classificarLinhasRascunho(['seq 1 wp01.3900qt seladora'], MAPA);
    expect(r.cancelaveis).toBe(true);
  });

  it('uma linha fora do mapa → NÃO cancelável e lista a desconhecida', () => {
    const r = classificarLinhasRascunho(
      ['1 WP01.3900QT SELADORA', '2 XX99.1234 ITEM DE HUMANO'],
      MAPA,
    );
    expect(r.cancelaveis).toBe(false);
    expect(r.desconhecidas).toEqual(['2 XX99.1234 ITEM DE HUMANO']);
  });

  it('linha vazia/whitespace → desconhecida (não dá pra provar que é nossa)', () => {
    expect(classificarLinhasRascunho(['   '], MAPA).cancelaveis).toBe(false);
    expect(classificarLinhasRascunho([''], MAPA).cancelaveis).toBe(false);
  });

  it('nenhuma linha → NÃO cancelável (defensivo: guard só roda com rows>0)', () => {
    expect(classificarLinhasRascunho([], MAPA).cancelaveis).toBe(false);
  });

  it('mapa vazio → nada é cancelável', () => {
    const r = classificarLinhasRascunho(['1 WP01.3900QT'], []);
    expect(r.cancelaveis).toBe(false);
  });

  it('desconhecida é truncada a 80 chars no relato', () => {
    const linhona = 'X'.repeat(300);
    const r = classificarLinhasRascunho([linhona], MAPA);
    expect(r.desconhecidas[0]).toHaveLength(80);
  });

  it('é self-contained para interpolação no Browserless (sem crase/${ no corpo)', () => {
    const codigo = classificarLinhasRascunho.toString();
    expect(codigo).not.toContain('`');
    expect(codigo).not.toContain('${');
  });
});

// ---------------------------------------------------------------------------
// Gates money-path (ausente ≠ zero; precisão > recall)
// ---------------------------------------------------------------------------
describe('podePersistirRun', () => {
  it('só persiste com rascunho comprovado limpo E todo item com cancel provado', () => {
    expect(podePersistirRun([{ cancelamento_ok: true }], 0).pode).toBe(true);
  });

  it('linhas_finais ≠ 0 → não persiste', () => {
    expect(podePersistirRun([{ cancelamento_ok: true }], 1).pode).toBe(false);
    expect(podePersistirRun([{ cancelamento_ok: true }], null).pode).toBe(false);
    expect(podePersistirRun([{ cancelamento_ok: true }], undefined).pode).toBe(false);
  });

  it('item sem prova de cancelamento → não persiste', () => {
    expect(podePersistirRun([{ cancelamento_ok: true }, {}], 0).pode).toBe(false);
  });
});

describe('parseBRL', () => {
  it('parseia formato BR', () => {
    expect(parseBRL('74,4348')).toBeCloseTo(74.4348, 4);
    expect(parseBRL('1.306,4977')).toBeCloseTo(1306.4977, 4);
  });

  it('ausente ≠ zero: vazio/inválido → null, nunca 0', () => {
    expect(parseBRL('')).toBeNull();
    expect(parseBRL('abc')).toBeNull();
  });
});

describe('decidirLeituraEmbalagem', () => {
  const base: CapturaItemBruto = {
    sku_portal: 'WP01.3900QT',
    achado: true,
    texto_linha_raw: '1 WP01.3900QT SELADORA 74,4348',
    preco_venda_raw: '74,4348',
    preco_un_raw: '',
    desconto_raw: '',
  };

  it('preço válido + código conferido → ok', () => {
    const r = decidirLeituraEmbalagem(base);
    expect(r.resultado).toBe('ok');
    expect(r.preco).toBeCloseTo(74.4348, 4);
  });

  it('preço 0 → falha (nunca fabrica zero)', () => {
    const r = decidirLeituraEmbalagem({ ...base, preco_venda_raw: '0,00' });
    expect(r.resultado).toBe('falha');
    expect(r.preco).toBeNull();
  });

  it('não achado (inativada) → nao_encontrado sem preço', () => {
    const r = decidirLeituraEmbalagem({ ...base, achado: false, preco_venda_raw: '' });
    expect(r.resultado).toBe('nao_encontrado');
    expect(r.preco).toBeNull();
  });
});

describe('decidirExecucaoRun / escolherGrupoSpike / conferirCodigoNaLinha', () => {
  it('já houve run ok no mês → sai cedo (idempotência mensal do cron)', () => {
    const d = decidirExecucaoRun(
      [{ status: 'ok', iniciado_em: '2026-07-10T09:00:00Z' }],
      '2026-07-11T09:00:00Z',
      'cron',
    );
    expect(d.executa).toBe(false);
  });

  it('disparo manual ignora o guard mensal', () => {
    const d = decidirExecucaoRun(
      [{ status: 'ok', iniciado_em: '2026-07-10T09:00:00Z' }],
      '2026-07-11T09:00:00Z',
      'manual',
    );
    expect(d.executa).toBe(true);
  });

  it('spike escolhe o grupo do menor sku_portal (determinístico)', () => {
    expect(
      escolherGrupoSpike([
        { grupo_id: 'g2', sku_portal: 'WP16.3841.09GL' },
        { grupo_id: 'g1', sku_portal: 'WP01.3900GL' },
      ]),
    ).toBe('g1');
  });

  it('conferirCodigoNaLinha exige o código esperado no texto', () => {
    expect(conferirCodigoNaLinha('1 WP01.3900QT SELADORA', 'WP01.3900QT')).toBe(true);
    expect(conferirCodigoNaLinha('1 WP01.3900GL SELADORA', 'WP01.3900QT')).toBe(false);
  });
});
