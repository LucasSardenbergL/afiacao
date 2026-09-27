/**
 * exportar.ts — lê PROD via `psql-ro` (sessão READ ONLY do wrapper; papel `claude_ro`) e grava os
 * datasets do backtest do Jev. Zero escrita no banco.
 *
 * Uso:  bun scripts/jev/exportar.ts [--saida scripts/jev/.dados]
 *
 * O wrapper sai 0 com ERROR quando lê de arquivo (docs/historico/psql-ro-exit-zero-em-sql-que-falhou.md):
 * por isso TODA chamada leva `-v ON_ERROR_STOP=1` E o veredito é o MARCADOR de fim na saída — exit 0
 * sem marcador é "não terminou", nunca "vazio".
 *
 * Saída (dados de catálogo/plano de contas, sem pessoa — LGPD ok; fica fora do git por .gitignore):
 *   boletim_sku.json · categoria_dre.json · meta.json (contagens medidas no momento do export)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseDoCodigo, montarTermosBusca, type SkuCandidato } from '@/lib/knowledge-base/code-normalize';
import {
  montarItemDre,
  montarItensBoletim,
  type DreLinha,
  type ItemBacktest,
  type SpecExportada,
} from './dados';

export const MARCADOR_FIM = 'FIM-OK-JEV-EXPORT';

/** Veredito pela SAÍDA: exige o marcador, recusa `ERROR:`, e exige ≥1 linha `JSON:`. */
export function extrairJsonDaSaida(saida: string): unknown[] {
  const linhas = saida.split('\n');
  const erro = linhas.find((l) => /^(ERROR|FATAL|psql:.*ERROR):?/.test(l.trim()));
  if (erro) throw new Error(`psql-ro devolveu ERROR: ${erro.trim().slice(0, 200)}`);
  if (!linhas.some((l) => l.trim() === MARCADOR_FIM)) {
    throw new Error(`sem o marcador de fim ${MARCADOR_FIM}: o SQL não terminou (exit 0 do wrapper não é sucesso)`);
  }
  const jsons = linhas.filter((l) => l.startsWith('JSON:')).map((l) => JSON.parse(l.slice('JSON:'.length)) as unknown);
  if (jsons.length === 0) throw new Error('nenhuma linha JSON: na saída (resultado ausente não é lista vazia)');
  return jsons;
}

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Réplica de `buscar_skus_candidatos` (prod; pré-voo por pg_get_functiondef em 2026-09-27) por spec. */
export function sqlCandidatos(alvos: ReadonlyArray<{ spec_id: string; termos: readonly string[] }>): string {
  if (alvos.length === 0) throw new Error('lista de specs vazia: VALUES vazio é erro de SQL, não "zero candidatos"');
  const valores = alvos
    .map((a) => `(${literal(a.spec_id)}::uuid, ARRAY[${a.termos.map(literal).join(', ')}]::text[])`)
    .join(',\n  ');
  const casa = `EXISTS (SELECT 1 FROM unnest(a.termos) t
          WHERE upper(op.descricao) LIKE '%' || replace(replace(replace(upper(t), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' ESCAPE '\\')`;
  return `WITH alvo(spec_id, termos) AS (VALUES
  ${valores}
)
SELECT 'JSON:' || coalesce(jsonb_agg(jsonb_build_object('spec_id', a.spec_id, 'n_total', n.n_total, 'candidatos', c.cands) ORDER BY a.spec_id)::text, '[]')
FROM alvo a
CROSS JOIN LATERAL (
  SELECT coalesce(jsonb_agg(jsonb_build_object('account', x.account, 'omie_codigo_produto', x.omie_codigo_produto,
         'codigo', x.codigo, 'descricao', x.descricao) ORDER BY x.account, x.descricao), '[]'::jsonb) AS cands
  FROM (
    SELECT op.account, op.omie_codigo_produto, op.codigo, op.descricao
    FROM public.omie_products op
    WHERE op.ativo IS NOT FALSE
      AND ${casa}
    ORDER BY op.account, op.descricao
    LIMIT 100
  ) x
) c
CROSS JOIN LATERAL (
  SELECT count(*) AS n_total FROM public.omie_products op WHERE op.ativo IS NOT FALSE AND ${casa}
) n;
SELECT '${MARCADOR_FIM}';
`;
}

const SQL_SPECS = `SELECT 'JSON:' || coalesce(jsonb_agg(jsonb_build_object(
  'spec_id', s.id, 'product_code', s.product_code, 'product_name', s.product_name,
  'doc_title', d.title, 'doc_texto', d.content_extracted) ORDER BY s.id)::text, '[]')
FROM public.kb_product_specs s JOIN public.kb_documents d ON d.id = s.document_id
WHERE s.approved_at IS NOT NULL AND d.content_extracted IS NOT NULL AND btrim(coalesce(s.product_code, '')) <> '';
SELECT '${MARCADOR_FIM}';
`;

const SQL_DRE = `SELECT 'JSON:' || coalesce(jsonb_agg(jsonb_build_object(
  'company', c.company, 'omie_codigo', c.omie_codigo, 'descricao', c.descricao,
  'seed_linha', m.dre_linha, 'seed_nota', m.notas) ORDER BY c.company, c.omie_codigo)::text, '[]')
FROM public.fin_categorias c
LEFT JOIN public.fin_categoria_dre_mapping m ON m.company = '_default' AND m.omie_codigo = c.omie_codigo
WHERE c.ativo IS NOT FALSE AND c.totalizadora IS NOT TRUE AND btrim(coalesce(c.descricao, '')) <> '';
SELECT '${MARCADOR_FIM}';
`;

/** Contagens que sustentam o relatório, medidas NO MOMENTO do export (não copiadas de doc). */
const SQL_META = `SELECT 'JSON:' || jsonb_build_object(
  'papel', current_user,
  'bypassrls', (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user),
  'a_vinculos_total', (SELECT count(*) FROM public.omie_product_spec_links),
  'a_vinculos_confirmados', (SELECT count(*) FROM public.omie_product_spec_links WHERE status = 'confirmed'),
  'a_vinculos_rejeitados', (SELECT count(*) FROM public.omie_product_spec_links WHERE status = 'rejected'),
  'a_specs_aprovadas', (SELECT count(*) FROM public.kb_product_specs WHERE approved_at IS NOT NULL),
  'a_docs_ready', (SELECT count(*) FROM public.kb_documents WHERE status = 'ready'),
  'b_manual_confirmado', (SELECT count(*) FROM public.promocao_item WHERE mapeamento_qualidade = 'manual_confirmado' AND confirmado),
  'b_manual_desc_igual_sku', (SELECT count(*) FROM public.promocao_item pi JOIN public.omie_products op ON op.omie_codigo_produto = pi.sku_codigo_omie
      WHERE pi.mapeamento_qualidade = 'manual_confirmado' AND pi.confirmado AND upper(btrim(pi.descricao_produto_fornecedor)) = upper(btrim(op.descricao))),
  'b_manual_codigo_sintetico', (SELECT count(*) FROM public.promocao_item WHERE mapeamento_qualidade = 'manual_confirmado' AND confirmado AND sku_codigo_fornecedor LIKE '%#omie%'),
  'b_nao_encontrado', (SELECT count(*) FROM public.promocao_item WHERE mapeamento_qualidade = 'nao_encontrado'),
  'c_mapa_total', (SELECT count(*) FROM public.fin_categoria_dre_mapping),
  'c_mapa_default', (SELECT count(*) FROM public.fin_categoria_dre_mapping WHERE company = '_default'),
  'c_mapa_instantes_distintos', (SELECT count(DISTINCT created_at) FROM public.fin_categoria_dre_mapping),
  'c_mapa_editados', (SELECT count(*) FROM public.fin_categoria_dre_mapping WHERE updated_at <> created_at)
)::text;
SELECT '${MARCADOR_FIM}';
`;

function rodarSql(sql: string, dirTmp: string, nome: string): unknown[] {
  const wrapper = process.env.PSQL_RO ?? join(homedir(), '.config/afiacao/psql-ro');
  const arquivo = join(dirTmp, `${nome}.sql`);
  writeFileSync(arquivo, sql);
  const r = spawnSync(wrapper, ['-v', 'ON_ERROR_STOP=1', '-At', '-f', arquivo], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw new Error(`não consegui executar o psql-ro (${wrapper}): ${r.error.message}`);
  const saida = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.status !== 0) throw new Error(`psql-ro saiu ${r.status} em ${nome}: ${(r.stderr ?? '').slice(0, 300)}`);
  return extrairJsonDaSaida(saida);
}

const PALAVRAS_VAZIAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'a', 'o', 'sobre', 'com', 'para', 'em']);
const palavras = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !PALAVRAS_VAZIAS.has(w))
    .map((w) => (w.endsWith('s') ? w.slice(0, -1) : w));

/** Nota do seed × nome real da categoria: compartilham ≥1 palavra significativa (singular, sem acento)? */
export function nomeConfere(notaSeed: string, nomeCategoria: string): boolean {
  const a = new Set(palavras(notaSeed));
  return palavras(nomeCategoria).some((w) => a.has(w));
}

interface LinhaDre {
  company: string;
  omie_codigo: string;
  descricao: string;
  seed_linha: DreLinha | null;
  seed_nota: string | null;
}

function main(): void {
  const i = process.argv.indexOf('--saida');
  const saida = i > 0 ? process.argv[i + 1] : join(import.meta.dirname, '.dados');
  mkdirSync(saida, { recursive: true });
  const dirTmp = mkdtempSync(join(tmpdir(), 'jev-export-'));
  try {
    const [meta] = rodarSql(SQL_META, dirTmp, 'meta') as [Record<string, unknown>];
    const [specs] = rodarSql(SQL_SPECS, dirTmp, 'specs') as [SpecExportada[]];
    const alvos = specs.map((s) => ({ spec_id: s.spec_id, termos: montarTermosBusca(s.product_code) }));
    const [cands] = rodarSql(sqlCandidatos(alvos), dirTmp, 'candidatos') as [
      Array<{ spec_id: string; n_total: number; candidatos: SkuCandidato[] }>,
    ];
    const porSpec = new Map(cands.map((c) => [c.spec_id, c]));

    const itensA: ItemBacktest[] = [];
    const recuperacao = { specs: specs.length, sem_candidato: 0, truncadas_no_limit100: 0, com_familia_exata: 0, residuo: 0 };
    for (const s of specs) {
      const c = porSpec.get(s.spec_id);
      if (!c) throw new Error(`spec ${s.spec_id} sem linha de candidatos (a consulta perdeu uma spec)`);
      if (c.n_total > 100) recuperacao.truncadas_no_limit100++;
      const itens = montarItensBoletim(s, c.candidatos);
      if (itens.length === 0) recuperacao.sem_candidato++;
      else if (itens[0].tipoGabarito === 'prata') recuperacao.com_familia_exata++;
      else recuperacao.residuo++;
      itensA.push(...itens);
    }

    const [cats] = rodarSql(SQL_DRE, dirTmp, 'dre') as [LinhaDre[]];
    const itensC = cats.map((c) => montarItemDre(c, c.seed_linha));
    const seedConfere = cats
      .filter((c) => c.seed_linha !== null)
      .map((c) => ({
        id: `c:${c.company}:${c.omie_codigo}`,
        seed_nota: c.seed_nota,
        nome_real: c.descricao,
        confere: nomeConfere(c.seed_nota ?? '', c.descricao),
      }));

    writeFileSync(join(saida, 'boletim_sku.json'), JSON.stringify(itensA, null, 1));
    writeFileSync(join(saida, 'categoria_dre.json'), JSON.stringify(itensC, null, 1));
    writeFileSync(
      join(saida, 'meta.json'),
      JSON.stringify(
        { exportado_em: new Date().toISOString(), contagens: meta, recuperacao_boletim: recuperacao, dre_seed_confere: seedConfere,
          bases_boletim: specs.map((s) => baseDoCodigo(s.product_code)).length },
        null, 1,
      ),
    );
    console.log(`boletim_sku: ${itensA.length} itens (${JSON.stringify(recuperacao)})`);
    console.log(`categoria_dre: ${itensC.length} itens (${seedConfere.length} com seed; ${seedConfere.filter((x) => x.confere).length} com nome que confere)`);
    console.log(`meta: ${JSON.stringify(meta)}`);
    console.log('EXPORT-JEV-OK');
  } finally {
    rmSync(dirTmp, { recursive: true, force: true });
  }
}

if (import.meta.main) main();
