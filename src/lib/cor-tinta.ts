// Descrição da COR de tinta de um item — única para o cupom impresso (as duas vias) e para a mensagem
// de WhatsApp.
//
// POR QUE EXISTE (revisão /sales #24): o cupom só escrevia a cor quando o item tinha `tint_cor_id` E
// `tint_nome_cor`, e a mensagem só quando tinha o id. O sync grava, na maioria, SÓ o nome — em
// 2026-11-27 eram 6.556 itens vivos de `sales_orders` com o nome e sem o id (7 com os dois). O cliente
// recebia o cupom e a mensagem de uma base tintométrica sem dizer de que cor.
//
// Regra: escreve o que se sabe. Do nome sai SÓ o sufixo " - BS" (marca de base, 5.148 dos itens com
// nome em 2026-11-27); o resto fica inteiro. O cupom cortava "a última parte quando havia mais de
// duas", e isso apagava a própria cor de ~76 itens ("346J - ACRIL BS - PLATINA BIANCA" saía
// "346J - ACRIL BS") — achado do Codex no desenho. A embalagem vem da descrição.
// Sem id e sem nome → `null` (a linha de cor não aparece).

const EMBALAGEM = /\b(QT|GL|LT|BD|BH|5L)\b/i;
const SUFIXO_BASE = /\s+-\s*BS\s*$/i;

function texto(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export function textoDaCor(corId: unknown, nomeCor: unknown, descricao: unknown): string | null {
  const id = texto(corId);
  const nome = texto(nomeCor);
  if (id === null && nome === null) return null;
  const semBase = nome === null ? null : nome.replace(SUFIXO_BASE, '').trim();
  const nomeSimples = semBase === null || semBase === '' ? nome : semBase;
  const emb = typeof descricao === 'string' ? descricao.match(EMBALAGEM)?.[1]?.toUpperCase() ?? null : null;
  return [id, nomeSimples, emb].filter((p): p is string => p !== null).join(' - ');
}
