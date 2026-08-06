// Cota de IA por usuário — cliente da RPC `ia_consumir_cota` e as mensagens que
// o usuário lê quando a cota morde.
//
// Existe porque os limites da Anthropic são ORGANIZACIONAIS: um usuário
// repetindo chamadas até bater 429/402 derruba a IA de todos os outros e de
// todas as edges. O gate "customer pode usar" está correto — o que faltava era
// o throttle.
//
// Sem import remoto de propósito: `test:edges` roda com `--no-remote`, então o
// cliente entra por interface ESTRUTURAL mínima e o teste usa um duplo. Isso
// mantém o módulo inteiro exercitável sem rede.

/** O mínimo do cliente Supabase que este módulo precisa. */
export interface ClienteRpc {
  rpc(
    nome: string,
    args: Record<string, unknown>,
  ): Promise<{ data: unknown; error: unknown }>;
}

export type ResultadoCota =
  | {
    permitido: true;
    /** Informativos. `null` quando a RPC não devolveu número utilizável —
     *  ausente não vira zero (o consumo já foi registrado de qualquer forma). */
    usadoHora: number | null;
    limiteHora: number | null;
    usadoDia: number | null;
    limiteDia: number | null;
  }
  | {
    permitido: false;
    http: number;
    mensagem: string;
    /** Segundos para o header `Retry-After`; ausente quando não há espera útil. */
    retryAposSegundos?: number;
  };

const MENSAGEM_INDISPONIVEL =
  "Não consegui verificar seu limite de uso agora. Tente de novo em instantes.";
const MENSAGEM_SEM_LIMITE =
  "Limite de uso não configurado para esta função — avise a equipe.";

function numeroFinito(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Espera em português, SEMPRE relativa.
 *
 * Hora absoluta exigiria converter UTC (banco) para America/Sao_Paulo (balcão) —
 * um erro de fuso aqui produziria "libera às 11:35" quando faltam três horas, e
 * ninguém notaria. Arredonda para CIMA: mandar o usuário voltar cedo demais
 * frustra mais do que uma estimativa folgada.
 */
export function formatarEspera(segundos: number): string {
  if (!Number.isFinite(segundos) || segundos <= 0) return "instantes";
  if (segundos < 60) return "menos de um minuto";

  // Arredonda para minutos UMA vez e só então quebra em h/min. Arredondar nos
  // dois níveis criava a fronteira em que 3599s virava "60 minutos".
  const totalMin = Math.ceil(segundos / 60);
  if (totalMin < 60) return totalMin === 1 ? "1 minuto" : `${totalMin} minutos`;

  const horas = Math.floor(totalMin / 60);
  const minutos = totalMin % 60;
  if (minutos === 0) return horas === 1 ? "1 hora" : `${horas} horas`;
  return `${horas}h${minutos}min`;
}

/**
 * Traduz a linha da RPC no que a edge devolve.
 *
 * FAIL-CLOSED: qualquer coisa que não seja uma linha reconhecível vira 503 com
 * mensagem própria. Deixar passar na dúvida transformaria um soluço do banco na
 * janela por onde o orçamento vaza.
 *
 * `rotulo` é o nome da ação na voz do usuário ("identificações por foto"), não
 * o slug da edge — quem lê a mensagem é a pessoa no balcão.
 */
export function interpretarCota(payload: unknown, rotulo: string): ResultadoCota {
  // A RPC é RETURNS TABLE: o supabase-js entrega array de linhas.
  const linha = Array.isArray(payload) ? payload[0] : payload;
  if (!linha || typeof linha !== "object") {
    return { permitido: false, http: 503, mensagem: MENSAGEM_INDISPONIVEL };
  }

  const l = linha as Record<string, unknown>;
  if (typeof l.permitido !== "boolean") {
    return { permitido: false, http: 503, mensagem: MENSAGEM_INDISPONIVEL };
  }

  if (l.permitido) {
    return {
      permitido: true,
      usadoHora: numeroFinito(l.usado_hora),
      limiteHora: numeroFinito(l.limite_hora),
      usadoDia: numeroFinito(l.usado_dia),
      limiteDia: numeroFinito(l.limite_dia),
    };
  }

  if (l.motivo === "sem_limite") {
    return { permitido: false, http: 503, mensagem: MENSAGEM_SEM_LIMITE };
  }

  const espera = numeroFinito(l.libera_em_segundos);
  const limiteHora = numeroFinito(l.limite_hora);
  const limiteDia = numeroFinito(l.limite_dia);

  // O número entra na frase. Sem ele não dá para dizer "seu limite de N" sem
  // inventar o N — cai no genérico em vez de fabricar.
  if (l.motivo === "hora" && limiteHora !== null) {
    return {
      permitido: false,
      http: 429,
      mensagem:
        `Você atingiu seu limite de ${limiteHora} ${rotulo} nesta hora — é o seu limite de uso, ` +
        `não uma falha da IA. Libera em ${formatarEspera(espera ?? 0)}.`,
      retryAposSegundos: espera ?? undefined,
    };
  }

  if (l.motivo === "dia" && limiteDia !== null) {
    return {
      permitido: false,
      http: 429,
      mensagem:
        `Você atingiu seu limite de ${limiteDia} ${rotulo} por dia — é o seu limite de uso, ` +
        `não uma falha da IA. Libera em ${formatarEspera(espera ?? 0)}.`,
      retryAposSegundos: espera ?? undefined,
    };
  }

  return { permitido: false, http: 503, mensagem: MENSAGEM_INDISPONIVEL };
}

/**
 * Consome uma unidade da cota do usuário. Chame DEPOIS de autenticar e de
 * validar o input (requisição malformada não deve queimar cota) e ANTES de
 * chamar a Anthropic.
 */
export async function consumirCota(
  cliente: ClienteRpc,
  userId: string,
  funcao: string,
  rotulo: string,
): Promise<ResultadoCota> {
  try {
    const { data, error } = await cliente.rpc("ia_consumir_cota", {
      p_user_id: userId,
      p_funcao: funcao,
    });
    if (error) {
      console.error(`[ia-cota] RPC falhou para ${funcao}:`, error);
      return { permitido: false, http: 503, mensagem: MENSAGEM_INDISPONIVEL };
    }
    return interpretarCota(data, rotulo);
  } catch (e: unknown) {
    console.error(`[ia-cota] erro ao consumir cota de ${funcao}:`, e);
    return { permitido: false, http: 503, mensagem: MENSAGEM_INDISPONIVEL };
  }
}

/** Headers do 429, para a edge anexar aos seus próprios. */
export function headersDeCota(r: ResultadoCota): Record<string, string> {
  if (r.permitido || r.retryAposSegundos === undefined) return {};
  return { "Retry-After": String(Math.max(1, Math.ceil(r.retryAposSegundos))) };
}
