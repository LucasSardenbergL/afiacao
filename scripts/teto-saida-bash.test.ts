import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * O teto de saída do Bash (`BASH_MAX_OUTPUT_LENGTH`) é a chave que corta a maior fatia de
 * ocupação de contexto do repo — 77,1% da ocupação é Bash, e o corte em 4.000 rende ~14,3% do
 * total (`docs/historico/ocupacao-bash-por-comando.md` §5).
 *
 * Ela é uma env var, não uma chave de primeira classe do schema do settings: quem apagar o bloco
 * `env` não quebra nada visível — o harness volta ao default de 30.000 em SILÊNCIO, e a regressão
 * só aparece meses depois numa conta de tokens. Este teste é o alarme.
 *
 * Os três números vêm do binário do harness (2.1.202), não de suposição:
 *   `function Pft(){return bpe("BASH_MAX_OUTPUT_LENGTH",process.env.BASH_MAX_OUTPUT_LENGTH,jfo,qfo).effective}`
 *   `var qfo=150000, jfo=30000;`  → default 30.000, upperLimit 150.000 (acima disso é "capped").
 *
 * Eixo POR FORA: o teste NÃO consulta `process.env` — que é justamente o que o harness já
 * aplicou nesta sessão e, portanto, herdaria o defeito da máquina que vigia. Ele lê o ARQUIVO,
 * que é o artefato versionado e a única coisa que sobrevive à sessão.
 */

const DEFAULT_DO_HARNESS = 30000;
const UPPER_LIMIT_DO_HARNESS = 150000;

function lerTeto(): { bruto: unknown; settings: Record<string, unknown> } {
  const caminho = join(process.cwd(), '.claude/settings.json');
  const settings = JSON.parse(readFileSync(caminho, 'utf8')) as Record<string, unknown>;
  const env = (settings.env ?? {}) as Record<string, unknown>;
  return { bruto: env.BASH_MAX_OUTPUT_LENGTH, settings };
}

describe('teto de saída do Bash em .claude/settings.json', () => {
  it('declara BASH_MAX_OUTPUT_LENGTH no bloco env', () => {
    const { bruto } = lerTeto();
    expect(bruto, 'bloco env.BASH_MAX_OUTPUT_LENGTH ausente do .claude/settings.json').toBeDefined();
  });

  it('usa string de dígitos — o harness lê de process.env, que só carrega string', () => {
    const { bruto } = lerTeto();
    expect(typeof bruto).toBe('string');
    expect(String(bruto)).toMatch(/^[0-9]+$/);
  });

  it('aperta ABAIXO do default do harness — senão a chave não tem efeito nenhum', () => {
    const { bruto } = lerTeto();
    const valor = Number(bruto);
    expect(valor).toBeGreaterThan(0);
    expect(
      valor,
      `teto ${valor} >= default ${DEFAULT_DO_HARNESS} do harness: a chave existe mas não corta nada`,
    ).toBeLessThan(DEFAULT_DO_HARNESS);
  });

  it('fica dentro do upperLimit, senão o harness capa o valor em silêncio', () => {
    const { bruto } = lerTeto();
    expect(Number(bruto)).toBeLessThanOrEqual(UPPER_LIMIT_DO_HARNESS);
  });

  it('sobrevive ao merge: o bloco env não engoliu as outras chaves de contexto', () => {
    const { settings } = lerTeto();
    expect(settings.skillListingMaxDescChars).toBeDefined();
    expect(settings.skillListingBudgetFraction).toBeDefined();
  });
});
