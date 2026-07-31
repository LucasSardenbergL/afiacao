// Ordem de execução dos alvos do batch noturno de planos táticos.
//
// Lógica PURA extraída para caber no `--no-remote` do `test:edges`.
// Testes (e o histórico do incidente) em tactical-ordem_test.ts.
//
// POR QUE EXISTE — o batch concatenava os grupos do Map por farmer (`[A...A, B...B, C...C]`),
// e essa ordem era ACIDENTAL: vinha da primeira ocorrência de cada farmer na paginação por
// customer_user_id. Qualquer cobertura parcial come o SUFIXO, então o último farmer da
// concatenação nunca recebia nada — medido em prod: 9/15/0 (30/07) e 9/16/0 (31/07), com o
// mesmo farmer zerado nos dois dias, e o precedente de 2026-07-21 ("uma vendedora inteira
// ficou sem plano", ver tactical-batch-resultado.ts).
//
// Este módulo NÃO conserta o volume — cobertura parcial continua possível por timeout, 429
// ou 402. Ele garante que, quando ela acontecer, a perda seja DISTRIBUÍDA: com round-robin,
// um prefixo de 24 sobre 9/25/25 vira 8/8/8 em vez de 9/15/0.

export interface CarteiraFarmer {
  farmer: string;
  /** Clientes JÁ ordenados pelo caller (priority desc, customer_user_id asc). */
  clientes: string[];
}

export interface AlvoOrdenado {
  farmer: string;
  customer: string;
}

const MS_POR_DIA = 86_400_000;

/**
 * Deslocamento da rodada a partir do dia operacional (BRT), no formato `YYYY-MM-DD`.
 *
 * Quando o prefizo executado não é divisível pelo número de farmers, o(s) alvo(s) extra(s)
 * vão para quem abre a rodada. Fixar esse "quem" beneficiaria sempre a mesma vendedora, então
 * ele ROTACIONA por dia — +1 por dia, previsível o bastante para auditar depois.
 *
 * Estável DENTRO do mesmo dia de propósito: um retry do batch tem de reproduzir a mesma
 * ordem, senão a janela de idempotência por dia operacional vira loteria.
 *
 * Data ilegível → 0 em vez de NaN: NaN viraria índice inválido e derrubaria o batch inteiro
 * por causa de uma string, quando seguir sem rotação é degradação honesta.
 */
export function rotacaoDoDia(diaIso: string): number {
  const ms = Date.parse(`${diaIso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return 0;
  // Clamp em 0: data anterior à epoch daria índice negativo no array de farmers.
  return Math.max(0, Math.floor(ms / MS_POR_DIA));
}

/**
 * Intercala os alvos em round-robin: um cliente de cada farmer por rodada, preservando a
 * ordem interna de cada carteira. Farmer que acaba antes simplesmente sai das rodadas
 * seguintes — os demais continuam.
 */
export function intercalarPorFarmer(
  carteiras: CarteiraFarmer[],
  rotacao: number,
): AlvoOrdenado[] {
  if (carteiras.length === 0) return [];

  // Módulo não-negativo: rotação negativa ou fracionária não pode virar índice inválido.
  const desloc = ((Math.trunc(rotacao) % carteiras.length) + carteiras.length) % carteiras.length;
  const ordem = carteiras.map((_, i) => carteiras[(i + desloc) % carteiras.length]);

  const maior = Math.max(...ordem.map((c) => c.clientes.length));
  const alvos: AlvoOrdenado[] = [];
  for (let i = 0; i < maior; i++) {
    for (const c of ordem) {
      const customer = c.clientes[i];
      if (customer !== undefined) alvos.push({ farmer: c.farmer, customer });
    }
  }
  return alvos;
}
