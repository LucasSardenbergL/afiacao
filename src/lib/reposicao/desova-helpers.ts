// Missão de desova (programa Cabreúva-Colacor, PR2 — fase 1 SEM preço):
// a fila de excesso já diz "a saída é comercial (queima/kit) ou descontinuar";
// aqui o diagnóstico vira TAREFA rastreável pro comercial. A régua Renner é
// "menos remarcação via ação cedo" — e a régua money-path da casa vale na cópia:
// capital com cmc ausente é NÃO MEDIDO (piso explícito), nunca R$0.
export type AlvoDesova = {
  sku_codigo_omie: number;
  sku_descricao: string | null;
  excedente_un: number;
  capital_excedente: number | null;   // null = cmc ausente (nunca tratar como 0)
  tempo_digerir_dias: number | null;  // null = sem giro (demanda média zero)
  dias_sem_vender: number | null;
};

export type MissaoDesova = {
  titulo: string;
  descricao: string;
  capitalTotal: number;        // só a fatia MEDIDA
  capitalIncompleto: boolean;  // há alvo sem capital medido → total é piso
};

const MAX_SKUS_LISTADOS = 8;

// NBSP do Intl (U+00A0 após "R$") → espaço comum: a descrição vira texto plano de
// tarefa/WhatsApp, onde o não-quebrável rende mal e quebra busca por string.
const brl0 = (x: number) =>
  x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).replace(/\u00A0/g, ' ');

export function formatarMissaoDesova(alvos: AlvoDesova[]): MissaoDesova {
  const medidos = alvos.filter((a) => a.capital_excedente != null && Number.isFinite(a.capital_excedente));
  const capitalTotal = medidos.reduce((s, a) => s + (a.capital_excedente as number), 0);
  const capitalIncompleto = medidos.length < alvos.length;
  const plural = alvos.length === 1 ? 'SKU' : 'SKUs';
  const capitalLabel = capitalIncompleto ? `≥ ${brl0(capitalTotal)} presos (parcial)` : `${brl0(capitalTotal)} presos`;
  const titulo = `Desova de excesso — ${alvos.length} ${plural}, ${capitalLabel}`;

  const linhas = alvos.slice(0, MAX_SKUS_LISTADOS).map((a) => {
    const nome = a.sku_descricao?.trim() ? `${a.sku_codigo_omie} — ${a.sku_descricao.trim()}` : String(a.sku_codigo_omie);
    const capital = a.capital_excedente != null && Number.isFinite(a.capital_excedente)
      ? brl0(a.capital_excedente)
      : 'capital não medido (sem CMC)';
    const digestao = a.tempo_digerir_dias != null ? `digere em ${a.tempo_digerir_dias}d` : 'sem giro';
    const parado = a.dias_sem_vender != null ? ` · ${a.dias_sem_vender}d sem vender` : '';
    return `• ${nome}: ${a.excedente_un} un excedentes · ${capital} · ${digestao}${parado}`;
  });
  const resto = alvos.length - MAX_SKUS_LISTADOS;
  if (resto > 0) linhas.push(`… e mais ${resto} SKUs (lista completa na fila de excesso)`);

  const descricao = [
    `${titulo}.`,
    'Ação: oferecer/queimar comercialmente (kit, bundle, oferta dirigida) — o motor NÃO compra estes SKUs enquanto houver excesso.',
    ...linhas,
  ].join('\n');

  return { titulo, descricao, capitalTotal, capitalIncompleto };
}
