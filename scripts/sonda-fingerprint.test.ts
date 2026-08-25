import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ARQ_MAPA,
  calcularTodos,
  digerir,
  edgesInstrumentadas,
  ehRemoto,
  ehTeste,
  extrairImportsLocais,
  fecharGrafo,
  lerMapaCommitado,
  renderizarMapa,
} from './sonda-fingerprint';

/**
 * Harness local e determinístico: monta um `supabase/functions/` de mentira num tmpdir.
 *
 * Não usa o repo real de propósito — um teste que lê a árvore real mede o que ALGUÉM ACABOU DE
 * MUDAR, não a régua, e passa a falhar por motivo alheio. Aqui cada caso constrói exatamente o
 * cenário que quer medir.
 */
let raiz: string;

function escrever(rel: string, conteudo: string): void {
  const abs = join(raiz, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, conteudo, 'utf8');
}

/** Uma edge instrumentada mínima: index + versao + helper local + dep em `_shared/`. */
function montarEdge(nome: string): void {
  escrever(
    `supabase/functions/${nome}/index.ts`,
    `import { auth } from "../_shared/auth.ts";\n` +
      `import { helper } from "./helper.ts";\n` +
      `import { createClient } from "https://esm.sh/@supabase/supabase-js@2";\n` +
      `export default { auth, helper, createClient };\n`,
  );
  escrever(`supabase/functions/${nome}/versao.ts`, `export const VERSAO = "v1.0-sensor-inicial";\n`);
  escrever(`supabase/functions/${nome}/helper.ts`, `export const helper = 1;\n`);
  escrever(`supabase/functions/${nome}/index_test.ts`, `// teste — não entra no bundle\n`);
}

beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'sonda-fp-'));
  escrever('supabase/functions/_shared/auth.ts', `export const auth = "v1";\n`);
  montarEdge('edge-a');
});

afterEach(() => rmSync(raiz, { recursive: true, force: true }));

const hash = (): string => calcularTodos(raiz)['edge-a'];

describe('CALIBRAÇÃO — o que TEM de mover o fingerprint', () => {
  it('mudança no index.ts move o hash', () => {
    const antes = hash();
    escrever('supabase/functions/edge-a/index.ts', `import { auth } from "../_shared/auth.ts";\nexport default { auth, novo: true };\n`);
    expect(hash()).not.toBe(antes);
  });

  it('mudança em helper LOCAL move o hash', () => {
    const antes = hash();
    escrever('supabase/functions/edge-a/helper.ts', `export const helper = 2;\n`);
    expect(hash()).not.toBe(antes);
  });

  it('mudança em dependência `_shared/` move o hash — É O PONTO DESTE GATE', () => {
    // A razão de existir do fingerprint: o `sonda:bump` (#1993) só olha a pasta da edge, e
    // `_shared/` ficou fora dele por medição (~12 bumps à mão por PR). Medido no repo real: o
    // 8ee8afa15 trouxe metade da reescrita do pós-login Sayerlack via
    // `_shared/sayerlack-pos-login.ts`. Sem este caso, o gate inteiro é decoração.
    const antes = hash();
    escrever('supabase/functions/_shared/auth.ts', `export const auth = "v2";\n`);
    expect(hash()).not.toBe(antes);
  });

  it('RENOMEAR arquivo move o hash, mesmo com bytes idênticos', () => {
    // O caminho entra no digest justamente por isto: hash só dos bytes concatenados não distingue
    // renome, e renome muda o bundle.
    const antes = hash();
    renameSync(join(raiz, 'supabase/functions/edge-a/helper.ts'), join(raiz, 'supabase/functions/edge-a/util.ts'));
    escrever(
      'supabase/functions/edge-a/index.ts',
      `import { auth } from "../_shared/auth.ts";\nimport { helper } from "./util.ts";\nexport default { auth, helper };\n`,
    );
    expect(hash()).not.toBe(antes);
  });

  it('DELETAR arquivo do fecho REPROVA (fail-closed), não degrada para hash parcial', () => {
    rmSync(join(raiz, 'supabase/functions/edge-a/helper.ts'));
    expect(() => hash()).toThrow(/import local que NÃO resolve/);
  });
});

describe('CALIBRAÇÃO — o que NÃO pode mover o fingerprint', () => {
  it('mudança em *_test.ts NÃO move o hash (não entra no bundle)', () => {
    const antes = hash();
    escrever('supabase/functions/edge-a/index_test.ts', `// outro conteúdo de teste, bem maior\n`.repeat(20));
    expect(hash()).toBe(antes);
  });

  it('o MAPA gerado não entra no fecho — senão gravá-lo mudaria o hash (ponto-fixo)', () => {
    escrever(
      'supabase/functions/_shared/auth.ts',
      `import { FONTE_SHA256 } from "./sonda-fingerprints.ts";\nexport const auth = FONTE_SHA256;\n`,
    );
    escrever(ARQ_MAPA, `export const FONTE_SHA256: Record<string, string> = {\n  "edge-a": "${'0'.repeat(64)}",\n};\n`);
    const antes = hash();
    escrever(ARQ_MAPA, `export const FONTE_SHA256: Record<string, string> = {\n  "edge-a": "${'f'.repeat(64)}",\n};\n`);
    expect(hash()).toBe(antes);
  });

  it('edge SEM versao.ts não é instrumentada e fica fora do mapa', () => {
    escrever('supabase/functions/edge-sem-sonda/index.ts', `export default {};\n`);
    expect(edgesInstrumentadas(raiz)).toEqual(['edge-a']);
  });
});

describe('a régua de import', () => {
  it('import REMOTO não entra no fecho (não é fonte nossa)', () => {
    for (const esp of ['https://esm.sh/x', 'npm:@supabase/supabase-js@2', 'jsr:@std/assert', 'node:crypto']) {
      expect(ehRemoto(esp)).toBe(true);
    }
    expect(ehRemoto('./local.ts')).toBe(false);
    expect(fecharGrafo('supabase/functions/edge-a/index.ts', raiz).some((f) => f.includes('esm.sh'))).toBe(false);
  });

  it('pega `from`, `import "…"` e `import(…)` dinâmico', () => {
    const fonte = `import { a } from "./a.ts";\nimport "./b.ts";\nconst c = await import("./c.ts");\nimport x from "npm:y";\n`;
    expect(extrairImportsLocais(fonte).sort()).toEqual(['./a.ts', './b.ts', './c.ts']);
  });

  it('reconhece as duas grafias de teste', () => {
    expect(ehTeste('supabase/functions/e/x_test.ts')).toBe(true);
    expect(ehTeste('supabase/functions/e/x.test.ts')).toBe(true);
    expect(ehTeste('supabase/functions/e/index.ts')).toBe(false);
  });
});

describe('determinismo e ida-e-volta', () => {
  it('o digest não depende da ordem em que os arquivos chegam', () => {
    const arquivos = fecharGrafo('supabase/functions/edge-a/index.ts', raiz);
    expect(digerir([...arquivos].reverse().sort(), raiz)).toBe(digerir(arquivos, raiz));
  });

  it('renderizar → ler devolve o mesmo mapa', () => {
    const mapa = calcularTodos(raiz);
    escrever(ARQ_MAPA, renderizarMapa(mapa));
    expect(lerMapaCommitado(raiz)).toEqual(mapa);
  });

  it('duas edges com fonte diferente têm fingerprints diferentes', () => {
    montarEdge('edge-b');
    escrever('supabase/functions/edge-b/helper.ts', `export const helper = 999;\n`);
    const mapa = calcularTodos(raiz);
    expect(mapa['edge-a']).not.toBe(mapa['edge-b']);
  });
});
