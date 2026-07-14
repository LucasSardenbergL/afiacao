// Formata a cesta de recompra (montarCestaRecompra) no TEXTO da proposta accept-a-proposal.
// PURO/testável. A CÓPIA é parametrizável (defaults sensatos informados por benchmark BEES/Yalo:
// propor a cesta pronta + CTA claro) — a wording final é do founder (brand-voice), trocável via opts
// sem tocar código. O texto produzido vira a variável dinâmica do template Meta aprovado.

import type { CestaItem, CestaResult } from './cesta-recompra';

export interface PropostaOpts {
  nomesPorSku: Record<number, string>; // SKU → descrição (orquestrador enriquece via omie_products)
  primeiroNome?: string;
  saudacao?: (nome?: string) => string;
  introPrincipal?: string;
  introSecundario?: string;
  cta?: string;
  maxSecundarios?: number; // default 3 — não inflar a mensagem (codex: cesta enxuta)
  crossSell?: { nome: string }[];  // camada "experimente também" (complementar; codex: pós-piloto)
  introCrossSell?: string;
}
export interface PropostaFormatada {
  texto: string;
  itensPrincipais: number;
  vazia: boolean; // true = nada a propor (orquestrador NÃO envia)
}

export function fmtQty(q: number): string {
  return Number.isInteger(q) ? String(q) : String(Math.round(q * 10) / 10);
}

export function formatarLinhaItem(item: CestaItem, nomesPorSku: Record<number, string>): string {
  const nome = nomesPorSku[item.omie_codigo_produto] ?? `Cód. ${item.omie_codigo_produto}`;
  return `• ${fmtQty(item.qtdSugerida)}× ${nome}`;
}

const saudacaoDefault = (nome?: string) => (nome ? `Olá, ${nome}! ` : 'Olá! ');

export function formatarPropostaRecompra(cesta: CestaResult, opts: PropostaOpts): PropostaFormatada {
  if (cesta.principal.length === 0) return { texto: '', itensPrincipais: 0, vazia: true };

  const saud = (opts.saudacao ?? saudacaoDefault)(opts.primeiroNome);
  const introP = opts.introPrincipal ?? 'Vi que você costuma repor:';
  const introS = opts.introSecundario ?? 'Você também costuma levar:';
  const cta = opts.cta ?? 'Quer que eu já separe pra entrega de amanhã? 🚚';
  const maxSec = opts.maxSecundarios ?? 3;

  const linhas: string[] = [`${saud}${introP}`, ...cesta.principal.map(i => formatarLinhaItem(i, opts.nomesPorSku))];

  const sec = cesta.secundarios.slice(0, maxSec);
  if (sec.length > 0) {
    linhas.push('', introS, ...sec.map(i => formatarLinhaItem(i, opts.nomesPorSku)));
  }

  const cross = opts.crossSell ?? [];
  if (cross.length > 0) {
    const introX = opts.introCrossSell ?? 'Que tal experimentar também:';
    linhas.push('', introX, ...cross.map(x => `• ${x.nome}`));
  }

  linhas.push('', cta);

  return { texto: linhas.join('\n'), itensPrincipais: cesta.principal.length, vazia: false };
}
