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
  /** Frescor do contas a receber por empresa lida (espelha `FrescorEmpresa`). */
  frescor: Array<{ company: string; syncAt: string | null; estado: 'ok' | 'defasado' | 'erro' | 'nunca' }>;
}

const NOME_EMPRESA: Record<string, string> = { oben: 'Oben', colacor: 'Colacor', colacor_sc: 'Colacor SC' };
const nomeEmpresa = (c: string) => NOME_EMPRESA[c] ?? c;

/** Uma ressalva por empresa que não está `ok` — o motivo dito, nunca um "defasado" genérico. */
function notasFrescor(frescor: CreditoLido['frescor']): string[] {
  return frescor.filter((f) => f.estado !== 'ok').map((f) => {
    const nome = nomeEmpresa(f.company);
    const quando = f.syncAt ? ` (último sync concluído em ${dataBr(f.syncAt)})` : '';
    if (f.estado === 'erro') return `${nome}: o último sync do financeiro falhou${quando}.`;
    if (f.estado === 'nunca') return `${nome}: o financeiro nunca foi sincronizado.`;
    return `${nome}: financeiro sincronizado em ${f.syncAt ? dataBr(f.syncAt) : '—'} — pode estar defasado.`;
  });
}

type TomCredito = 'neutro' | 'ok' | 'alerta';

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
  notas.push(...notasFrescor(dado.frescor));
  if (!a) {
    // "Sem títulos" só é verde quando TODAS as empresas lidas estão frescas. Com falha/nunca, não se
    // afirma nada; defasada, afirma-se até a data do sync (onda B — antes a data se perdia aqui).
    const cegas = dado.frescor.filter((f) => f.estado === 'erro' || f.estado === 'nunca');
    if (dado.frescor.length === 0 || cegas.length > 0) {
      return { tom: 'neutro', titulo: 'Crédito não confirmado: o financeiro não está sincronizado', notas };
    }
    if (dado.frescor.some((f) => f.estado === 'defasado')) {
      return { tom: 'neutro', titulo: 'Nenhum título vencido há 60+ dias no último sync', notas };
    }
    return { tom: 'ok', titulo: 'Nenhum título vencido há 60+ dias', notas };
  }
  const desde = a.vencimentoMaisAntigo ? ` · desde ${dataBr(a.vencimentoMaisAntigo)}` : '';
  const titulos = a.titulos === 1 ? '1 título' : `${a.titulos} títulos`;
  return { tom: 'alerta', titulo: `${brl(a.vencido)} vencido há 60+ dias · ${titulos}${desde}`, notas };
}

/** Quando vence a tarefa, para a linha da "Próxima ação". Atrasada vence a frase. */
export function rotuloPrazoTarefa(t: { atrasada: boolean; effective_due: string | null }): string {
  if (t.atrasada) return 'atrasada';
  return t.effective_due ? `até ${dataBr(t.effective_due)}` : 'sem prazo';
}
