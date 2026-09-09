// Extrai as RPCs que um arquivo de edge chama — o insumo do pré-flight de dependências de banco
// descrito em `docs/agent/deploy.md`.
//
// POR QUE EXISTE. O pré-flight era um comando no runbook:
//     grep -rhoE "\.rpc\('[a-z_]+'" supabase/functions/<edge>/
// Ele tem três cegueiras, e as três produzem a MESMA falha: uma lista curta que parece completa.
//   1. ASPAS. Só casa aspas simples. Medido no repo em 2026-08-30: das 53 RPCs literais chamadas em
//      `supabase/functions/`, ele enxergava 16 — perdia 36 por aspas duplas. A nota do próprio
//      runbook celebrava "das 16 RPCs chamadas por edges, as 16 existem em prod"; o denominador
//      real era 53.
//   2. ESCOPO. Só varre o diretório da edge, e helpers de `_shared/` chamam RPC (o deploy sobe o
//      fecho de imports, não só o diretório).
//   3. INDIREÇÃO. Só vê o nome LITERAL colado no `.rpc(`. Um helper que receba o nome por
//      parâmetro fica invisível — e some da lista sem deixar rastro.
//   4. LITERAL PARCIAL. Casava a aspa de abertura e o miolo, sem exigir que o argumento
//      TERMINASSE ali — então `.rpc("has_role" + "_v2")` reportava `has_role` e ZERO indireções.
//      Diferente das outras três, esta errava para o lado ERRADO: gate verde cruzando com prod um
//      nome que a edge não chama. Corrigida pelo lookahead `[,)]` (detalhe no NOME_LITERAL).
//
// A (3) não tem conserto por extração: o nome pode vir de qualquer lugar. O que ela tem é o
// desfecho certo — ACUSAR. Uma indireção não vira lista vazia silenciosa; vira um aviso com
// arquivo e linha, para o pré-flight ser feito à mão ali. Ausência de dado não é ausência de
// dependência (money-path §2).
//
// O custo dessa cegueira já foi pago: 2026-07-17, `carteira-rebuild` foi deployada com
// `claim_carteira_rebuild` inexistente em prod → 500 em produção por ~40 min, carteira congelada.
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
// Reusa o fecho de imports da SONDA em vez de reimplementá-lo. Não é economia de linhas: é o
// mesmo grafo que decide o `fonte` do fingerprint de deploy, então pré-flight e sonda passam a
// falar do MESMO conjunto de arquivos. Duas travessias independentes divergiriam em silêncio.
import { type ArvoreDeFonte, fecharGrafo } from '../sonda-fingerprint';

interface AchadoRpc {
  nome: string;
  arquivo: string;
  linha: number;
}

interface Indirecao {
  arquivo: string;
  linha: number;
  trecho: string;
}

export interface ExtracaoRpc {
  rpcs: AchadoRpc[];
  indirecoes: Indirecao[];
}

// `.rpc` + parâmetro de tipo OPCIONAL + `(`. O parâmetro de tipo entra porque os loaders tipados
// deste repo escrevem `db.rpc<LinhaAgregada>(…)`, e um regex sem ele os perde — que é a cegueira
// (1) reencenada por outra porta.
const CHAMADA_RPC = /\.rpc\s*(?:<[^>()]*>)?\s*\(\s*/g;
// As TRÊS aspas do JS. O template só conta quando não interpola: `` `x${y}` `` é indireção.
//
// O lookahead `[,)]` é a cegueira (4), e ela era um FALSO VERDE — a pior das quatro, porque as
// outras três erram para MENOS (lista curta, gate recusa) e esta errava para o LADO ERRADO:
// `db.rpc("has_role" + "_v2")` casava o prefixo, reportava `has_role`, ZERO indireções e exit 0.
// O gate então cruzava com prod o nome ERRADO — verificava `has_role`, que existe, e liberava o
// deploy de uma edge que chama `has_role_v2`, que pode não existir. É exatamente o #2285 que o
// pré-flight existe para prevenir, alcançado por dentro da própria ferramenta. Pior ainda com
// variável: `db.rpc("prefixo_" + sufixo)` reportava `prefixo_`, um nome que provavelmente não
// existe em lugar nenhum. Achado pelo Codex na 2ª opinião de 2026-09-08 e reproduzido antes de
// corrigir; nenhuma edge do repo explorava o furo na data (medido: 0 ocorrências em origin/main,
// contra 30 arquivos com `.rpc(` literal como controle positivo).
//
// A regra: depois do literal, o argumento tem de TERMINAR — `,` (vem outro argumento) ou `)` (fim
// da chamada). Qualquer outra coisa significa que a expressão CONTINUA, e aí o literal é um
// PEDAÇO do nome, não o nome. Some para o lado seguro: `"nome" as string` também vira indireção,
// que é uma recusa a mais e nunca um verde a mais.
const NOME_LITERAL = /^(['"`])([A-Za-z0-9_]+)\1\s*(?=[,)])/;

function numeroDaLinha(fonte: string, indice: number): number {
  let linha = 1;
  for (let i = 0; i < indice; i++) if (fonte[i] === '\n') linha++;
  return linha;
}

/**
 * Colhe as RPCs de UMA fonte. Comentário não é dependência: a limpeza usa o stripper COMPARTILHADO
 * (`@/lib/gates/limpeza-fonte`), que entende string, template e regex — nunca um regex local, que
 * não sabe o que é string e pareia um abre-bloco dentro de literal com o fecha-bloco seguinte, apagando o miolo
 * do arquivo ANTES da medição (CLAUDE.md → gates textuais cegos). Ele preserva as quebras de linha,
 * então o número reportado é o da fonte original.
 */
export function extrairRpcs(fonte: string, arquivo: string): ExtracaoRpc {
  const limpa = removerComentarios(fonte);
  const linhas = limpa.split('\n');
  const rpcs: AchadoRpc[] = [];
  const indirecoes: Indirecao[] = [];

  for (const m of limpa.matchAll(CHAMADA_RPC)) {
    const inicio = (m.index ?? 0) + m[0].length;
    const literal = NOME_LITERAL.exec(limpa.slice(inicio));
    const linha = numeroDaLinha(limpa, m.index ?? 0);
    if (literal) {
      rpcs.push({ nome: literal[2], arquivo, linha });
    } else {
      indirecoes.push({ arquivo, linha, trecho: (linhas[linha - 1] ?? '').trim() });
    }
  }
  return { rpcs, indirecoes };
}

/**
 * Colhe as RPCs de uma edge INTEIRA — o fecho transitivo dos imports locais a partir do seu
 * `index.ts`, que é exatamente o que um deploy sobe.
 *
 * ‼️ A PROCEDÊNCIA É OBRIGATÓRIA — não há default para `arvore`, de propósito.
 *
 * Esta função lia o WORKING TREE (`existsSync`/`readFileSync`) enquanto a colagem de deploy que ela
 * gateia saía de `origin/main`. Numa worktree atrasada — o normal aqui — a edge da main chama uma
 * RPC que este checkout desconhece: a lista saía curta, prod era medido só contra as RPCs velhas
 * (que existem), e o gate respondia "pode subir". O #2285 reencenado pela ferramenta feita para
 * evitá-lo. Um default de disco é o que torna esse erro FÁCIL de cometer e INVISÍVEL de ler; sem
 * ele, todo chamador declara de qual árvore sua resposta vale, e o typecheck cobra os que não o
 * fizerem. `raiz` continua opcional porque ela só RESOLVE caminhos relativos — não lê nada.
 *
 * Fail-closed em edge inexistente: devolver `{rpcs: [], indirecoes: []}` para um nome errado
 * (typo, edge renomeada, ou uma edge que só existe no disco desta worktree) se lê como "esta edge
 * não tem dependência de banco" — a lista vazia que parece uma resposta e é uma pergunta não feita.
 */
export function coletarDaEdge(
  edge: string,
  arvore: ArvoreDeFonte,
  raiz = process.cwd(),
): ExtracaoRpc {
  const entrada = `supabase/functions/${edge}/index.ts`;
  if (arvore.ler(entrada) === null) {
    throw new Error(
      `edge não encontrada em ${arvore.rotulo}: ${edge} (esperava ${entrada}). Fail-closed: lista ` +
        `vazia para um nome errado se leria como "sem dependências de banco".`,
    );
  }
  const rpcs: AchadoRpc[] = [];
  const indirecoes: Indirecao[] = [];
  for (const arquivo of fecharGrafo(entrada, raiz, arvore)) {
    const bytes = arvore.ler(arquivo);
    if (bytes === null) {
      // `fecharGrafo` já leu cada um destes; chegar aqui é a árvore ter mudado sob os pés. Lançar,
      // e nunca `?? ''`: fonte vazia extrai zero RPCs, e zero por cegueira é o falso verde.
      throw new Error(
        `arquivo do fecho sumiu de ${arvore.rotulo}: ${arquivo} — as RPCs dele não foram lidas, e ` +
          `uma lista incompleta se leria como dependência a menos`,
      );
    }
    const r = extrairRpcs(bytes.toString('utf8'), arquivo);
    rpcs.push(...r.rpcs);
    indirecoes.push(...r.indirecoes);
  }
  rpcs.sort((a, b) => a.nome.localeCompare(b.nome) || a.arquivo.localeCompare(b.arquivo) || a.linha - b.linha);
  indirecoes.sort((a, b) => a.arquivo.localeCompare(b.arquivo) || a.linha - b.linha);
  return { rpcs, indirecoes };
}

export interface Relatorio {
  texto: string;
  codigo: number;
}

/**
 * Formata o pré-flight de UMA edge e decide o código de saída.
 *
 * O código é a parte que importa: `0` afirma "esta lista é COMPLETA". Quando o extrator encontrou
 * uma chamada cujo nome não é literal, ele sabe que a lista está furada — e sair 0 ali seria
 * exatamente o falso VERDE que esta ferramenta existe para matar. Por isso `3`: distinto de `1`
 * (erro de execução) e distinto de `0`, para quem automatiza poder ramificar.
 */
export function montarRelatorio(edge: string, achado: ExtracaoRpc): Relatorio {
  const linhas: string[] = [`── pré-flight de RPCs — ${edge} ──`];

  if (achado.rpcs.length === 0) {
    linhas.push('nenhuma RPC literal encontrada no fecho de imports desta edge.');
  } else {
    linhas.push(`${achado.rpcs.length} chamada(s) de RPC com nome literal:`);
    for (const r of achado.rpcs) linhas.push(`  · ${r.nome}  (${r.arquivo}:${r.linha})`);
  }

  if (achado.indirecoes.length > 0) {
    linhas.push('');
    linhas.push(`⚠️  ${achado.indirecoes.length} chamada(s) com nome NÃO-literal — a lista acima está INCOMPLETA.`);
    linhas.push('    O nome vem de fora do sítio da chamada; confira o call-site à mão antes do deploy:');
    for (const i of achado.indirecoes) linhas.push(`  · ${i.arquivo}:${i.linha}  ${i.trecho}`);
  }

  const nomes = [...new Set(achado.rpcs.map((r) => r.nome))].sort();
  if (nomes.length > 0) {
    linhas.push('');
    linhas.push('Cruze com a PROD (~/.config/afiacao/psql-ro -f -). Vazio = bomba armada:');
    linhas.push('```sql');
    linhas.push(`WITH esperadas(nome) AS (VALUES
  ${nomes.map((n) => `('${n}')`).join(',\n  ')})`);
    linhas.push("SELECT e.nome || ' → ' || CASE WHEN p.oid IS NULL THEN '❌ AUSENTE EM PROD' ELSE '✅' END");
    linhas.push('FROM esperadas e');
    linhas.push('LEFT JOIN (SELECT p.oid, p.proname FROM pg_proc p');
    linhas.push("            JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public') p");
    linhas.push('  ON p.proname = e.nome');
    linhas.push('ORDER BY 1;');
    linhas.push('```');
  }

  return { texto: linhas.join('\n'), codigo: achado.indirecoes.length > 0 ? 3 : 0 };
}
