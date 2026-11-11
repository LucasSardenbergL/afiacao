import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nomeClienteExibicao, razaoSemCpf } from './razao-exibicao';

/** A linha `const CPF_LIVRE = …;` de um arquivo — a expressão que as duas cópias têm de ter IGUAL. */
function linhaCpfLivre(caminho: string): string {
  const linha = readFileSync(resolve(process.cwd(), caminho), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('const CPF_LIVRE = '));
  if (!linha) throw new Error(`CPF_LIVRE_AUSENTE: ${caminho} não declara a máscara`);
  return linha;
}

describe('razao-exibicao (espelho src/ de _shared/razao-fiscal.ts)', () => {
  it('a expressão da máscara é a MESMA da edge, letra por letra', () => {
    expect(linhaCpfLivre('src/lib/omie/razao-exibicao.ts')).toBe(
      linhaCpfLivre('supabase/functions/_shared/razao-fiscal.ts'),
    );
  });

  it('a substituição também é a mesma (aspas à parte)', () => {
    const repl = (caminho: string) => {
      const m = /\.replace\(CPF_LIVRE, (['"])(.*?)\1\)/.exec(readFileSync(resolve(process.cwd(), caminho), 'utf8'));
      if (!m) throw new Error(`REPLACE_AUSENTE: ${caminho}`);
      return m[2];
    };
    expect(repl('src/lib/omie/razao-exibicao.ts')).toBe(repl('supabase/functions/_shared/razao-fiscal.ts'));
  });

  // As amostras são as da prova SQL (db/test-clientes-mei-cpf-mascarado.sh) e do razao-fiscal_test.ts.
  it('mascara as três formas medidas em prod e o CPF com espaço, em qualquer posição', () => {
    expect(razaoSemCpf('PEDRO ALVES COSTA 12345678901')).toBe('PEDRO ALVES COSTA ***456789**');
    expect(razaoSemCpf('PEDRO ALVES COSTA 123.456.789-01')).toBe('PEDRO ALVES COSTA ***.456.789-**');
    expect(razaoSemCpf('PEDRO 12345678901 ALVES')).toBe('PEDRO ***456789** ALVES');
    expect(razaoSemCpf('PEDRO CPF 123 456 789 01')).toBe('PEDRO CPF *** 456 789 **');
  });

  it('não toca o que não é CPF e é idempotente', () => {
    expect(razaoSemCpf('ACME 12.345.678/0001-90')).toBe('ACME 12.345.678/0001-90');
    expect(razaoSemCpf('ACME 1234567890')).toBe('ACME 1234567890');
    expect(razaoSemCpf('PEDRO ALVES COSTA ***456789**')).toBe('PEDRO ALVES COSTA ***456789**');
    expect(razaoSemCpf(null)).toBeNull();
  });

  it('nomeClienteExibicao: fantasia, senão razão, sempre sem o CPF', () => {
    expect(nomeClienteExibicao({ nome_fantasia: '', razao_social: 'PEDRO ALVES COSTA 12345678901' })).toBe(
      'PEDRO ALVES COSTA ***456789**',
    );
    expect(nomeClienteExibicao({ nome_fantasia: 'PEDRO 12345678901', razao_social: 'X' })).toBe('PEDRO ***456789**');
    expect(nomeClienteExibicao({ nome_fantasia: null, razao_social: null })).toBe('');
  });
});

// Fiação (revisão adversarial do Fable, M2): cada SAÍDA do nome do cliente passa pela máscara. Lê o fonte como texto —
// as funções puras acima provam a máscara; isto prova que ela está ligada onde o nome sai do app.
describe('a máscara está ligada nas saídas do nome do cliente', () => {
  const ler = (caminho: string) => readFileSync(resolve(process.cwd(), caminho), 'utf8');

  it('submitOrder: bloqueio de crédito, profileData do e-mail e lastOrderData usam nomeClienteExibicao', () => {
    const fonte = ler('src/services/orderSubmission/submitOrder.ts');
    expect(fonte).not.toMatch(/customer\.nome_fantasia \|\| customer\.razao_social/);
    expect(fonte.match(/nomeClienteExibicao\(customer\)/g)?.length).toBe(4);
  });

  it('edges: nenhuma resposta de busca devolve a razão ou o fantasia do Omie sem a máscara', () => {
    const cru = /^\s*(razao_social|nome_fantasia): (c|clienteCompleto|existingCliente)\.(razao_social|nome_fantasia)( \|\| "")?,$/m;
    for (const edge of [
      'supabase/functions/omie-vendas-sync/index.ts',
      'supabase/functions/omie-cliente/index.ts',
      'supabase/functions/omie-sync/index.ts',
      'supabase/functions/analyze-unified-order/index.ts',
    ]) {
      expect(ler(edge), edge).not.toMatch(cru);
    }
  });

  it('e-mail "Novo Pedido": assunto e corpo leem o nome mascarado, nunca profileData.name cru', () => {
    const fonte = ler('supabase/functions/omie-sync/index.ts');
    expect(fonte).toContain('const nomeCliente = razaoSemCpf(profileData.name);');
    expect(fonte).not.toMatch(/\$\{profileData\.name\}/);
  });
});
