import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Gate estrutural: AFINIDADE não mora em coluna de DINHEIRO, e ranking não sai de coluna vazia.
//
// A classe (FU4-F fase 3, PR-B): ao tirar o custo do browser, os engines pararam de calcular
// lucro e a primeira versão reaproveitou `farmer_recommendations.lie` e
// `farmer_bundle_recommendations.lie_bundle` — colunas de Lucro Incremental Esperado em REAIS —
// para guardar um score de afinidade adimensional (~0,0094). Para ORDENAR estava certo (afinidade
// e p_bundle são monotônicos entre si), e é justamente por isso que passou: o defeito não aparece
// em quem ordena, aparece em quem lê o VALOR — e esses estavam fora do diff.
//
//   · src/hooks/useTacticalPlan.ts        → copia `lie_bundle` para `bundle_lie`
//   · .../tacticalPlan/PlanCard.tsx       → `Intl.NumberFormat{style:'currency',currency:'BRL'}`
//                                            e `bundleLie / (avgCallMinutes/60)` = lucro/hora
//   · supabase/functions/generate-tactical-plan → injetava o valor no prompt do LLM
//
// Medido em prod: `farmer_tactical_plans` tem 677 planos e ZERO com `bundle_lie` — o card
// simplesmente não exibe LIE hoje. Com a afinidade na coluna de dinheiro, ele passaria a exibir
// "R$ 0,01" e ~R$ 0,02/h como se fosse medição, onde os testes de prod registram R$ 1.250,50.
//
// Por que TEXTUAL (readFileSync, padrão de paginacao-artesanal-gate/erro-object-object-gate):
// metade dos sítios é edge Deno, que o vitest não executa e o tsc do app não checa. E o typecheck
// não pegaria nada disto de qualquer forma — `lie_bundle` e `affinity_bundle` são ambos
// `number | null` nos tipos gerados: trocar uma pela outra é um erro de SIGNIFICADO, invisível
// para o compilador. É exatamente a classe de bug que só um fiscal de fonte pega.

const RAIZ = resolve(__dirname, '../..');
const DIRS = ['src', 'supabase/functions'];
const EXT = /\.(ts|tsx)$/;
const IGNORAR = /(\.test\.|_test\.|\.d\.ts$|__tests__|\.stories\.)/;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    const st = statSync(resolve(RAIZ, rel));
    if (st.isDirectory()) {
      if (nome === 'node_modules' || nome === '.git') continue;
      listarFontes(rel, acc);
    } else if (EXT.test(nome) && !IGNORAR.test(rel)) {
      acc.push(rel);
    }
  }
  return acc;
}

// Comentários removidos ANTES de medir. Não é zelo teórico: os arquivos corrigidos por esta
// entrega EXPLICAM o bug em prosa, citando `lie_bundle` e a ordenação antiga. Sem isto, o fiscal
// mede a explicação e reprova código íntegro (falso-VERMELHO — a lição de #1472/#1488).
function semComentarios(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

// ── G1: ordenar por coluna de DINHEIRO ──────────────────────────────────────
// `.order('lie')` / `.order('lie_bundle')` — a forma exata que este PR removeu. Depois do scrub
// (20260725125000) e das guardas (20260725126000), essas colunas são NULL em 100% das linhas:
// ordenar por elas não ordena nada, e o `.limit(1)` devolve linha arbitrária como "melhor oferta".
const G1 = /\.\s*order\s*\(\s*['"`](lie|lie_bundle)['"`]/g;

// ── G2: ler o VALOR de lie/lie_bundle para exibir ou calcular ───────────────
// Só `.order` não basta como fiscal: quem copiava `lie_bundle` para um campo de dinheiro fazia
// `topBundle.lie_bundle`, não `.order`. Casa acesso de propriedade e destructuring.
const G2 = /(?:\.\s*(?:lie|lie_bundle)\b(?!\s*:)|\{\s*[^}]*\b(?:lie|lie_bundle)\s*[,}])/g;

// ── G3: `.order('affinity_*')` sem o `.not(...is null)` do mesmo call-site ──
// `nullsFirst: false` resolve a MISTURA; não resolve TODAS-NULL, que é o estado de toda linha
// anterior à coluna. Sem o filtro, o "top" é a primeira linha que o Postgres devolver — ranking
// fabricado. Achado do challenge Codex nesta entrega.
const G3_ORDER = /\.\s*order\s*\(\s*['"`]affinity_(score|bundle)['"`]/g;

function contar(re: RegExp, fonte: string): number {
  return [...semComentarios(fonte).matchAll(re)].length;
}

const FONTES = DIRS.flatMap((d) => listarFontes(d));

// `lie`/`lie_bundle` seguem EXISTINDO como colunas (o histórico de outcome não foi apagado) e
// há dois lugares legítimos que as nomeiam: o writer, que grava NULL explícito, e os tipos
// gerados. Isenção por ARQUIVO, com o motivo — quem entrar aqui deixa de ser fiscalizado.
// A lista é EXATAMENTE a dos arquivos que casam hoje (medido) — isentar quem não casa mascara o
// futuro: o arquivo entra na lista, alguém adiciona um consumo de valor lá dentro, e o gate cala.
// `useCrossSellEngine.ts` NÃO está aqui de propósito: ele grava `lie: null`, que o `(?!\s*:)` do
// G2 já exclui — se um dia ele passar a LER o valor, tem de ficar vermelho.
const ISENTOS: ReadonlySet<string> = new Set([
  'src/integrations/supabase/types.ts', // gerado: descreve o schema, não consome o valor
  'src/hooks/useBundleEngine.ts', // grava `lie_bundle: null` + tipa a linha lida
  'src/hooks/useTacticalPlan.ts', // tipo da linha lida + `bundle_lie` de farmer_tactical_plans
  'src/lib/tactical/bundle-numeros.ts', // helper que degrada `lie_bundle` NULL → `bundle_lie` null
  'supabase/functions/generate-tactical-plan/plano-helpers.ts', // espelho Deno do helper acima
]);

describe('gate: afinidade não é dinheiro', () => {
  it('G1 nenhum `.order` por `lie`/`lie_bundle` — são colunas NULL desde o scrub', () => {
    const infratores = FONTES.filter((f) => contar(G1, readFileSync(resolve(RAIZ, f), 'utf8')) > 0);
    expect(infratores).toEqual([]);
  });

  it('G2 fora dos isentos, ninguém consome o VALOR de `lie`/`lie_bundle`', () => {
    const infratores = FONTES.filter(
      (f) => !ISENTOS.has(f) && contar(G2, readFileSync(resolve(RAIZ, f), 'utf8')) > 0,
    );
    expect(infratores).toEqual([]);
  });

  it('G3 todo `.order` por afinidade tem `.not(...is null)` no mesmo arquivo (fail-closed)', () => {
    const semFiltro = FONTES.filter((f) => {
      const fonte = semComentarios(readFileSync(resolve(RAIZ, f), 'utf8'));
      if (contar(G3_ORDER, fonte) === 0) return false;
      return !/\.\s*not\s*\(\s*['"`]affinity_(score|bundle)['"`]\s*,\s*['"`]is['"`]\s*,\s*null/.test(fonte);
    });
    expect(semFiltro).toEqual([]);
  });

  it('G4 os writers gravam a afinidade na coluna DEDICADA e o LIE fica NULL — garantido no SERVIDOR', () => {
    // Pin ESPECÍFICO, não de forma: um gate genérico ("existe algum .order") ficaria verde se
    // alguém trocasse a coluna de volta. Quando a chave É a defesa, pine a chave.
    //
    // ⚠️ A garantia MUDOU DE LUGAR em 2026-08-15 (migration 20260814223445) e o pin acompanhou.
    // Antes o browser mandava `lie: null` explícito no payload do upsert, e o gate lia isso.
    // Hoje os writers vão pela RPC `farmer_*_substituir`, que fixa `NULL, NULL` em m_ij/lie no
    // próprio INSERT — o payload nem carrega as colunas de dinheiro. Isso é ESTRITAMENTE MAIS
    // FORTE: antes um browser adulterado podia mandar `lie: 999` e o upsert gravaria; agora o
    // servidor descarta o que vier. Repinar no payload teria sido enfraquecer o gate para o
    // formato antigo; o certo é pinar onde a defesa REALMENTE mora agora.
    const cross = semComentarios(readFileSync(resolve(RAIZ, 'src/hooks/useCrossSellEngine.ts'), 'utf8'));
    expect(cross).toMatch(/affinity_score:\s*rec\.affinityScore/);
    // O browser NÃO manda mais dinheiro no payload — nem como null.
    expect(cross).not.toMatch(/\blie:\s*/);
    expect(cross).not.toMatch(/\bm_ij:\s*/);

    const bundle = semComentarios(readFileSync(resolve(RAIZ, 'src/hooks/useBundleEngine.ts'), 'utf8'));
    expect(bundle).toMatch(/affinity_bundle:\s*bundle\.affinityBundle/);
    expect(bundle).not.toMatch(/\blie_bundle:\s*/);
    expect(bundle).not.toMatch(/\bm_bundle:\s*/);

    // E a RPC que passou a ser a dona da garantia: o INSERT fixa NULL nas duas colunas de
    // dinheiro. Sem este assert a propriedade ficaria SEM dono — os `not.toMatch` acima
    // sozinhos provariam apenas que o browser parou de mandar, não que o servidor zera.
    // ⚠️ `semComentarios` só conhece `//` e `/* */` — comentário SQL é `--`, e a migration
    // explica o bug em prosa exatamente ENTRE `r.p_ij,` e o `NULL, NULL`. Sem tirar os `--`
    // o regex não casa e o gate reprova código íntegro (falso-VERMELHO). É a mesma lição do
    // §"o ALVO mente": todo predicado textual mede o CÓDIGO, nunca a prosa que o descreve —
    // só que aqui a linguagem do alvo é outra.
    const semComentariosSql = (s: string) =>
      s.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
    const mig = semComentariosSql(
      readFileSync(resolve(RAIZ, 'supabase/migrations/20260814223445_farmer_recomendacoes_geracao_vigente.sql'), 'utf8'),
    );
    // cross-sell: `r.p_ij,\n    NULL, NULL,\n    r.affinity_score`
    expect(mig).toMatch(/r\.p_ij,\s*NULL,\s*NULL,\s*r\.affinity_score/);
    // bundle: `r.p_bundle,\n    NULL, NULL,\n    r.affinity_bundle`
    expect(mig).toMatch(/r\.p_bundle,\s*NULL,\s*NULL,\s*r\.affinity_bundle/);
    // e as colunas de dinheiro seguem NA lista de INSERT (se saíssem, o DEFAULT 0 da tabela
    // voltaria a preencher — que é exatamente o número fabricado que este gate existe p/ barrar).
    expect(mig).toMatch(/p_ij,\s*m_ij,\s*lie,\s*affinity_score/);
    expect(mig).toMatch(/p_bundle,\s*m_bundle,\s*lie_bundle,\s*affinity_bundle/);
  });

  it('G5 CALIBRAÇÃO: os padrões casam a forma PRÉ-fix e não casam a PÓS-fix', () => {
    // Sem este controle, um regex que não casa nada nunca fica vermelho e o gate vira decoração
    // (a lição do G4/`as number` em #1581: contagem 0 num arquivo que nunca foi medido).
    const preG1 = `.eq('status','pendente').order('lie_bundle', { ascending: false }).limit(1)`;
    const posG1 = `.not('affinity_bundle','is',null).order('affinity_bundle', { ascending: false, nullsFirst: false })`;
    expect(contar(G1, preG1)).toBe(1);
    expect(contar(G1, posG1)).toBe(0);

    const preG2 = `const lie = topBundle.lie_bundle; return { lie: topBundle.lie_bundle };`;
    expect(contar(G2, preG2)).toBeGreaterThan(0);
    expect(contar(G2, `const a = row.affinity_bundle;`)).toBe(0);

    // G3: a MESMA linha pós-fix acima tem `.order` de afinidade E o `.not` — não pode acusar.
    expect(contar(G3_ORDER, posG1)).toBe(1);
    expect(
      /\.\s*not\s*\(\s*['"`]affinity_(score|bundle)['"`]\s*,\s*['"`]is['"`]\s*,\s*null/.test(posG1),
    ).toBe(true);
    // ...e a forma SEM o filtro (só `nullsFirst`) tem de ser reprovada.
    const g3Infrator = `.order('affinity_bundle', { ascending: false, nullsFirst: false }).limit(1)`;
    expect(
      /\.\s*not\s*\(\s*['"`]affinity_(score|bundle)['"`]\s*,\s*['"`]is['"`]\s*,\s*null/.test(g3Infrator),
    ).toBe(false);

    // O fiscal ignora COMENTÁRIO: esta entrega explica o bug em prosa nos arquivos corrigidos.
    expect(contar(G1, `// antes era .order('lie_bundle', { ascending: false })`)).toBe(0);
  });
});
