import { describe, it, expect } from 'vitest';
import { margemConhecida, mediaMargensConhecidas } from '../margin';
import { selectObjective } from '../objective';
import { classifyCustomerProfile } from '@/hooks/useBundleArguments';
import { formatMargemPct } from '@/lib/format';

/**
 * Guards contra a fabricação que aparece quando `gross_margin_pct` passa a ser NULL.
 *
 * Contexto: a coluna era `0` literal em 6.632/6.632 linhas (com `column_default = 0`), então
 * todo `|| 0` era inerte e nada disso dava sinal. Com a margem calculada no servidor (#1495),
 * 5.579 de 6.632 linhas (84,1%) viram NULL de uma vez.
 *
 * O erro que estes testes existem para impedir não é "esqueci de tratar null" — é a COERÇÃO
 * SILENCIOSA do JS: `null < 20` é `true`, `null * 100` é `0`, `Number(null)` é `0`. Cada um
 * produz um resultado plausível, e plausível é o que passa despercebido.
 */

describe('margemConhecida', () => {
  it('distingue margem ZERO (veredito) de margem AUSENTE (sem dado)', () => {
    // A distinção que dá nome a tudo isto: 0 é uma medição ("cliente não-lucrativo").
    expect(margemConhecida(0)).toBe(0);
    expect(margemConhecida(null)).toBeNull();
    expect(margemConhecida(undefined)).toBeNull();
  });

  it('preserva margem negativa — o mínimo em prod é −143,22%', () => {
    expect(margemConhecida(-143.22)).toBe(-143.22);
  });

  it('trata não-finito como ausente', () => {
    expect(margemConhecida(NaN)).toBeNull();
    expect(margemConhecida(Infinity)).toBeNull();
    expect(margemConhecida('não é número')).toBeNull();
  });

  it('aceita numeric vindo do Postgres como string', () => {
    expect(margemConhecida('53.47')).toBe(53.47);
  });
});

describe('mediaMargensConhecidas', () => {
  it('exclui ausentes do numerador E do denominador', () => {
    // Com `|| 0` a média seria (50+30+0+0)/4 = 20. O erro é sedutor porque 20 é plausível.
    expect(mediaMargensConhecidas([50, 30, null, undefined])).toBe(40);
  });

  it('devolve null quando nenhuma margem é conhecida — não 0', () => {
    expect(mediaMargensConhecidas([null, undefined, NaN])).toBeNull();
    expect(mediaMargensConhecidas([])).toBeNull();
  });

  it('conta o zero conhecido, que é medição de verdade', () => {
    expect(mediaMargensConhecidas([0, 100])).toBe(50);
  });
});

describe('classifyCustomerProfile — margem ausente não vira diagnóstico', () => {
  it('NÃO rotula sensivel_preco quando a margem é desconhecida', () => {
    // `null < 20` é `true` em JS. Sem o guard, todo cliente de gasto baixo e margem não apurada
    // sairia como "sensível a preço" — rótulo que molda a abordagem levada ao cliente.
    expect(classifyCustomerProfile(50, 300, null, 5)).not.toBe('sensivel_preco');
  });

  it('AINDA rotula sensivel_preco quando a margem é de fato baixa', () => {
    expect(classifyCustomerProfile(50, 300, 10, 5)).toBe('sensivel_preco');
  });

  it('margem 0 CONHECIDA continua sendo margem baixa', () => {
    expect(classifyCustomerProfile(50, 300, 0, 5)).toBe('sensivel_preco');
  });

  it('NÃO rotula orientado_qualidade sem margem, mas rotula com margem alta', () => {
    expect(classifyCustomerProfile(50, 1000, null, 2)).not.toBe('orientado_qualidade');
    expect(classifyCustomerProfile(50, 1000, 40, 2)).toBe('orientado_qualidade');
  });

  it('ramos que não dependem de margem seguem funcionando sem ela', () => {
    expect(classifyCustomerProfile(70, 3000, null, 5)).toBe('orientado_produtividade');
    expect(classifyCustomerProfile(50, 1000, null, 5)).toBe('misto');
  });
});

describe('selectObjective — consolidacao_margem exige margem conhecida', () => {
  const cap = 180;

  it('NÃO escolhe consolidacao_margem sem a margem do cliente', () => {
    // Sem guard: `null < 40 * 0.8` é `true` → consolidação a esmo para 84% da base.
    expect(selectObjective(10, 0, null, 40, 5, cap)).not.toBe('consolidacao_margem');
  });

  it('escolhe consolidacao_margem quando ambas são conhecidas e a do cliente é baixa', () => {
    expect(selectObjective(10, 0, 20, 40, 5, cap)).toBe('consolidacao_margem');
  });

  it('segue exigindo o cluster (comportamento preexistente preservado)', () => {
    expect(selectObjective(10, 0, 20, null, 5, cap)).not.toBe('consolidacao_margem');
  });

  it('regras anteriores à margem não são afetadas pela ausência dela', () => {
    expect(selectObjective(10, 0, null, 40, 999, cap)).toBe('reativacao');
    expect(selectObjective(80, 0, null, 40, 5, cap)).toBe('recuperacao');
    expect(selectObjective(10, 5, null, 40, 5, cap)).toBe('expansao_mix');
    expect(selectObjective(10, 0, null, 40, 5, cap, 'sem_historico')).toBe('ativacao');
  });
});

describe('formatMargemPct', () => {
  it('mostra travessão para margem ausente, nunca "0%"', () => {
    expect(formatMargemPct(null)).toBe('—');
    expect(formatMargemPct(undefined)).toBe('—');
    expect(formatMargemPct(NaN)).toBe('—');
  });

  it('mostra "0%" só quando a margem zero foi realmente apurada', () => {
    expect(formatMargemPct(0)).toBe('0%');
  });

  it('trata o valor como PERCENTUAL, sem multiplicar por 100', () => {
    // O bug que isto previne: `(53.47 * 100).toFixed(1)` exibia "5347.0%".
    expect(formatMargemPct(53.47)).toBe('53.5%');
    expect(formatMargemPct(30)).toBe('30%');
  });

  it('formata margem negativa corretamente', () => {
    // O mínimo real medido em prod. O contraste com formatPctMaybe (que erra aqui, e é por isso
    // que margem tem formatador próprio) está fixado em components/customer360/__tests__/format.test.ts.
    expect(formatMargemPct(-143.22)).toBe('-143.2%');
  });
});
