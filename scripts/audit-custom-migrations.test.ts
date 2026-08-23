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
