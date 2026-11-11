// Espelho em `src/` da máscara de `supabase/functions/_shared/razao-fiscal.ts` (a edge não importa de src/ e vice-versa):
// o CPF do titular de MEI na razão social vira 'FULANO ***456789**', como a `private.radar_razao_mascarada` faz no banco.
// A paridade da expressão é conferida como TEXTO em razao-exibicao.test.ts.
//
// Uso: a SAÍDA de exibição do fluxo do pedido (impressão, `lastOrderData`, bloqueio de crédito, `profileData` que vira
// o e-mail "Novo Pedido"). As edges já devolvem a razão mascarada desde 2026-11-11 (M1 da revisão do Fable); esta é a
// segunda trava, para cliente carregado de qualquer outra fonte. A razão FISCAL (`razao_fiscal`) só vai ao payload do
// autocadastro (`payloadAutoCadastro`), nunca passa por aqui.

/** Máscara do CPF em texto livre: espelho exato do `CPF_LIVRE` de `_shared/razao-fiscal.ts`. */
const CPF_LIVRE = /(?<![0-9])[0-9]{3}([ ./-]{0,3}[0-9]{3}[ ./-]{0,3})([0-9]{3})([ ./-]{0,3})[0-9]{2}(?![0-9])/g;

/** Troca todo CPF do texto pela máscara (dígitos 4 a 9 visíveis). */
export function razaoSemCpf<T extends string | null | undefined>(razao: T): T {
  if (typeof razao !== 'string') return razao;
  return razao.replace(CPF_LIVRE, '***$1$2$3**') as T;
}

/** O nome do cliente que sai do app (impressão, e-mail, bloqueio de crédito): fantasia, senão razão — sem CPF. */
export function nomeClienteExibicao(cliente: { nome_fantasia?: string | null; razao_social?: string | null }): string {
  return razaoSemCpf(cliente.nome_fantasia || cliente.razao_social || '');
}
