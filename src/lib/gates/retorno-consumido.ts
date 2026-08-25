// Gate compartilhado contra a classe "casa o NOME e conclui o EFEITO" (assinatura em
// docs/historico/verificar-sonda-versao.md §9; primeiro caso fechado no #1985).
//
// O modo de falha: um gate textual afirma `expect(src).toMatch(/helperPuro\(/)` e conclui daí que
// o produto do helper chegou ao seu destino. Não chega. Quando o helper é PURO — o valor de
// RETORNO é o produto —, `helperPuro(args);` como sentença solta calcula tudo e joga fora, e o
// gate fica VERDE sobre um edge que voltou ao comportamento que o gate existe para proibir.
// Medido em 2026-08-25: 7 asserts do `edge-money-path-invariants` aprovavam a forma descartada
// (identidade self-service, fail-closed de doc ambíguo, classificação de lote, owner-map,
// elegibilidade/ordem da fila de leadtime, acumulador de uso de cache).
//
// Por que POSICIONAL e não uma lista de embrulhos: enumerar `const X = helper(` reprova as formas
// legítimas REAIS (predicado de `.filter`, comparador de `.sort`, valor de propriedade, ternário),
// e o conserto de um gate que reprova código correto é sempre AFROUXÁ-LO (lição do #1985). Aqui a
// pergunta é uma só: a chamada está numa posição em que alguém RECEBE o valor?
import { removerComentarios } from './limpeza-fonte';

/** Delimitadores de sentença. Um prefixo vazio até um deles = a chamada é sentença solta. */
const DELIMITADORES = ';{}';

export type UsoDoRetorno = {
  /** Índice da chamada na fonte JÁ SEM COMENTÁRIOS. */
  indice: number;
  consumido: boolean;
  /** Prefixo da sentença até a chamada — é o que decide, e o que a mensagem de erro mostra. */
  prefixo: string;
  motivo: 'sentenca-solta' | 'atribuido-e-ignorado' | 'consumido';
};

/** Fim da sentença que contém `i`: o próximo delimitador de topo. */
function fimDaSentenca(fonte: string, i: number): number {
  for (let j = i; j < fonte.length; j++) {
    if (DELIMITADORES.includes(fonte[j])) return j;
  }
  return fonte.length;
}

/**
 * Todas as chamadas a `nome(` na fonte, cada uma com o veredito "alguém recebe o retorno?".
 *
 * A fonte é limpa de comentários com o stripper COMPARTILHADO — a prosa que explica a armadilha
 * cita a forma proibida, e sem a limpeza o gate leria o comentário como código (classe de
 * 2026-08-20, `limpeza-fonte`).
 */
export function usosDoRetorno(fonteCrua: string, nome: string): UsoDoRetorno[] {
  const fonte = removerComentarios(fonteCrua);
  const chamada = new RegExp(`\\b${nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`, 'g');
  const usos: UsoDoRetorno[] = [];

  for (const m of fonte.matchAll(chamada)) {
    const i = m.index;
    // Uma DEFINIÇÃO (`function nome(`, `const nome = (`) não é chamada — não tem retorno a consumir.
    const antes = fonte.slice(Math.max(0, i - 40), i);
    if (/\b(function|class)\s+$/.test(antes) || /\b(const|let|var)\s+$/.test(antes)) continue;

    let ini = i - 1;
    while (ini >= 0 && !DELIMITADORES.includes(fonte[ini])) ini--;
    const prefixo = fonte.slice(ini + 1, i).trim();

    // `await`/`void`/`return await` são transparentes: o que importa é o que sobra à esquerda.
    const nu = prefixo.replace(/\b(await|void)\b/g, '').trim();

    if (nu === '') {
      usos.push({ indice: i, consumido: false, prefixo, motivo: 'sentenca-solta' });
      continue;
    }

    // Atribuição: alguém recebe, mas só conta se a variável for LIDA depois. `const x = helper();
    // const y = dadoCru;` calcula e descarta com um passo a mais.
    const atrib = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=$/.exec(nu);
    if (atrib) {
      const alvo = atrib[1];
      const depois = fonte.slice(fimDaSentenca(fonte, i));
      const lido = new RegExp(`\\b${alvo}\\b`).test(depois);
      usos.push({
        indice: i,
        consumido: lido,
        prefixo,
        motivo: lido ? 'consumido' : 'atribuido-e-ignorado',
      });
      continue;
    }

    // Qualquer outra posição — argumento, `return`, propriedade de objeto, ramo de ternário,
    // corpo de arrow sem chaves, operando — significa que o valor foi para algum lugar.
    usos.push({ indice: i, consumido: true, prefixo, motivo: 'consumido' });
  }

  return usos;
}

/** Quantas chamadas a `nome(` entregam o retorno a alguém. `0` = o gate estaria mentindo. */
export function chamadasQueConsomemRetorno(fonte: string, nome: string): number {
  return usosDoRetorno(fonte, nome).filter((u) => u.consumido).length;
}

/**
 * Mensagem para o assert: nomeia a classe e mostra a forma encontrada, para o vermelho explicar
 * o que fazer em vez de só dizer "não casou".
 */
export function explicarDescarte(fonte: string, nome: string): string {
  const usos = usosDoRetorno(fonte, nome);
  if (usos.length === 0) return `${nome} não é chamado em lugar nenhum`;
  const formas = usos.map((u) => `${u.motivo}${u.prefixo ? ` ("${u.prefixo.slice(-48)}")` : ''}`);
  return `${nome} é chamado ${usos.length}x mas NENHUMA entrega o retorno: ${formas.join(' | ')}`;
}
