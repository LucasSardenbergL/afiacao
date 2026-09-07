/**
 * audit-custom-migrations.test.ts — a linha de log que reporta o tamanho dos artefatos.
 * ====================================================================================
 *
 * Motivação (medida em 2026-08-22, corrigida no #1897): o script reportava o tamanho com
 * `String.length` sob o rótulo "bytes". `String.length` conta unidades UTF-16, e os dois
 * artefatos são pt-BR acentuado com alguns emoji — então o número impresso divergia do
 * arquivo real em 194 bytes (`.sql`) e 2.023 (`.md`).
 *
 * O custo não é estético. Validar uma mudança no extrator é rodar `bun run audit:migrations`
 * e comparar com o commitado; quem confere o número do log contra `ls -la` conclui que o
 * arquivo MUDOU e sai atrás de uma regressão que não existe. Aconteceu no #1894 e custou um
 * ciclo de apuração até o `git diff` (vazio) desempatar.
 *
 * POR QUE O SENSOR É A LINHA INTEIRA, e não um `bytesUtf8()` isolado: o bug morava no CALL
 * SITE (`${sql.length} bytes`), não na função. Um teste de `bytesUtf8` sozinho exercitaria
 * `Buffer.byteLength` — stdlib — e ficaria VERDE com o call site errado, que é o pior modo
 * de falha possível para este teste. Testando a linha formatada, a aritmética deixa de existir
 * no call site e a asserção passa a ser a que o founder de fato compara: número × filesystem.
 *
 * PONTO CEGO DECLARADO (medido, não suposto): a guarda `if (import.meta.main) main();` NÃO tem
 * sensor. Sabotagem C — removê-la — deixa os 3 testes VERDES enquanto o audit volta a rodar no
 * import (o log do teste imprime "Lidas 484 custom migrations"). Fechar isso exigiria mover a
 * lógica para `scripts/lib/`, como já é feito com `migration-objects.ts`; não vale o refactor
 * hoje, porque a consequência é lentidão e reescrita idempotente de artefato durante o teste,
 * não corrupção. Se um dia doer, a saída é a co-localização, não um gate textual.
 */
import { describe, it, expect } from 'vitest';
import { extractObjects } from './lib/migration-objects';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linhaArtefatoEscrito } from './audit-custom-migrations';

/** o número entre parênteses da linha `✓ Escrito <caminho> (<n> bytes)` */
function numeroReportado(linha: string): number {
  const m = linha.match(/\((\d+) bytes\)$/);
  if (!m) throw new Error(`linha fora do formato esperado: ${JSON.stringify(linha)}`);
  return Number(m[1]);
}

/**
 * Amostra representativa dos artefatos reais: acento pt-BR (2 bytes cada em UTF-8), travessão
 * e ✓ (3 bytes, BMP) e emoji astral (4 bytes, e 2 unidades UTF-16 — a fonte da divergência).
 */
const CONTEUDO = '✓ Escrito — a migração não foi aplicada 🟡🔴\nção ção ção\n';

describe('linhaArtefatoEscrito', () => {
  it('reporta o tamanho que o FILESYSTEM enxerga (a asserção que o founder compara com ls -la)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-bytes-'));
    try {
      const caminho = join(dir, 'artefato.md');
      writeFileSync(caminho, CONTEUDO);

      expect(numeroReportado(linhaArtefatoEscrito(caminho, CONTEUDO))).toBe(statSync(caminho).size);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('NÃO conta unidades UTF-16 — o bug do #1897, que subcontava o .md em 2KB', () => {
    const reportado = numeroReportado(linhaArtefatoEscrito('/tmp/x.md', CONTEUDO));

    // a divergência tem que ser REAL, senão a amostra não exercita a regressão
    expect(CONTEUDO.length).toBeLessThan(reportado);
    expect(reportado).toBe(Buffer.byteLength(CONTEUDO, 'utf8'));
  });

  it('preserva o formato da linha — o founder compara logs entre execuções', () => {
    expect(linhaArtefatoEscrito('/repo/docs/migrations-audit.md', 'abc')).toBe(
      '✓ Escrito /repo/docs/migrations-audit.md (3 bytes)',
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// `bodyMd5` — o que fecha o ponto cego do `CREATE OR REPLACE` (Seção 3 do audit).
//
// O defeito: as Seções 1 e 2 perguntam "o objeto existe?". Para um objeto RECRIADO isso não
// responde "a migration foi aplicada?" — a função existe desde a primeira, e o audit devolve ✅
// com ou sem o apply da segunda. Medido: 231 dos 1307 objetos do inventário são recriados.
// Os dois testes abaixo travam as DUAS armadilhas que quase fizeram a correção nascer quebrada.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('bodyMd5 — a receita tem de ser a MESMA do banco', () => {
  it('o md5 bate com o que o Postgres calcula para a função real de prod', () => {
    // Âncora não-sintética: este corpo é o de `private.cap_carteira_escrever` em produção, e
    // `5faf2a21…` foi MEDIDO lá (psql-ro, 2026-08-29) — não derivado deste código. Se a receita
    // divergir do banco, este teste é o que grita.
    const sql = `CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$function$;`;
    const fn = extractObjects(sql).find((o) => o.kind === 'function');
    expect(fn?.bodyMd5).toBe('5faf2a21a46209aaf0ffa75041af6b4b');
  });

  it('COMENTÁRIO no corpo CONTA — o prosrc do Postgres guarda comentário', () => {
    // 🔴 A armadilha que quase passou: o extrator roda sobre o SQL com comentários REMOVIDOS, mas
    // `pg_proc.prosrc` os guarda. Calcular o md5 sobre o texto strippado dá um hash que nunca bate
    // com o banco para qualquer função com `--` no corpo. Medido: com o texto strippado a Seção 3
    // acusava 52 DERIVA; com o cru, 24 — 28 alarmes FALSOS, e alarme falso em massa é como uma
    // seção nova nasce desligada.
    const comComentario = `CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$
  -- explica a regra
  SELECT 1;
$$;`;
    const semComentario = `CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$
  SELECT 1;
$$;`;
    const a = extractObjects(comComentario).find((o) => o.kind === 'function')?.bodyMd5;
    const b = extractObjects(semComentario).find((o) => o.kind === 'function')?.bodyMd5;
    expect(a).toBeDefined();
    expect(a).not.toBe(b);
  });

  it('a quebra de linha inicial vira ESPAÇO, não some — `btrim` do PG só tira espaço', () => {
    // 🔴 `btrim(x)` com UM argumento remove apenas ESPAÇOS, nunca `\n`. O corpo de `AS $f$\n  SELECT`
    // começa com quebra de linha, que SOBREVIVE ao btrim e vira um espaço à esquerda no
    // `regexp_replace`. Um `.trim()` de JS removeria e produziria md5 diferente do banco.
    const comQuebra = extractObjects('CREATE FUNCTION public.g() RETURNS int LANGUAGE sql AS $$\nSELECT 1;\n$$;')
      .find((o) => o.kind === 'function')?.bodyMd5;
    const semQuebra = extractObjects('CREATE FUNCTION public.g() RETURNS int LANGUAGE sql AS $$SELECT 1;$$;')
      .find((o) => o.kind === 'function')?.bodyMd5;
    expect(comQuebra).toBeDefined();
    expect(comQuebra).not.toBe(semQuebra); // o espaço à esquerda é parte do que o banco hasheia
  });

  it('corpo não extraível degrada para AUSENTE, nunca para um md5 inventado', () => {
    // Ausência de dado não pode virar "confere": sem `bodyMd5` a função simplesmente fica FORA da
    // Seção 3, em vez de entrar nela com um hash que ninguém mediu.
    const semDollarQuote = `CREATE FUNCTION public.h() RETURNS int LANGUAGE c AS 'MODULE_PATHNAME', 'h';`;
    const fn = extractObjects(semDollarQuote).find((o) => o.kind === 'function');
    expect(fn).toBeDefined();
    expect(fn?.bodyMd5).toBeUndefined();
  });
});
