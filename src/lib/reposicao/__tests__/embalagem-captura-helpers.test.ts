// Testes do helper puro da captura mensal de preços Sayerlack (Fase 1).
// Spec: docs/superpowers/specs/2026-07-14-sayerlack-captura-preco-embalagem-design.md
// Invariantes money-path sob teste: ausente ≠ zero (preço nunca fabricado),
// guard mensal idempotente por mês de São Paulo (não UTC), lock de run ativo.
import { describe, it, expect } from 'vitest';
import {
  parseBRL,
  parsePercentBR,
  decidirLeituraEmbalagem,
  decidirExecucaoRun,
  resumirRun,
  montarInsertPreco,
  escolherGrupoSpike,
  diaSaoPaulo,
  mesSaoPaulo,
  TOLERANCIA_CROSSCHECK,
  RUN_ATIVO_JANELA_MIN,
  type CapturaItemBruto,
  type LeituraEmbalagem,
  type RunResumo,
} from '../embalagem-captura-helpers';

// ---------------------------------------------------------------------------
// parseBRL (duplicado de sayerlack-scraping-pedido.ts p/ o helper ser
// self-contained — paridade byte-a-byte com o espelho da edge)
// ---------------------------------------------------------------------------
describe('parseBRL', () => {
  it('parseia decimal pt-BR com vírgula', () => {
    expect(parseBRL('306,4977')).toBe(306.4977);
  });
  it('parseia milhar com ponto', () => {
    expect(parseBRL('1.234,56')).toBe(1234.56);
  });
  it('ignora símbolo de moeda e espaços', () => {
    expect(parseBRL(' R$ 74,4348 ')).toBe(74.4348);
  });
  it('vazio/ilegível → null (nunca 0 fabricado)', () => {
    expect(parseBRL('')).toBeNull();
    expect(parseBRL('abc')).toBeNull();
  });
});

describe('parsePercentBR', () => {
  it('parseia percentual pt-BR em pontos percentuais', () => {
    expect(parsePercentBR('13,8678')).toBe(13.8678);
  });
  it('tolera sufixo % e espaços', () => {
    expect(parsePercentBR(' 31,0942 % ')).toBe(31.0942);
  });
  it('ilegível → null', () => {
    expect(parsePercentBR('')).toBeNull();
    expect(parsePercentBR('n/d')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decidirLeituraEmbalagem — qualidade da LEITURA de UMA embalagem.
// fonte reflete a leitura da linha ('ok' inequívoca | 'parcial' degradada);
// a parcialidade do RUN vive no run-log, não aqui.
// ---------------------------------------------------------------------------
describe('decidirLeituraEmbalagem', () => {
  const base: CapturaItemBruto = {
    sku_portal: 'WP01.3900QT',
    achado: true,
    preco_venda_raw: '74,4348',
    preco_un_raw: '86,4167', // 74,4348 / (1 − 0,138678)
    desconto_raw: '13,8678',
  };

  it('não achado no select2 → nao_encontrado sem preço', () => {
    const r = decidirLeituraEmbalagem({ sku_portal: 'WP53.3900GL', achado: false, motivo_nao_achado: 'nenhum_resultado_select2' });
    expect(r.resultado).toBe('nao_encontrado');
    expect(r.preco).toBeNull();
    expect(r.fonte).toBeNull();
    expect(r.detalhe).toContain('nenhum_resultado_select2');
  });

  it('preço-venda legível + cross-check Preço UN×(1−desc) fecha → ok inequívoco', () => {
    const r = decidirLeituraEmbalagem(base);
    expect(r.resultado).toBe('ok');
    expect(r.preco).toBe(74.4348);
    expect(r.fonte).toBe('portal_capturado_ok');
  });

  it('cross-check diverge além da tolerância → parcial mantendo o preço-venda lido', () => {
    const r = decidirLeituraEmbalagem({ ...base, preco_un_raw: '90,00', desconto_raw: '10' });
    expect(r.resultado).toBe('ok'); // preço capturado, leitura degradada
    expect(r.preco).toBe(74.4348);
    expect(r.fonte).toBe('portal_capturado_parcial');
    expect(r.detalhe).toMatch(/diverg/i);
  });

  it('preço-venda ilegível mas Preço UN×(1−desc) deriváveis → parcial com preço derivado', () => {
    const r = decidirLeituraEmbalagem({ ...base, preco_venda_raw: '', preco_un_raw: '100,00', desconto_raw: '20' });
    expect(r.resultado).toBe('ok');
    expect(r.preco).toBe(80);
    expect(r.fonte).toBe('portal_capturado_parcial');
    expect(r.detalhe).toMatch(/derivado/i);
  });

  it('preço-venda legível sem cross-check disponível → parcial (leitura sem contraprova)', () => {
    const r = decidirLeituraEmbalagem({ ...base, desconto_raw: '' });
    expect(r.resultado).toBe('ok');
    expect(r.preco).toBe(74.4348);
    expect(r.fonte).toBe('portal_capturado_parcial');
  });

  it('nenhuma célula de preço legível → falha sem preço (ausente ≠ zero)', () => {
    const r = decidirLeituraEmbalagem({ ...base, preco_venda_raw: '', preco_un_raw: '', desconto_raw: '' });
    expect(r.resultado).toBe('falha');
    expect(r.preco).toBeNull();
    expect(r.fonte).toBeNull();
  });

  it('preço-venda "0,00" NUNCA vira preço 0 (invariante money-path)', () => {
    const r = decidirLeituraEmbalagem({ ...base, preco_venda_raw: '0,00', preco_un_raw: '', desconto_raw: '' });
    expect(r.resultado).toBe('falha');
    expect(r.preco).toBeNull();
  });

  it('desconto fora do range [0,100) invalida o cross-check mas não o preço-venda', () => {
    const r = decidirLeituraEmbalagem({ ...base, desconto_raw: '150' });
    expect(r.resultado).toBe('ok');
    expect(r.preco).toBe(74.4348);
    expect(r.fonte).toBe('portal_capturado_parcial');
  });

  it('linha em edição de OUTRO item (codigo_confere=false) → falha fail-closed, preço NUNCA gravado', () => {
    // o select2 seleciona a primeira option; se o portal devolver outro produto,
    // o preço seria plausível-mas-errado — precisão > recall: não grava.
    const r = decidirLeituraEmbalagem({ ...base, codigo_confere: false });
    expect(r.resultado).toBe('falha');
    expect(r.preco).toBeNull();
    expect(r.fonte).toBeNull();
    expect(r.detalhe).toMatch(/não confere/i);
  });

  it('codigo_confere=true ou ausente (compat) não muda a decisão', () => {
    expect(decidirLeituraEmbalagem({ ...base, codigo_confere: true }).resultado).toBe('ok');
    expect(decidirLeituraEmbalagem(base).resultado).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// decidirExecucaoRun — guard mensal idempotente + lock + circuit-breaker
// ---------------------------------------------------------------------------
describe('decidirExecucaoRun', () => {
  const AGORA = '2026-08-10T09:00:00.000Z'; // 06:00 BRT do dia 10
  const run = (status: RunResumo['status'], iniciado_em: string): RunResumo => ({ status, iniciado_em });

  it('sem runs → executa', () => {
    expect(decidirExecucaoRun([], AGORA, 'cron')).toEqual({ executa: true });
  });

  it('run running recente barra qualquer disparo (lock)', () => {
    const runs = [run('running', '2026-08-10T08:55:00.000Z')]; // 5min atrás
    expect(decidirExecucaoRun(runs, AGORA, 'cron')).toEqual({ executa: false, motivo: 'run_ativo' });
    expect(decidirExecucaoRun(runs, AGORA, 'manual')).toEqual({ executa: false, motivo: 'run_ativo' });
  });

  it('run running órfão (mais velho que a janela) não barra', () => {
    const runs = [run('running', '2026-08-10T08:00:00.000Z')]; // 60min atrás
    expect(decidirExecucaoRun(runs, AGORA, 'cron')).toEqual({ executa: true });
  });

  it('cron: run ok no mesmo mês (São Paulo) → sai cedo idempotente', () => {
    const runs = [run('ok', '2026-08-10T09:05:00.000Z')]; // dia 10, run do próprio cron de ontem... mesmo mês
    expect(decidirExecucaoRun(runs, '2026-08-11T09:00:00.000Z', 'cron')).toEqual({ executa: false, motivo: 'ja_ok_no_mes' });
  });

  it('cron: run ok do mês anterior não barra', () => {
    const runs = [run('ok', '2026-07-10T09:05:00.000Z')];
    expect(decidirExecucaoRun(runs, AGORA, 'cron')).toEqual({ executa: true });
  });

  it('fronteira de timezone: run em 01/08 01:00 UTC é 31/07 em São Paulo → não barra o cron de agosto', () => {
    const runs = [run('ok', '2026-08-01T01:00:00.000Z')]; // 31/07 22:00 BRT
    expect(decidirExecucaoRun(runs, AGORA, 'cron')).toEqual({ executa: true });
  });

  it('cron: run parcial no mês NÃO barra (auto-retry dias 11/12)', () => {
    const runs = [run('parcial', '2026-08-10T09:05:00.000Z')];
    expect(decidirExecucaoRun(runs, '2026-08-11T09:00:00.000Z', 'cron')).toEqual({ executa: true });
  });

  it('cron: run falha no mesmo dia (São Paulo) → circuit-breaker do dia', () => {
    const runs = [run('falha', '2026-08-10T06:00:00.000Z')];
    expect(decidirExecucaoRun(runs, AGORA, 'cron')).toEqual({ executa: false, motivo: 'circuit_breaker_dia' });
  });

  it('cron: run falha de ontem não barra (auto-retry)', () => {
    const runs = [run('falha', '2026-08-09T09:00:00.000Z')];
    expect(decidirExecucaoRun(runs, '2026-08-10T09:00:00.000Z', 'cron')).toEqual({ executa: true });
  });

  it('manual: ignora guard mensal e circuit-breaker (staff decide)', () => {
    const runs = [run('ok', '2026-08-10T06:00:00.000Z'), run('falha', '2026-08-10T07:00:00.000Z')];
    expect(decidirExecucaoRun(runs, AGORA, 'manual')).toEqual({ executa: true });
  });

  it('reajuste: não respeita guard mensal (o ponto é recapturar fora da janela) mas respeita o circuit-breaker', () => {
    expect(decidirExecucaoRun([run('ok', '2026-08-05T09:00:00.000Z')], AGORA, 'reajuste')).toEqual({ executa: true });
    expect(decidirExecucaoRun([run('falha', '2026-08-10T06:00:00.000Z')], AGORA, 'reajuste')).toEqual({ executa: false, motivo: 'circuit_breaker_dia' });
  });
});

describe('diaSaoPaulo / mesSaoPaulo', () => {
  it('converte UTC → data civil de São Paulo', () => {
    expect(diaSaoPaulo('2026-08-01T01:00:00.000Z')).toBe('2026-07-31');
    expect(mesSaoPaulo('2026-08-01T01:00:00.000Z')).toBe('2026-07');
    expect(diaSaoPaulo('2026-08-10T09:00:00.000Z')).toBe('2026-08-10');
  });
  it('timestamp ilegível → string vazia (não lança)', () => {
    expect(diaSaoPaulo('lixo')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// resumirRun — status do RUN (a parcialidade do run vive aqui, não na fonte)
// ---------------------------------------------------------------------------
describe('resumirRun', () => {
  const ok = (sku: string): LeituraEmbalagem => ({ sku_portal: sku, resultado: 'ok', preco: 10, fonte: 'portal_capturado_ok', detalhe: null });
  const okParcial = (sku: string): LeituraEmbalagem => ({ sku_portal: sku, resultado: 'ok', preco: 10, fonte: 'portal_capturado_parcial', detalhe: 'x' });
  const naoEnc = (sku: string): LeituraEmbalagem => ({ sku_portal: sku, resultado: 'nao_encontrado', preco: null, fonte: null, detalhe: null });
  const falha = (sku: string): LeituraEmbalagem => ({ sku_portal: sku, resultado: 'falha', preco: null, fonte: null, detalhe: 'y' });

  it('todas ok inequívocas → run ok', () => {
    expect(resumirRun([ok('A'), ok('B')])).toEqual({ status: 'ok', total_ok: 2, total_nao_encontrado: 0, total_falha: 0 });
  });
  it('embalagem inativada não derruba o run → parcial', () => {
    expect(resumirRun([ok('A'), naoEnc('B')])).toEqual({ status: 'parcial', total_ok: 1, total_nao_encontrado: 1, total_falha: 0 });
  });
  it('leitura degradada (fonte parcial) rebaixa o run a parcial (cron re-tenta no dia seguinte)', () => {
    expect(resumirRun([ok('A'), okParcial('B')]).status).toBe('parcial');
  });
  it('nenhum preço capturado → falha', () => {
    expect(resumirRun([falha('A'), naoEnc('B')]).status).toBe('falha');
    expect(resumirRun([]).status).toBe('falha');
  });
});

// ---------------------------------------------------------------------------
// montarInsertPreco — linha p/ sku_preco_fornecedor_capturado (ou null)
// ---------------------------------------------------------------------------
describe('montarInsertPreco', () => {
  const ctx = { empresa: 'OBEN', skuCodigoOmie: '8689775044', runId: 'run-123' };

  it('leitura ok → linha completa consistente com o dialog manual (empresa minúscula)', () => {
    const l: LeituraEmbalagem = { sku_portal: 'WP01.3900QT', resultado: 'ok', preco: 74.4348, fonte: 'portal_capturado_ok', detalhe: null };
    expect(montarInsertPreco(l, ctx)).toEqual({
      empresa: 'oben',
      sku_codigo_omie: '8689775044',
      fornecedor_nome: 'Sayerlack',
      preco: 74.4348,
      moeda: 'BRL',
      preco_tipo: 'liquido',
      fonte: 'portal_capturado_ok',
      status: 'ok',
      run_id: 'run-123',
      observacao: null,
      criado_por: 'edge:sayerlack-captura-precos',
    });
  });

  it('leitura parcial → observacao carrega o detalhe', () => {
    const l: LeituraEmbalagem = { sku_portal: 'WP01.3900GL', resultado: 'ok', preco: 306.4977, fonte: 'portal_capturado_parcial', detalhe: 'cross-check divergente 8%' };
    const row = montarInsertPreco(l, ctx);
    expect(row?.fonte).toBe('portal_capturado_parcial');
    expect(row?.observacao).toBe('cross-check divergente 8%');
  });

  it('nao_encontrado/falha → null (linha sem preço NÃO existe na tabela de preço)', () => {
    expect(montarInsertPreco({ sku_portal: 'X', resultado: 'nao_encontrado', preco: null, fonte: null, detalhe: null }, ctx)).toBeNull();
    expect(montarInsertPreco({ sku_portal: 'X', resultado: 'falha', preco: null, fonte: null, detalhe: null }, ctx)).toBeNull();
  });

  it('preço não-finito ou ≤0 nunca vira linha (guard de fronteira)', () => {
    expect(montarInsertPreco({ sku_portal: 'X', resultado: 'ok', preco: 0, fonte: 'portal_capturado_ok', detalhe: null }, ctx)).toBeNull();
    expect(montarInsertPreco({ sku_portal: 'X', resultado: 'ok', preco: Number.NaN, fonte: 'portal_capturado_ok', detalhe: null }, ctx)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// escolherGrupoSpike — modo spike captura 1 grupo, determinístico
// ---------------------------------------------------------------------------
describe('escolherGrupoSpike', () => {
  it('escolhe o grupo do menor sku_portal (WP01 antes dos demais)', () => {
    const pares = [
      { grupo_id: 'g-87', sku_portal: 'WP87.3900QT' },
      { grupo_id: 'g-01', sku_portal: 'WP01.3900GL' },
      { grupo_id: 'g-01', sku_portal: 'WP01.3900QT' },
      { grupo_id: 'g-02', sku_portal: 'WP02.3900QT' },
    ];
    expect(escolherGrupoSpike(pares)).toBe('g-01');
  });
  it('lista vazia → null', () => {
    expect(escolherGrupoSpike([])).toBeNull();
  });
});

// Constantes exportadas fazem parte do contrato (a edge as usa no trace)
describe('constantes', () => {
  it('tolerância do cross-check é 0,5%', () => {
    expect(TOLERANCIA_CROSSCHECK).toBe(0.005);
  });
  it('janela do lock de run ativo é 20 min', () => {
    expect(RUN_ATIVO_JANELA_MIN).toBe(20);
  });
});
