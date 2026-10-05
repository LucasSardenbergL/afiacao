import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Prova do GATE do `eslint.config.js` que barra pattern de LIKE/ILIKE montado com input em `src/`
 * (classe `pattern-like-cru`: B2 da varredura semgrep de 2026-09-27, a classe do #1062). O 2º
 * argumento de `.ilike`/`.like` é o PATTERN: `%`, `_` e `*` (alias de `%` no PostgREST) do termo
 * viram curinga, e `**` casa tudo. Os helpers `ilikeContainsPattern`/`likePrefixPattern` de
 * `@/lib/postgrest` sanitizam e devolvem null no termo degenerado.
 *
 * Contra verde por cegueira (o mesmo desenho de scripts/eslint-mutacao-env-bun.test.ts): (1) casa a
 * MARCA da mensagem da regra, não "algum erro"; (2) fixture que não parseia LANÇA, porque parse
 * error devolve zero violações, idêntico a "limpo" (e caminho ignorado idem); (3) as linhas pegas
 * são conferidas uma a uma, e um seletor quebrado some da lista em vez de se esconder numa contagem.
 */

/** Fecho das mensagens: ASCII e caixa fixa, para o casamento não depender de locale. */
const MARCA = 'pattern-like-cru';
/** A regra irmã do `.or()`, no MESMO array `no-restricted-syntax` que esta regra estendeu. */
const MARCA_OR = 'ilikeOr/ilike/eqInt/eqText/orFilter';
const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const eslint = new ESLint({ cwd: RAIZ });

// O 1º `lintText` carrega o config e o parser TS — a avaliação SÍNCRONA do módulo `typescript`, o
// único bloqueio relevante deste arquivo (1,8s sob carga em 2026-10-05, dentro do 1º `it`). Não dá
// para fatiar (é import de módulo), então ele acontece AQUI, na COLETA (top-level await): sem chamada
// RPC em voo, bloqueio na coleta não estoura o `onTaskUpdate` do vitest (medido em 2026-10-05:
// `sleep 65` no topo → rc=0; no `it` → rc=1). src/test/loop-livre.ts
await eslint.lintText('', { filePath: join(RAIZ, 'scripts/aquecimento-do-parser.ts') });
const PARSER_TS_CARREGADO_NA_COLETA = Object.keys(createRequire(import.meta.url).cache).some((k) =>
  /[\\/]node_modules[\\/]typescript[\\/]lib[\\/]typescript\.js$/.test(k),
);

async function linhasPegas(codigo: string, relativo: string, marca = MARCA): Promise<number[]> {
  // Caminho IGNORADO também devolve zero violações: o "fica fora das edges" passaria pelo motivo errado.
  if (await eslint.isPathIgnored(join(RAIZ, relativo))) {
    throw new Error(`${relativo} é ignorado pelo eslint — zero violação aqui seria cegueira, não escopo`);
  }
  const [resultado] = await eslint.lintText(codigo, { filePath: join(RAIZ, relativo) });
  const fatal = resultado.messages.find((m) => m.fatal);
  if (fatal) {
    throw new Error(
      `a fixture de ${relativo} não parseou (${fatal.message}) — zero violação aqui seria cegueira, não limpeza`,
    );
  }
  return resultado.messages
    .filter((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes(marca))
    .map((m) => m.line);
}

/** Uma forma crua por linha: cada método que recebe pattern, com template e com concatenação. */
const CRUAS = [
  'q.ilike("descricao", `%${termo}%`);',
  'q.like("cnae_principal", `${cnae}%`);',
  'q.ilike("nome", "%" + termo + "%");',
  'q.like("codigo", prefixo + "%");',
  'q.ilikeAnyOf("nome", [`%${a}%`, "fixo"]);',
  'q.likeAllOf("nome", ["fixo", b + "%"]);',
  'q.filter("phone", "ilike", `%${ultimos8}%`);',
  'q.not("familia", "like", `${x}%`);',
  'q.filter("nome", "like", "%" + x);',
].join('\n');
const TODAS_AS_LINHAS = CRUAS.split('\n').map((_, i) => i + 1);

/** O idioma certo e os vizinhos que a regra NÃO pode pegar. */
const SEGURAS = [
  'import { ilikeContainsPattern, ilikeOr } from "@/lib/postgrest";',
  'const pat = ilikeContainsPattern(termo);',
  'if (pat) q.ilike("descricao", pat);',
  'q.ilike("descricao", ilikeContainsPattern(termo) ?? "");',
  'q.like("cnae_principal", "3101%");',
  'q.ilike("nome", `%fixo%`);',
  'q.not("familia", "ilike", "%imobilizado%");',
  'q.filter("status", "eq", `${status}`);',
  'q.eq("nome", `${a}-${b}`);',
  'q.ilike(`${coluna}_nome`, pat);',
  'q.or(ilikeOr(["a", "b"], termo));',
].join('\n');

describe('eslint: pattern de LIKE/ILIKE montado com input em src/', () => {
  it('o parser TS foi carregado na COLETA — o 1º lint de um `it` não paga a inicialização', () => {
    expect(PARSER_TS_CARREGADO_NA_COLETA, 'o aquecimento saiu da coleta: o 1º `it` volta a bloquear o worker').toBe(true);
  });

  it('pega cada forma crua, linha a linha, pela marca da regra', async () => {
    expect(await linhasPegas(CRUAS, 'src/lib/fixture-pattern-like.ts')).toEqual(TODAS_AS_LINHAS);
  });

  it('não pega helper, literal, template sem interpolação, operador que não é like nem interpolação na coluna', async () => {
    expect(await linhasPegas(SEGURAS, 'src/lib/fixture-pattern-like.ts')).toEqual([]);
  });

  it('vale em .tsx (páginas e componentes)', async () => {
    expect(await linhasPegas(CRUAS, 'src/pages/FixturePatternLike.tsx')).toEqual(TODAS_AS_LINHAS);
  });

  it('a regra irmã do .or() continua de pé no mesmo array', async () => {
    const or = 'q.or(`nome.ilike.%${termo}%`);';
    expect(await linhasPegas(or, 'src/lib/fixture-pattern-like.ts', MARCA_OR)).toEqual([1]);
  });

  it('LIMITE DECLARADO: fica fora das edges, que não têm helper compartilhado (B1)', async () => {
    // Não é cobertura, é o escopo escrito como fato executável. Estender o gate às edges exige
    // antes um helper espelhado em supabase/functions/_shared, e aí este teste muda junto.
    expect(await linhasPegas(CRUAS, 'supabase/functions/fixture-pattern-like/index.ts')).toEqual([]);
  });
});
