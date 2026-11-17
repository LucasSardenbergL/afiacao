import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Scanner Lovable, lote 6 — a rota `/catalogs` da edge tint-sync-agent copiava TODA propriedade do
// item para a linha de staging, e `created_at`/`id` decidem o "mais recente" da promoção e da purga.
// A semântica do conserto é provada EXECUTANDO o builder em `catalogo-staging_test.ts` (Deno); este
// teste fixa a FORMA do index.ts, que o Deno não exercita: a rota só delega ao módulo de lista
// fechada, conta a recusa como erro e não tem outro caminho de escrita para essas cinco tabelas.

const RAIZ = resolve(__dirname, '../..');
const INDEX = removerComentarios(
  readFileSync(resolve(RAIZ, 'supabase/functions/tint-sync-agent/index.ts'), 'utf8'),
);
const TABELAS_DO_BUILDER = [
  'tint_staging_produtos',
  'tint_staging_bases',
  'tint_staging_embalagens',
  'tint_staging_skus',
  'tint_staging_corantes',
];

function ramo(marcaInicio: string, marcaFim: string): string {
  const ini = INDEX.indexOf(marcaInicio);
  const fim = INDEX.indexOf(marcaFim, ini + 1);
  expect(ini, `início do ramo "${marcaInicio}" não encontrado`).toBeGreaterThan(-1);
  expect(fim, `fim do ramo "${marcaFim}" não encontrado`).toBeGreaterThan(ini);
  return INDEX.slice(ini, fim);
}

describe('tint-sync-agent /catalogs — linha de staging só pelo builder de lista fechada', () => {
  const catalogs = ramo('path === "catalogs"', 'path === "formulas"');

  it('o ramo monta as linhas com montarLinhasDeCatalogo, a partir do valor cru da entidade', () => {
    expect(catalogs).toContain('montarLinhasDeCatalogo(entityType, body[entityType], {');
    expect(catalogs).toContain('for (const entityType of ENTIDADES_COM_LINHA_DE_CATALOGO)');
  });

  it('o que vai ao insert são as linhas do builder, na tabela do builder', () => {
    expect(catalogs).toContain('bulkInsert(config.tabela, montado.linhas, 500,');
    expect(catalogs).toContain('const config = STAGING_DO_CATALOGO[entityType];');
  });

  it('o ramo não copia propriedade de item por nome dinâmico', () => {
    expect(catalogs).not.toContain('Object.entries(');
    expect(catalogs).not.toContain('Object.assign(');
    expect(catalogs).not.toContain('Object.keys(');
    expect(catalogs).not.toMatch(/\.\.\.\s*item\b/);
    expect(catalogs).not.toMatch(/\brow\[[^\]]+\]\s*=/);
    expect(catalogs).not.toMatch(/\bfor\s*\(\s*const\s+\w+\s+in\b/);
  });

  it('item recusado conta como erro da resposta — o conector só confirma o lote com error_count = 0', () => {
    expect(catalogs).toContain('errors += montado.recusados;');
    expect(catalogs).toContain('errorDetails.push({ entity_type: entityType, entity_id: null, message: motivo });');
    expect(catalogs).toContain('received += montado.recebidos;');
  });

  it('a forma do lote é conferida ANTES do teto de tamanho, do atalho do lote sem item e do run', () => {
    const iForma = catalogs.indexOf('erroDeFormaDoLoteDeCatalogo(body)');
    const iTeto = catalogs.indexOf('validateBatchSize(body');
    const iAtalho = catalogs.indexOf('itensGravaveis(body) === 0');
    const iRun = catalogs.indexOf('createSyncRun(agent, "catalogs")');
    expect(iForma).toBeGreaterThan(-1);
    expect(iTeto).toBeGreaterThan(iForma);
    expect(iAtalho).toBeGreaterThan(iTeto);
    expect(iRun).toBeGreaterThan(iAtalho);
    expect(catalogs).toContain('if (erroDeForma) return json({ ok: false, error: erroDeForma }, 400);');
  });

  it('a recusa confere se o registro gravou, e avisa no console quando não', () => {
    expect(catalogs).toContain('.catch(() => false);');
    expect(catalogs).toContain('if (!registrou) {');
    expect(INDEX).toMatch(/async function logError\([^)]*\): Promise<boolean> \{/);
    const corpoDoLog = INDEX.slice(INDEX.indexOf('async function logError('), INDEX.indexOf('function buildResponse('));
    expect(corpoDoLog).toContain('const { error } = await sb.from("tint_sync_errors").insert({');
    expect(corpoDoLog).toContain('return !error;');
  });

  it('a recusa fica em tint_sync_errors, esperada, e sem o item cru', () => {
    expect(catalogs).toContain(
      'await logError(runId, entityType, null, motivo, detalheDaRecusaDeCatalogo(entityType, montado))',
    );
    const recusa = catalogs.slice(catalogs.indexOf('if (montado.recusados > 0)'), catalogs.indexOf('bulkInsert(config.tabela'));
    expect(recusa).not.toMatch(/\b(body|item|itens|raw|linhas)\b/);
  });

  it('fora da simulação, as cinco tabelas do builder não têm outro escritor no index.ts', () => {
    const iniSim = INDEX.indexOf('path === "simulate"');
    const fimSim = INDEX.indexOf('path === "reconcile"', iniSim + 1);
    expect(iniSim).toBeGreaterThan(-1);
    expect(fimSim).toBeGreaterThan(iniSim);
    const semSimulacao = INDEX.slice(0, iniSim) + INDEX.slice(fimSim);
    for (const tabela of TABELAS_DO_BUILDER) {
      expect(semSimulacao, `${tabela} citada fora do builder e da simulação`).not.toContain(tabela);
    }
    // o único insert de staging com tabela literal neste ramo é o de precos_base, montado campo a campo
    const literais = [...catalogs.matchAll(/bulkInsert\("([a-z_]+)"/g)].map((m) => m[1]);
    expect(literais).toEqual(['tint_staging_precos_base']);
  });

  it('a simulação (JWT de staff) grava corante campo a campo, com dado do servidor', () => {
    const simulate = ramo('path === "simulate"', 'path === "reconcile"');
    expect(simulate).toContain('authorizeStaff()');
    // cada insert nas tabelas do builder é um objeto literal: sem spread e sem nome de coluna computado
    const inserts = [...simulate.matchAll(/sb\.from\("(tint_staging_[a-z_]+)"\)\.insert\(\{([\s\S]*?)\}\)/g)]
      .filter((m) => TABELAS_DO_BUILDER.includes(m[1]));
    expect(inserts.map((m) => m[1])).toEqual(['tint_staging_corantes', 'tint_staging_corantes']);
    for (const m of inserts) {
      expect(m[2], `insert de ${m[1]} com spread`).not.toContain('...');
      expect(m[2], `insert de ${m[1]} com coluna computada`).not.toMatch(/\[[^\]]+\]\s*:/);
      expect(m[2], `insert de ${m[1]} lendo o body`).not.toMatch(/\bbody\b/);
      expect(m[2], `insert de ${m[1]} escolhendo created_at/id`).not.toMatch(/\b(created_at|id|matched_id)\s*:/);
    }
  });

  it('o index.ts importa o builder e não guarda mais o tipo aberto do item', () => {
    expect(INDEX).toMatch(/import\s*\{[^}]*\bmontarLinhasDeCatalogo\b[^}]*\}\s*from\s*"\.\/catalogo-staging\.ts"/);
    expect(INDEX).not.toContain('TintCatalogItem');
    expect(INDEX).not.toContain('[k: string]: unknown;\n}\n\nfunction json');
  });
});

describe('tint-sync-agent /keys-snapshot — o generated_at não é escolha livre do emissor', () => {
  // Parente do conserto de /catalogs (2ª opinião do Codex, lote 6): `tint_apply_keys_snapshot` pula
  // todo snapshot com generated_at <= último aplicado, então um generated_at no futuro travava os
  // honestos. A semântica do validador é provada em `snapshot-gerado-em_test.ts` (Deno).
  const snapshot = ramo('path === "keys-snapshot"', 'path === "simulate"');

  it('o ramo valida o generated_at contra o relógio do servidor ANTES de gravar', () => {
    const iValida = snapshot.indexOf('validarGeradoEmDoSnapshot(generated_at, Date.now())');
    const iInsert = snapshot.indexOf('sb.from("tint_keys_snapshots").insert(');
    expect(iValida).toBeGreaterThan(-1);
    expect(iInsert).toBeGreaterThan(iValida);
    expect(snapshot).toContain('if (!geradoEm.ok) {');
    expect(snapshot).toContain('return json({ ok: false, error: geradoEm.erro }, 400);');
  });

  it('o que vai ao banco é o valor validado, nunca o generated_at cru', () => {
    const insert = snapshot.slice(
      snapshot.indexOf('sb.from("tint_keys_snapshots").insert('),
      snapshot.indexOf('insertErr.code'),
    );
    expect(insert).toContain('generated_at: geradoEm.geradoEm,');
    expect(insert).not.toMatch(/^\s*generated_at,\s*$/m);
    expect(insert).not.toMatch(/generated_at:\s*generated_at\b/);
    expect(insert).not.toContain('...');
  });

  it('o index.ts importa o validador do módulo puro', () => {
    expect(INDEX).toMatch(/import\s*\{\s*validarGeradoEmDoSnapshot\s*\}\s*from\s*"\.\/snapshot-gerado-em\.ts"/);
  });
});
