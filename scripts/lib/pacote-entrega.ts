/**
 * pacote-entrega.ts — monta o PACOTE de uma leva na ordem obrigatória (lógica pura).
 *
 * A ordem **DDL → edges → Publish** não é preferência de formatação: é a ordem cuja inversão foi
 * medida em prod (#2285, `ordem-entre-camadas-do-mesmo-pr.md` — a edge serviu ≥2h25 chamando uma
 * RPC inexistente). Por isso ela é ESTRUTURAL aqui: quando a pré-condição não está satisfeita, o
 * passo da edge não é "marcado como pendente", ele **não é escrito**. Um pacote que traz a colagem
 * junto de um aviso entrega a tentação com a advertência — e o #2285 mostrou que o parágrafo perde.
 *
 * ⚠️ Remoções ficam FORA de qualquer pacote, e isso é desenho: o service worker só troca de build
 * quando o cliente clica, então bytes servidos são DISPONIBILIDADE, não adoção (CLAUDE.md, 4ª
 * camada). Derrubar o que a build velha ainda chama quebra quem não recarregou.
 *
 * O SHA é da ESTRUTURA (leva + fatias + pré-condição), nunca do texto renderizado: hashear o texto
 * incluiria a data e daria um SHA novo a cada execução, destruindo a única coisa que o SHA serve
 * para fazer — dizer "apliquei ESTE pacote" e ser conferível depois.
 *
 * Desde o #2362 a fatia carrega o `sha256` de cada arquivo, e o SHA do pacote os inclui: com isso
 * ele passa a ser sensível ao CONTEÚDO, não só aos nomes — dois pacotes com a mesma lista de
 * arquivos e bytes diferentes deixam de colidir.
 */

import { createHash } from 'node:crypto';

import { type EdgeParaDeploy, montarPrompt, type Procedencia } from './prompt-deploy';
import type { AlvoRpc, VereditoPrecondicao } from './precondicao-banco';
import { relatarPrecondicao } from './precondicao-banco';

/** Uma edge da leva no pacote. Interno: `PacoteFonte` é quem o consumidor nomeia. */
interface EdgeNoPacote extends EdgeParaDeploy {
  /** RPCs literais que a edge chama — a dependência de banco desta camada. */
  rpcs: string[];
}

export interface PacoteFonte {
  edges: EdgeNoPacote[];
  alvos: AlvoRpc[];
  veredito: VereditoPrecondicao;
  /** De onde saíram os bytes da fatia — o mesmo contrato do `pendencias:prompt` (#2362). */
  proc: Procedencia;
}

/**
 * Identidade do pacote: 12 hex sobre a estrutura canônica. Determinístico por construção —
 * mesma leva + mesmo veredito ⇒ mesmo SHA, em qualquer máquina e a qualquer hora.
 */
export function shaDoPacote(f: PacoteFonte): string {
  const canonico = JSON.stringify({
    edges: [...f.edges]
      .map((e) => ({
        edge: e.edge,
        arquivos: [...e.arquivos]
          .map((a) => `${a.caminho}@${a.sha256}`)
          .sort((x, y) => x.localeCompare(y, 'en')),
        rpcs: [...e.rpcs].sort(),
      }))
      .sort((a, b) => a.edge.localeCompare(b.edge, 'en')),
    estado: f.veredito.estado,
    ausentes: [...f.veredito.ausentes.map((a) => a.rpc)].sort(),
  });
  return createHash('sha256').update(canonico).digest('hex').slice(0, 12);
}

/** Monta o pacote. Devolve o texto (markdown, para ARQUIVO) e o SHA que o identifica. */
export function montarPacote(f: PacoteFonte): { texto: string; sha: string } {
  if (f.edges.length === 0) {
    throw new Error('montarPacote: leva vazia — um pacote sem passo nenhum pareceria trabalho feito');
  }
  const sha = shaDoPacote(f);
  const liberada = f.veredito.estado === 'LIBERADA';
  const L: string[] = [];

  L.push(`# Pacote de entrega \`${sha}\``);
  L.push('');
  L.push(`Montado contra \`${f.proc.ref}\` @ \`${f.proc.sha.slice(0, 9)}\`.`);
  L.push('');
  L.push(
    `Leva de **${f.edges.length}** edge(s). Os passos abaixo estão na ordem obrigatória e **não podem ` +
      'ser reordenados**: a inversão desta ordem é o incidente #2285 (edge no ar ≥2h25 chamando RPC ' +
      'inexistente). Aplique um passo por vez, de cima para baixo.',
  );
  L.push('');

  // ── Passo 1 — banco ──────────────────────────────────────────────────────────────────────────
  L.push('## Passo 1 — banco (pré-condição das edges)');
  L.push('');
  L.push(relatarPrecondicao(f.veredito));
  L.push('');
  if (!liberada) {
    L.push(
      '**Este pacote está BLOQUEADO no passo 1.** A colagem das edges não foi emitida de propósito — ' +
        'não é esquecimento, é o gate. Aplique a migration que cria as RPCs acima pelo SQL Editor e ' +
        'rode o comando de novo: o passo 2 aparece sozinho quando prod tiver o que a edge chama.',
    );
    L.push('');
  } else if (f.alvos.length > 0) {
    L.push('RPCs conferidas em prod (catálogo, sem invocar):');
    L.push('');
    for (const a of f.alvos) {
      L.push(`- \`${a.rpc}\` ← ${a.edges.map((e) => `\`${e}\``).join(', ')}`);
    }
    L.push('');
  } else {
    L.push('_Nenhuma RPC literal nesta leva — nada a exigir do banco._');
    L.push('');
  }

  // ── Passo 2 — edges ──────────────────────────────────────────────────────────────────────────
  L.push('## Passo 2 — edges (chat do Lovable)');
  L.push('');
  if (liberada) {
    L.push('Cole no chat do Lovable:');
    L.push('');
    L.push('~~~');
    L.push(montarPrompt(f.edges.map((e) => ({ edge: e.edge, arquivos: e.arquivos })), f.proc));
    L.push('~~~');
  } else {
    L.push('_Não emitido — veja o passo 1._');
  }
  L.push('');

  // ── Passo 3 — frontend ───────────────────────────────────────────────────────────────────────
  L.push('## Passo 3 — frontend (Publish)');
  L.push('');
  L.push(
    liberada
      ? 'Só **depois** de as edges mostrarem **Active**: Lovable → **Publish**. O service worker do ' +
          'PWA só troca de build quando o cliente clica, então o Publish é disponibilidade, não adoção — ' +
          'não derrube nada que a build anterior ainda chame.'
      : '_Não aplicável enquanto o passo 1 estiver bloqueado._',
  );
  L.push('');

  // ── Pós-condição ─────────────────────────────────────────────────────────────────────────────
  L.push('## Pós-condição (o que provar depois)');
  L.push('');
  if (liberada) {
    L.push(`~~~bash`);
    L.push(`bun run sonda:sql ${f.edges.map((e) => e.edge).join(' ')}`);
    L.push(`bun run pendencias:deploy`);
    L.push(`~~~`);
    L.push('');
    L.push(
      'O `pendencias:deploy` tem de sair **0** para esta leva. Enquanto ele acusar divergência, o ' +
        'deploy não terminou — "o Lovable disse Active" não é prova de que o bundle novo está servindo.',
    );
  } else {
    L.push(`~~~bash`);
    L.push(`bun run pendencias:pacote ${f.edges.map((e) => e.edge).join(' ')}`);
    L.push(`~~~`);
    L.push('');
    L.push('Depois de aplicar a DDL, este comando volta a medir prod e emite o pacote completo.');
  }

  return { texto: L.join('\n'), sha };
}
