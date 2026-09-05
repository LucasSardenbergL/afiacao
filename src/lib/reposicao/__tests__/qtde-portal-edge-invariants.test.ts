import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Gate de FORMA da edge `enviar-pedido-portal-sayerlack` para os 3 achados do challenge Codex de 2026-09-05
// (a 4ª perna do CI de edge — docs/historico/ci-testes-edge-deno.md: o vitest não RODA a edge, ele a LÊ).
// A lógica pura vive em src/lib/reposicao/qtde-portal.ts (vitest) e está ESPELHADA verbatim na edge (Deno não
// importa de src/). O que este arquivo defende: (1) a cópia da edge é IDÊNTICA à fonte (pega reescrita do
// Lovable no deploy); (2) a edge USA o produto dos helpers no caminho vivo — "define e chama" não basta
// (money-path.md §"Helper espelhado"); (3) a chave de fornecedor é a EXATA do pedido, não ILIKE.
const ROOT = process.cwd();
const EDGE_DIR = 'supabase/functions/enviar-pedido-portal-sayerlack';
const ler = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

// Mesma normalização de src/__tests__/edge-money-path-invariants.test.ts (remove `export `, comentários, whitespace).
function mirrorBlock(s: string, label: string): string {
  const re = new RegExp(`// MIRROR-START ${label}[^\\n]*\\n([\\s\\S]*?)\\n[^\\n]*// MIRROR-END`);
  const m = s.match(re);
  if (!m) throw new Error(`bloco // MIRROR-START ${label}.../END não encontrado`);
  return m[1]
    .replace(/\bexport\s+/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('//'))
    .join('\n');
}

describe('qtde-portal: PARIDADE src × edge', () => {
  it('o bloco MIRROR da edge é IDÊNTICO ao de src/lib/reposicao/qtde-portal.ts', () => {
    const src = mirrorBlock(ler('src/lib/reposicao/qtde-portal.ts'), 'qtde-portal');
    const edge = mirrorBlock(ler(`${EDGE_DIR}/qtde-portal.ts`), 'qtde-portal');
    expect(edge).toBe(src);
    // o bloco cobre TUDO que a edge importa do helper — um símbolo fora do bloco escapa da paridade
    for (const sym of ['FATOR_MAX', 'qtdePortal', 'qtdeFisicaOmie', 'verificarFatorAprovado', 'indexarMapeamentos']) {
      expect(edge, `${sym} fora do bloco espelhado`).toContain(sym);
    }
  });
});

describe('enviar-pedido-portal-sayerlack: a edge USA os guards antes de qualquer efeito externo', () => {
  const src = ler(`${EDGE_DIR}/index.ts`);
  const limpo = removerComentarios(src);

  it('importa os 3 guards do helper espelhado', () => {
    const imp = src.match(/import \{([^}]*)\} from "\.\/qtde-portal\.ts";/);
    expect(imp, 'import do helper sumiu').not.toBeNull();
    for (const sym of ['qtdePortal', 'qtdeFisicaOmie', 'verificarFatorAprovado', 'indexarMapeamentos', 'FatorAprovadoDivergenteError', 'MapeamentoAmbiguoError']) {
      expect(imp![1], `${sym} não importado`).toContain(sym);
    }
  });

  it('TOCTOU: confere fator_embalagem_portal × fator VIVO no map que monta itemsPortal (antes do Browserless)', () => {
    // O select do fallback traz a coluna do motor (#2157) — sem ela, `undefined` = "não arredondou" e o guard dorme.
    const selectItens = limpo.match(/from\("pedido_compra_item"\)\s*\.select\(`([^`]*)`\)/);
    expect(selectItens, 'select direto de pedido_compra_item sumiu').not.toBeNull();
    expect(selectItens![1]).toContain('fator_embalagem_portal');
    // …e é PROPAGADA ao item mapeado (não só selecionada).
    expect(limpo).toMatch(/fator_embalagem_portal:\s*i\.fator_embalagem_portal/);
    // A verificação acontece DENTRO do map que produz `qtde` — mesma sentença que decide a compra, não um
    // `verificarFatorAprovado(...)` solto que calcula e joga fora.
    const bloco = limpo.match(/itemsPortal = itensList\.map\(\(i\) => \{([\s\S]*?)\}\);/);
    expect(bloco, 'map de itemsPortal não encontrado').not.toBeNull();
    expect(bloco![1]).toMatch(/verificarFatorAprovado\(i\.fator_embalagem_portal,\s*i\.fator_conversao,\s*i\.sku_codigo_omie\)/);
    expect(bloco![1]).toMatch(/qtde:\s*qtdePortal\(i\.qtde_final,\s*i\.fator_conversao,\s*i\.sku_codigo_omie\)/);
    // A recusa é NÃO-retentável e nomeia o ramo (o comprador precisa VER por que não foi).
    expect(limpo).toContain('e instanceof FatorAprovadoDivergenteError');
    expect(limpo).toContain('"fator_aprovado_divergente"');
  });

  it('chave de fornecedor: sku_fornecedor_externo filtra por igualdade EXATA com o pedido, nunca ILIKE', () => {
    const q = limpo.match(/from\("sku_fornecedor_externo"\)[\s\S]*?\.in\("sku_omie", skus\)/);
    expect(q, 'query de sku_fornecedor_externo do fallback sumiu').not.toBeNull();
    expect(q![0]).toContain('.eq("fornecedor_nome", pedido.fornecedor_nome)');
    expect(q![0]).not.toContain('.ilike(');
    // O Map é montado pelo helper (ambiguidade fail-closed), não por forEach/set last-wins.
    expect(limpo).toMatch(/indexarMapeamentos\(maps\)/);
    expect(limpo).not.toMatch(/maps\.forEach\(\(m\) => mapByOmie\.set/);
    expect(limpo).toContain('e instanceof MapeamentoAmbiguoError');
    expect(limpo).toContain('"mapeamento_ambiguo"');
  });

  it('toda recusa pré-Browserless grava requestSent: false e status via escritaCritica (não volta à fila)', () => {
    const recusa = limpo.match(/async function recusarPreBrowserless\(([\s\S]*?)\n {2}\}/);
    expect(recusa, 'recusarPreBrowserless não encontrada').not.toBeNull();
    expect(recusa![0]).toContain('"erro_nao_retentavel"');
    expect(recusa![0]).toContain('requestSent: false');
    expect(recusa![0]).toContain('escritaCritica(');
    expect(recusa![0]).toContain('portal_proximo_retry_em: null');
  });
});
