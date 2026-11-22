// Onda 3 da tela Clientes: o que a ficha 360 pode AFIRMAR sobre crédito e próxima ação. Funções PURAS.
// Ausente ≠ zero: falha de leitura nunca vira "nada vencido" nem "nenhuma tarefa".

/** Forma do crédito da ficha (espelha `CreditoDaFicha` de useAlertaCreditoCliente — tipo estrutural). */
export interface CreditoLido {
  semConta: boolean;
  conflito: boolean;
  aliasesConferidos: boolean;
  alerta: {
    vencido: number;
    titulos: number;
    vencimentoMaisAntigo: string | null;
    syncAt: string | null;
    dadoDefasado: boolean;
  } | null;
}

export type TomCredito = 'neutro' | 'ok' | 'alerta';

export interface ResumoCredito {
  tom: TomCredito;
  titulo: string;
  /** Ressalvas que mudam a leitura (soma parcial, sync defasado). */
  notas: string[];
}

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const dataBr = (iso: string) => {
  const [a, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${a}`;
};

/**
 * Crédito na ficha. Não existe LIMITE de crédito no banco — o que se afirma é o vencido há 60+ dias
 * (a mesma régua do alerta do pedido), nas 3 empresas do grupo.
 */
export function resumoCredito(
  estado: 'carregando' | 'falha' | 'ok',
  dado: CreditoLido | undefined,
): ResumoCredito {
  if (estado === 'carregando') return { tom: 'neutro', titulo: 'Lendo o contas a receber…', notas: [] };
  if (estado === 'falha' || !dado) return { tom: 'neutro', titulo: 'Crédito indisponível (a leitura falhou)', notas: [] };
  if (dado.conflito) {
    return { tom: 'neutro', titulo: 'Cadastro do grupo em conflito — não somei os títulos', notas: [] };
  }
  if (dado.semConta) return { tom: 'neutro', titulo: 'Sem conta Omie vinculada a este cliente', notas: [] };

  const notas: string[] = [];
  if (!dado.aliasesConferidos) notas.push('Sem conferir o 2º cadastro do grupo (só gestor ou master enxerga) — a soma pode ser parcial.');
  const a = dado.alerta;
  if (a?.dadoDefasado) {
    notas.push(a.syncAt ? `Financeiro sincronizado em ${dataBr(a.syncAt)} — pode estar defasado.` : 'Sem registro de sync do financeiro — pode estar defasado.');
  }
  if (!a) return { tom: 'ok', titulo: 'Nenhum título vencido há 60+ dias', notas };
  const desde = a.vencimentoMaisAntigo ? ` · desde ${dataBr(a.vencimentoMaisAntigo)}` : '';
  const titulos = a.titulos === 1 ? '1 título' : `${a.titulos} títulos`;
  return { tom: 'alerta', titulo: `${brl(a.vencido)} vencido há 60+ dias · ${titulos}${desde}`, notas };
}

/** Quando vence a tarefa, para a linha da "Próxima ação". Atrasada vence a frase. */
export function rotuloPrazoTarefa(t: { atrasada: boolean; effective_due: string | null }): string {
  if (t.atrasada) return 'atrasada';
  return t.effective_due ? `até ${dataBr(t.effective_due)}` : 'sem prazo';
}
