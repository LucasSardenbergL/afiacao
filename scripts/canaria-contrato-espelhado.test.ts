import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { localizarCanarias } from './canaria-contrato-bump-gate';

/**
 * O `contrato` da canária da `copilot-analyze` vive DUPLICADO de propósito: literal no `index.ts`
 * (é lá que o `canaria:bump` procura) e constante em `canaria.ts` (é de lá que o teste Deno lê).
 * Duplicata sem vigia diverge — este arquivo é o vigia.
 *
 * O buraco que ele fecha foi MEDIDO nesta fatia: com o literal morando só no módulo,
 * `bun run canaria:bump` respondeu "6 canária(s) conferida(s)" ANTES e DEPOIS de a canária existir.
 * Verde por cegueira — a canária nascia fora do único gate que vigia o bump do marcador dela.
 *
 * ⚠️ Eixo POR FORA: a asserção do espelhamento usa regex PRÓPRIA, não a máquina do gate. Sensor
 * que só consulta a máquina que vigia herda o defeito dela (CLAUDE.md, gates textuais cegos).
 */

const INDEX = 'supabase/functions/copilot-analyze/index.ts';
const MODULO = 'supabase/functions/copilot-analyze/canaria.ts';

/** Eixo próprio: literal `contrato: '...'` emitido no index, sem passar pelo gate. */
function contratoNoIndex(fonte: string): string | null {
  return fonte.match(/contrato\s*:\s*'([^'\n]+)'/)?.[1] ?? null;
}

/** Eixo próprio: a constante exportada pelo módulo. */
function contratoNoModulo(fonte: string): string | null {
  return fonte.match(/CONTRATO_CANARIA\s*=\s*"([^"\n]+)"/)?.[1] ?? null;
}

describe('canária da copilot-analyze: contrato espelhado e VISÍVEL ao gate', () => {
  const fonteIndex = readFileSync(INDEX, 'utf8');
  const fonteModulo = readFileSync(MODULO, 'utf8');

  it('o index emite o contrato como LITERAL', () => {
    expect(contratoNoIndex(removerComentarios(fonteIndex))).toBe('tudo-ou-nada-normalizar-v1');
  });

  it('o módulo exporta a MESMA string na constante', () => {
    expect(contratoNoModulo(fonteModulo)).toBe('tudo-ou-nada-normalizar-v1');
  });

  it('os dois não divergiram', () => {
    const doIndex = contratoNoIndex(removerComentarios(fonteIndex));
    expect(doIndex).not.toBeNull();
    expect(contratoNoModulo(fonteModulo)).toBe(doIndex);
  });

  it('o canaria:bump ENXERGA esta canária (o verde de 6→7 não pode voltar a 6)', () => {
    const achadas = localizarCanarias(removerComentarios(fonteIndex));
    const contratos = achadas.map((c) => c.contrato);
    expect(contratos).toContain('tudo-ou-nada-normalizar-v1');
  });

  // Controle positivo da CEGUEIRA — sem ele, o teste acima poderia estar verde por acaso e
  // ninguém saberia por que o literal existe. Aqui a sabotagem é aplicada a uma cópia sintética,
  // então o teste prova a regra sem depender de alguém sabotar o arquivo real.
  it('trocado por identificador, o gate volta a ficar CEGO — é por isso que é literal', () => {
    const comIdentificador = removerComentarios(fonteIndex).replace(
      /contrato\s*:\s*'tudo-ou-nada-normalizar-v1'/,
      'contrato: CONTRATO_CANARIA',
    );
    expect(comIdentificador).not.toBe(removerComentarios(fonteIndex));
    const contratos = localizarCanarias(comIdentificador).map((c) => c.contrato);
    expect(contratos).not.toContain('tudo-ou-nada-normalizar-v1');
  });
});
