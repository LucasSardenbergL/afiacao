// Form de registro de uso de benefício — validação (zod, campos string no
// idioma do repo: valores BR com vírgula) + montagem do payload numérico.
// Espelha os CHECKs da migration prime_fundacao NO CLIENTE para o staff receber
// erro claro ANTES do round-trip; o banco continua sendo a autoridade (os CHECKs
// existem lá — aqui é UX, não guarda).
import { z } from 'zod';
import {
  BONUS_DENTES_TETO,
  PRIME_TIPOS_MONETIZAVEIS,
  type PrimeBeneficioTipo,
  type PrimeBeneficioUsoInsert,
} from '@/types/prime';
import { valorAfiacao } from './competencia';

/** Valor monetário BR: até 2 casas (2 casas garantem q × preço EXATO nos dois lados). */
export const VALOR_BR_REGEX = /^\d{1,10}([.,]\d{1,2})?$/;
const INT_REGEX = /^\d{1,6}$/;

/** "1,20" | "1.20" → 1.2. Só chamar com valor já validado pela VALOR_BR_REGEX. */
export function parseValorBR(s: string): number {
  return Number(s.replace(',', '.'));
}

export const usoFormSchema = z
  .object({
    assinatura_id: z.string().min(1, 'Selecione a assinatura'),
    tipo: z.enum([
      'afiacao_dentes',
      'bonus_dentes',
      'desconto_abrasivo',
      'atendimento_tecnico',
      'prioridade_entrega',
      'prioridade_separacao',
      'coleta_rota',
    ]),
    /** Dentes (só afiação/bônus) — inteiro. */
    quantidade: z.string().trim(),
    /** R$/dente — só afiação. */
    preco_unitario: z.string().trim(),
    /** R$ do desconto concedido — só desconto_abrasivo. */
    valor_desconto: z.string().trim(),
    competencia: z
      .string()
      .regex(/^\d{4}-\d{2}-01$/, 'Competência deve ser o dia 1º do mês'),
    referencia: z.string().trim(),
    descricao: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    const erro = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    if (v.tipo === 'afiacao_dentes' || v.tipo === 'bonus_dentes') {
      if (!INT_REGEX.test(v.quantidade) || Number(v.quantidade) < 1) {
        erro('quantidade', 'Dentes são inteiros (mínimo 1)');
      } else if (v.tipo === 'bonus_dentes' && Number(v.quantidade) > BONUS_DENTES_TETO) {
        erro('quantidade', `Bônus: máximo ${BONUS_DENTES_TETO} dentes por concessão`);
      }
    }
    if (v.tipo === 'afiacao_dentes') {
      if (!VALOR_BR_REGEX.test(v.preco_unitario) || parseValorBR(v.preco_unitario) <= 0) {
        erro('preco_unitario', 'Preço/dente inválido (> 0, máx. 2 casas — ex.: 1,20)');
      }
    }
    if (v.tipo === 'desconto_abrasivo') {
      if (!VALOR_BR_REGEX.test(v.valor_desconto) || parseValorBR(v.valor_desconto) <= 0) {
        erro('valor_desconto', 'Valor do desconto inválido (> 0, máx. 2 casas)');
      }
    }
    if (PRIME_TIPOS_MONETIZAVEIS.includes(v.tipo) && v.referencia === '') {
      erro('referencia', 'Benefício monetizável exige a referência do pedido/NF Omie');
    }
  });

export type UsoFormValues = z.infer<typeof usoFormSchema>;

/**
 * Monta o INSERT a partir dos valores VALIDADOS. Regras espelhadas do banco:
 *  · afiação: valor = quantidade × preço/dente (centavos exatos) + snapshot;
 *  · desconto: quantidade fixa 1, valor manual;
 *  · bônus/operacional: valor NULL (ausente ≠ zero — nunca fabricar R$);
 *  · operacional: quantidade fixa 1.
 */
export function montarInsertUso(
  values: UsoFormValues,
  userId: string,
): PrimeBeneficioUsoInsert {
  const tipo: PrimeBeneficioTipo = values.tipo;
  const ehDentes = tipo === 'afiacao_dentes' || tipo === 'bonus_dentes';
  const quantidade = ehDentes ? Number(values.quantidade) : 1;
  const preco = tipo === 'afiacao_dentes' ? parseValorBR(values.preco_unitario) : null;

  return {
    assinatura_id: values.assinatura_id,
    tipo,
    quantidade,
    valor_tabela:
      tipo === 'afiacao_dentes'
        ? valorAfiacao(quantidade, preco ?? 0)
        : tipo === 'desconto_abrasivo'
          ? parseValorBR(values.valor_desconto)
          : null,
    preco_unitario_snapshot: preco,
    competencia: values.competencia,
    referencia: values.referencia.trim() || null,
    descricao: values.descricao.trim() || null,
    created_by: userId,
  };
}
