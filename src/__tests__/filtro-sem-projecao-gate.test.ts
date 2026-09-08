import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Gate estrutural: FILTRAR por uma coluna NÃO a PROJETA — e o consumidor que a lê recebe
// `undefined`.
//
// A classe (achado do challenge Codex gpt-6-astra/max, 07/09/2026, sobre o conserto do
// `affinity_score`): `usePropostaPreview` passou a filtrar `.eq('recommendation_type','cross_sell')`
// para que a seção "experimente também" do WhatsApp voltasse a ser cross-sell. O `.eq()` restringe
// as LINHAS; ele não acrescenta a coluna ao `.select()`. Com o `.select()` projetando só
// `product_id, affinity_score, status`, o helper `buildCrossSellCandidatos` — que passou a exigir
// `recommendation_type === 'cross_sell'` — receberia `undefined` para TODAS as linhas e devolveria
// lista vazia: a seção iria a ZERO para os 238 clientes medidos, em silêncio.
//
// O que torna a armadilha cara é que o teste do helper fica VERDE: a fixture fornece o campo que a
// query esqueceu. O defeito só existe na JUNÇÃO dos dois arquivos, que nenhum teste unitário vê.
// Por isso o gate é textual, e por isso ele lê a fonte com o stripper COMPARTILHADO: os dois
// arquivos citam `recommendation_type` fartamente em COMENTÁRIO, e um gate que medisse o texto cru
// passaria por cegueira — lendo o próprio aviso como se fosse a projeção.
//
// ⚠️ POR QUE NÃO É GERAL: "toda coluna filtrada tem de ser projetada" seria falso. Filtrar por
// coluna não projetada é legítimo e comum neste repo (ex.: `.eq('account', account)` em
// `omie_products`, cujo valor ninguém lê depois). A invariante real — "a coluna que um CONSUMIDOR
// lê precisa estar no select" — não é decidível estaticamente. Então este gate guarda o PAR
// concreto que a entrega estabeleceu, e cresce por adição explícita quando outro par aparecer.
const PARES = [
  {
    arquivo: 'src/queries/usePropostaPreview.ts',
    coluna: 'recommendation_type',
    porque:
      'buildCrossSellCandidatos LANÇA se `recommendation_type` vier undefined — sem a projeção, ' +
      'a seção "experimente também" quebra em runtime para todo cliente.',
  },
] as const;

describe('gate: filtrar por coluna exige PROJETAR a coluna', () => {
  for (const par of PARES) {
    it(`${par.arquivo}: filtra por \`${par.coluna}\` ⇒ projeta \`${par.coluna}\``, () => {
      const bruto = readFileSync(resolve(process.cwd(), par.arquivo), 'utf8');
      const fonte = removerComentarios(bruto);

      const filtra = new RegExp(`\\.eq\\(\\s*['"\`]${par.coluna}['"\`]`).test(fonte);
      if (!filtra) return; // o par ainda não existe neste arquivo — nada a exigir

      // Projeção = o nome da coluna DENTRO de algum literal de `.select(...)`.
      const selects = [...fonte.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)].map((m) => m[2]);
      const projetada = selects.some((s) =>
        s.split(',').map((c) => c.trim()).includes(par.coluna),
      );

      expect(
        projetada,
        `${par.arquivo} filtra por \`${par.coluna}\` mas NÃO a projeta em nenhum \`.select()\`. ` +
          `${par.porque} Selects encontrados: ${JSON.stringify(selects)}`,
      ).toBe(true);
    });
  }

  it('o gate mede a FONTE limpa, não o comentário (senão passa por cegueira)', () => {
    // Controle do stripper: um arquivo que só MENCIONA a coluna em comentário não pode
    // ser lido como se a projetasse. Sem esta asserção o gate inteiro seria decorativo,
    // porque os dois arquivos reais estão cheios de comentário citando a coluna.
    const so_comentario = `
      // .select('product_id, recommendation_type')
      const q = sb.from('t').select('product_id').eq('recommendation_type', 'cross_sell');
    `;
    const limpo = removerComentarios(so_comentario);
    const selects = [...limpo.matchAll(/\.select\(\s*(['"`])([\s\S]*?)\1/g)].map((m) => m[2]);
    expect(selects.some((s) => s.split(',').map((c) => c.trim()).includes('recommendation_type')))
      .toBe(false);
  });
});
