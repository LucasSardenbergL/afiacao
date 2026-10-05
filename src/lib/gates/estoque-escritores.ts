// Detector do gate `estoque-escritores` (src/__tests__/estoque-escritores-gate.test.ts): o que uma fonte
// de edge ESCREVE nos espelhos de estoque do Omie, se chama o zero confirmado e quantos zeros LITERAIS
// de saldo/estoque ela carrega. Lê a fonte SEM comentários (escrita comentada não conta). Calibração:
// src/lib/gates/__tests__/estoque-escritores.test.ts. Diário: docs/historico/estoque-dono-unico.md.
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

type TabelaEstoque = 'inventory_position' | 'omie_products';

export interface AnaliseEscritor {
  tabelas: TabelaEstoque[];
  chamaZeroConfirmado: boolean;
  zerosLiterais: number;
}

const escrita = (tabela: string) =>
  new RegExp(`\\.from\\(\\s*["'\`]${tabela}["'\`]\\s*\\)\\s*\\.\\s*(?:upsert|update|insert)\\s*\\(`);
const RE_POSICAO = escrita('inventory_position');
const RE_CATALOGO = escrita('omie_products');
/** omie_products só é espelho de ESTOQUE quando a fonte carrega a chave `estoque` num literal. */
const RE_CHAVE_ESTOQUE = /[{,]\s*estoque\s*:/;
const RE_CHAMADA_ZERO = /\bzerarConfirmadosForaDaLista\s*\(/g;
/** `saldo: 0` / `estoque: 0` em literal (de valor ou de tipo) — não 0.5, 0x1, 0n nem `|| 0`. */
const RE_ZERO_LITERAL = /[{,]\s*(?:saldo|estoque)\s*:\s*0(?![\d.xXbBoOeE_n])/g;

export function analisarEscritorEstoque(fonte: string): AnaliseEscritor {
  const limpa = removerComentarios(fonte);
  const tabelas: TabelaEstoque[] = [];
  if (RE_POSICAO.test(limpa)) tabelas.push('inventory_position');
  if (RE_CATALOGO.test(limpa) && RE_CHAVE_ESTOQUE.test(limpa)) tabelas.push('omie_products');
  // A CHAMADA conta; o import (sem parêntese) e a definição (`function nome(`) não.
  let chamaZeroConfirmado = false;
  for (const m of limpa.matchAll(RE_CHAMADA_ZERO)) {
    if (!/function\s+$/.test(limpa.slice(Math.max(0, m.index - 20), m.index))) {
      chamaZeroConfirmado = true;
      break;
    }
  }
  const zerosLiterais = [...limpa.matchAll(RE_ZERO_LITERAL)].length;
  return { tabelas, chamaZeroConfirmado, zerosLiterais };
}
