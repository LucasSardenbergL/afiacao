// Borda das leituras do Prime (money-path: mensalidade, franquia, uso de benefício). O `types.ts`
// tipa `status`/`tipo` como texto, `beneficios` como jsonb e toda coluna da view como `| null`.
// O jeito antigo era um cliente `any` + `as PrimeX[]`, que afirmava vocabulário e NOT NULL sem
// conferir. Aqui cada vocabulário é conferido contra o CHECK da prod (psql-ro, 2026-10-21) e a view
// exige o que o corpo dela garante: desvio LANÇA com a coluna — nunca vira default nem 0.
import type { Json, Tables } from '@/integrations/supabase/types';
import { exigirColunas } from '@/lib/linha-view';
import type {
  PrimeAssinatura,
  PrimeAssinaturaStatus,
  PrimeBeneficioTipo,
  PrimeBeneficioUso,
  PrimeExtratoMensal,
  PrimePlano,
} from '@/types/prime';

const STATUS = ['ativa', 'suspensa', 'cancelada'] as const satisfies readonly PrimeAssinaturaStatus[];
const TIPOS = [
  'afiacao_dentes', 'bonus_dentes', 'desconto_abrasivo', 'atendimento_tecnico',
  'prioridade_entrega', 'prioridade_separacao', 'coleta_rota',
] as const satisfies readonly PrimeBeneficioTipo[];

// Completude em tempo de compilação: valor novo no tipo do domínio sem entrar aqui → erro de tipo.
type FaltaStatus = Exclude<PrimeAssinaturaStatus, (typeof STATUS)[number]>;
type FaltaTipo = Exclude<PrimeBeneficioTipo, (typeof TIPOS)[number]>;
const completo: [FaltaStatus | FaltaTipo] extends [never] ? true : FaltaStatus | FaltaTipo = true;
void completo;

function status(v: string, fonte: string): PrimeAssinaturaStatus {
  const s = STATUS.find((x) => x === v);
  if (!s) throw new Error(`${fonte}: "status" = "${v}" fora do vocabulário`);
  return s;
}

/** `beneficios` é copy (lista de textos, não sinal money-path): item que não é texto é descartado. */
function textos(v: Json): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function paraPrimePlano(l: Tables<'prime_planos'>): PrimePlano {
  return { ...l, beneficios: textos(l.beneficios) };
}

export function paraPrimeAssinatura(l: Tables<'prime_assinaturas'>): PrimeAssinatura {
  return { ...l, status: status(l.status, 'prime_assinaturas') };
}

export function paraPrimeBeneficioUso(l: Tables<'prime_beneficio_uso'>): PrimeBeneficioUso {
  const tipo = TIPOS.find((x) => x === l.tipo);
  if (!tipo) throw new Error(`prime_beneficio_uso: "tipo" = "${l.tipo}" fora do vocabulário`);
  return { ...l, tipo };
}

/**
 * Linha de `v_prime_extrato_mensal`. Só `monetizado_total`, `dentes_usados` e `dentes_bonus` podem ser
 * NULL (agregados do LEFT JOIN — "não houve registro", ≠ 0); o resto vem de `prime_assinaturas`
 * (NOT NULL) ou de COALESCE, e é EXIGIDO.
 */
export function paraPrimeExtrato(l: Tables<'v_prime_extrato_mensal'>): PrimeExtratoMensal {
  const f = 'v_prime_extrato_mensal';
  exigirColunas(
    l,
    ['assinatura_id', 'customer_user_id', 'status', 'competencia', 'mensalidade_contratada', 'franquia_total',
      'dentes_restantes', 'dentes_excedentes', 'usos_operacionais', 'n_registros'],
    f,
  );
  return {
    assinatura_id: l.assinatura_id,
    customer_user_id: l.customer_user_id,
    status: status(l.status, f),
    competencia: l.competencia,
    mensalidade_contratada: l.mensalidade_contratada,
    monetizado_total: l.monetizado_total,
    dentes_usados: l.dentes_usados,
    dentes_bonus: l.dentes_bonus,
    franquia_total: l.franquia_total,
    dentes_restantes: l.dentes_restantes,
    dentes_excedentes: l.dentes_excedentes,
    usos_operacionais: l.usos_operacionais,
    n_registros: l.n_registros,
  };
}
