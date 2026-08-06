// Tradutor dos erros do banco (guards da migration prime_fundacao) para
// mensagens de UI em pt-BR. Os triggers/CHECKs enforcem a honestidade
// money-path NO BANCO; a UI só traduz — nunca contorna.
//
// SQLSTATEs esperados:
//  · P0001 — RAISE dos triggers (vigência, append-only, grandfathering, janela);
//  · 23505 — UNIQUEs parciais (1 assinatura viva; 1 bônus vivo/mês);
//  · 23514 — CHECKs de honestidade (valor por tipo, contrafactual, teto);
//  · 42501 — RLS (não deve acontecer atrás do gate staff — defensivo).

interface ErroSupabase {
  code?: string;
  message?: string;
  details?: string;
}

function textoDe(error: unknown): ErroSupabase {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    return {
      code: typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
      details: typeof e.details === 'string' ? e.details : undefined,
    };
  }
  return { message: typeof error === 'string' ? error : undefined };
}

/** Regras na ordem de especificidade — a primeira que casar vence. */
const TRADUCOES: Array<{ quando: RegExp; mensagem: string }> = [
  // ── P0001 (triggers) ──
  {
    quando: /assinatura cobrindo o mês de início/i,
    mensagem:
      'Este cliente já tem assinatura cobrindo esse mês — a competência não pode duplicar no extrato. Inicie em um mês posterior ao fim da assinatura anterior.',
  },
  {
    quando: /campos contratuais da assinatura são imutáveis/i,
    mensagem:
      'Campos contratuais são imutáveis (grandfathering). Para mudar condição: cancele esta assinatura e abra um novo ciclo.',
  },
  {
    quando: /deixaria uso vivo fora do extrato/i,
    mensagem:
      'Essa janela deixaria uso registrado FORA do extrato. Estorne os usos fora do período antes de suspender/cancelar com essa data.',
  },
  {
    quando: /uso bloqueado \(suspensa\/cancelada congela franquia\)/i,
    mensagem:
      'Assinatura suspensa/cancelada não aceita registro de uso — a franquia está congelada. Reative a assinatura antes.',
  },
  {
    quando: /assinatura inexistente/i,
    mensagem: 'Assinatura não encontrada — recarregue a lista.',
  },
  {
    quando: /competência fora da vigência/i,
    mensagem:
      'Competência fora da vigência da assinatura (anterior ao mês de início ou futura).',
  },
  {
    quando: /registro já estornado é imutável/i,
    mensagem: 'Este registro já foi estornado — registro estornado é imutável.',
  },
  {
    quando: /append-only — correção é estorno/i,
    mensagem:
      'Registro monetário é append-only: correção é ESTORNO (e novo registro), nunca edição.',
  },
  {
    quando: /estorno exige estornado_em e estornado_por/i,
    mensagem: 'Estorno exige usuário autenticado — recarregue e tente de novo.',
  },
  // ── 23505 (UNIQUEs parciais) ──
  {
    quando: /uq_prime_bonus_mes/i,
    mensagem:
      'Já existe bônus cross-sell vivo neste mês para esta assinatura (limite: 1 por mês). Para re-conceder, estorne o existente.',
  },
  {
    quando: /uq_prime_assinatura_viva/i,
    mensagem: 'Este cliente já tem uma assinatura viva (limite: 1 por cliente).',
  },
  // ── 23514 (CHECKs) ──
  {
    quando: /prime_uso_afiacao_consistente/i,
    mensagem:
      'Afiação exige preço/dente (> 0) e valor = quantidade × preço/dente (contrafactual auditável).',
  },
  {
    quando: /prime_uso_valor_por_tipo/i,
    mensagem:
      'Benefício monetizável exige valor de tabela (> 0) e referência do pedido Omie; operacional/bônus não leva valor (ausente ≠ zero).',
  },
  {
    quando: /prime_uso_snapshot_so_afiacao/i,
    mensagem: 'Preço/dente só se aplica a afiação.',
  },
  {
    quando: /prime_uso_quantidade_por_tipo/i,
    mensagem: 'Dentes são inteiros; evento operacional tem quantidade fixa 1.',
  },
  {
    quando: /prime_uso_bonus_teto/i,
    mensagem: 'Bônus cross-sell: máximo de 50 dentes por concessão.',
  },
  {
    quando: /prime_uso_estorno_par/i,
    mensagem: 'Estorno inconsistente — recarregue e tente de novo.',
  },
  {
    quando: /competencia_check|prime_beneficio_uso.*competencia/i,
    mensagem: 'Competência deve ser o dia 1º do mês.',
  },
  {
    quando: /prime_assinatura_status_datas/i,
    mensagem:
      'Estado inconsistente: ativa não tem datas de fim/suspensão; suspensa exige data de suspensão; cancelada exige data de fim.',
  },
  {
    quando: /preco_mensal_check/i,
    mensagem: 'Preço mensal do plano deve ser maior que zero.',
  },
  {
    quando: /preco_contratado_check/i,
    mensagem: 'Preço contratado deve ser maior que zero.',
  },
  {
    quando: /franquia_dentes(_contratada)?_check/i,
    mensagem: 'Franquia de dentes não pode ser negativa.',
  },
  {
    quando: /data_fim_check/i,
    mensagem: 'Data de fim não pode ser anterior à data de início.',
  },
  {
    quando: /suspensa_em_check/i,
    mensagem: 'Data de suspensão não pode ser anterior à data de início.',
  },
];

/**
 * Traduz um erro do Supabase/PostgREST vindo dos guards do Prime para uma
 * mensagem de toast em pt-BR. Fallback: a própria mensagem do banco (os RAISE
 * da migration já são pt-BR) — nunca engolir o erro.
 */
export function traduzirErroPrime(error: unknown): string {
  const { code, message, details } = textoDe(error);
  const texto = [message, details].filter(Boolean).join(' — ');

  for (const { quando, mensagem } of TRADUCOES) {
    if (quando.test(texto)) return mensagem;
  }

  if (code === '42501') {
    return 'Sem permissão para esta ação (exige staff).';
  }
  if (code === '23505') {
    return 'Registro duplicado — já existe um equivalente vivo.';
  }

  return texto || 'Erro inesperado ao falar com o banco.';
}
