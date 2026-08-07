import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Gate de APOSENTADORIA da RPC `import_tint_formulas` (money-path — tintométrico).
//
// A função era o 2º writer de `tint_formula_itens` em produção e o ÚNICO sem o Guard 4:
// mantinha `DELETE FROM tint_formula_itens` INCONDICIONAL seguido de INSERT filtrado por
// `COALESCE(qtd,0) > 0`, exatamente o anti-padrão que as migrations 20260717163000 +
// 20260718100000 mataram no `tint_promote_sync_run`. Efeito medido em PG17 contra o corpo
// byte-a-byte de prod (`db/test-import-tint-formulas.sh`, 17 asserts): dose 0 num corante
// grava receita PARCIAL com `errors: 0`; payload todo-inválido APAGA a receita e reporta
// sucesso; `NaN > 0` é TRUE em numeric, então NaN entra na receita; e o UPDATE de
// `preco_final_sayersystem` ignora `desativada_em`, alcançando as 463.995 linhas
// carimbadas `fase5_geracao_legada` que alimentam o piso do `tint_gate_revalida`.
//
// Dropada em `supabase/migrations/20260806223407_drop_import_tint_formulas.sql`.
//
// Este gate é o irmão SQL do `supabase/functions/tint-import/retired_test.ts` (que fixa o
// 410 do edge). O modo de falha que ele cobre é o mesmo que o #1401 quase deixou acontecer
// com o writer do edge: alguém "limpa" o histórico, copia o corpo antigo de volta e o
// catálogo volta a ser gravável por uma via sem guard — sem que nenhum linter, typecheck
// ou teste de comportamento acuse, porque a função só falha em RUNTIME e não tem chamador.
//
// Se o import manual voltar a ser requisito: implemente o fail-closed all-or-nothing por
// fórmula do zero (dose positiva E FINITA) e atualize este gate conscientemente. NÃO
// ressuscite o corpo antigo — ele é a versão fail-open, e o harness prova por quê.

const RAIZ = resolve(__dirname, '../..');
const DIR_MIGRATIONS = 'supabase/migrations';

// Timestamp da migration que dropou a função. Migrations ANTERIORES podem citar/criar a
// função (é o histórico legítimo: ela existiu de 2026-03 a 2026-08). O que o gate proíbe
// é uma migration NOVA recriá-la.
const TS_DROP = '20260806223407';

// §"o ALVO mente" (money-path.md). Precisão sobre o que isto faz HOJE: a migration do DROP
// cita `import_tint_formulas` dezenas de vezes em comentário, mas nunca na forma
// `CREATE ... FUNCTION` — logo o gate NÃO acusaria o próprio fix mesmo medindo o arquivo
// cru (medido, não presumido). O `semComentarios` é DEFESA DO FUTURO, para quando alguém
// documentar o corpo antigo dentro de uma migration nova ("era assim que era, não faça"),
// que é precisamente como esta dívida foi documentada em `tint-import/index.ts`. O teste
// de fixture abaixo é o que prova que ele funciona — declarado como defesa, não como bug
// corrigido, porque defesa inerte vendida como conserto dá impressão falsa de furo fechado.
function semComentarios(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* bloco */
    .replace(/--[^\n]*/g, ' ');          // -- linha
}

// Casa `CREATE FUNCTION` e `CREATE OR REPLACE FUNCTION` da função alvo, tolerando
// quebra de linha, `public.` opcional e espaçamento livre entre os tokens.
const RE_RECRIA = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\s*\.\s*)?import_tint_formulas\b/i;

function migrations(): string[] {
  return readdirSync(resolve(RAIZ, DIR_MIGRATIONS))
    .filter((n) => n.endsWith('.sql'))
    .sort();
}

function timestampDe(nome: string): string {
  return nome.slice(0, 14);
}

describe('import_tint_formulas segue aposentada', () => {
  it('a migration do DROP continua no repo', () => {
    const alvo = migrations().find((n) => n.startsWith(TS_DROP));
    expect(alvo, `migration ${TS_DROP}_drop_import_tint_formulas.sql sumiu do repo`).toBeDefined();

    const sql = semComentarios(readFileSync(resolve(RAIZ, DIR_MIGRATIONS, alvo!), 'utf8'));
    expect(sql, 'a migration existe mas não contém mais o DROP').toMatch(
      /DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.import_tint_formulas/i,
    );
  });

  it('nenhuma migration posterior ao DROP recria a função', () => {
    const reincidentes = migrations()
      .filter((nome) => timestampDe(nome) > TS_DROP)
      .filter((nome) => RE_RECRIA.test(semComentarios(readFileSync(resolve(RAIZ, DIR_MIGRATIONS, nome), 'utf8'))));

    expect(
      reincidentes,
      `import_tint_formulas foi RECRIADA em: ${reincidentes.join(', ')}. ` +
        'Ela é a versão fail-open (delete incondicional + insert filtrado) — ver ' +
        'db/test-import-tint-formulas.sh. Se o import manual voltou a ser requisito, ' +
        'implemente o guard all-or-nothing do zero e atualize este gate.',
    ).toEqual([]);
  });

  it('o detector reconhece as formas reais de recriação (calibração)', () => {
    // Controle: sem isto, um regex quebrado deixaria o gate verde para sempre — o modo de
    // falha do §"o GATE mente quando a regex não conhece a forma REAL do repo".
    const positivos = [
      'CREATE FUNCTION public.import_tint_formulas(p_account text) RETURNS jsonb AS $$',
      'CREATE OR REPLACE FUNCTION public.import_tint_formulas(p_account text)',
      'create or replace function import_tint_formulas(p_account text)',
      'CREATE OR REPLACE FUNCTION\n  public.import_tint_formulas (p_account text)',
    ];
    for (const p of positivos) expect(RE_RECRIA.test(p), `não casou: ${p}`).toBe(true);

    const negativos = [
      'DROP FUNCTION IF EXISTS public.import_tint_formulas(text, boolean, jsonb);',
      'CREATE OR REPLACE FUNCTION public.import_tint_formulas_guardada(p_account text)',
      'GRANT EXECUTE ON FUNCTION public.import_tint_formulas TO authenticated;',
    ];
    for (const n of negativos) expect(RE_RECRIA.test(n), `casou indevidamente: ${n}`).toBe(false);
  });

  it('o semComentarios neutraliza a citação em comentário (anti falso-vermelho)', () => {
    const soComentario = `
      -- CREATE OR REPLACE FUNCTION public.import_tint_formulas(...) era o writer fail-open
      /* CREATE FUNCTION public.import_tint_formulas() também aparece aqui */
      DROP FUNCTION IF EXISTS public.import_tint_formulas(text, boolean, jsonb);
    `;
    expect(RE_RECRIA.test(soComentario), 'controle inválido: o cru deveria casar').toBe(true);
    expect(RE_RECRIA.test(semComentarios(soComentario))).toBe(false);
  });
});
