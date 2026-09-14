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
 *
 * Desde 2026-09-14 a ordem ENTRE edges também é estrutural (`ordem-entre-edges.ts`, #2469): a edge
 * RETIDA — a predecessora dela ainda não está provada em prod — não entra na colagem, e o pacote
 * vira uma ONDA. Mesmo princípio do passo 1: o que não pode subir não é escrito, não é "marcado".
 */

import { createHash } from 'node:crypto';

import { ASSENTAR_MIN, FRESCOR_MAX_H, type PlanoDeOndas } from './ordem-entre-edges';
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
  /**
   * A partição da leva pela ordem entre edges. OBRIGATÓRIA: sem ela o montador não saberia se a leva
   * inteira cabe numa colagem — e "não sei" já saiu como "cabe" uma vez (#2469).
   */
  ordem: PlanoDeOndas;
}

const porNome = (a: string, b: string): number => a.localeCompare(b, 'en');

/**
 * Identidade do pacote: 12 hex sobre a estrutura canônica. Determinístico por construção —
 * mesma leva + mesmo veredito ⇒ mesmo SHA, em qualquer máquina e a qualquer hora.
 *
 * A ordem entra SÓ quando há regra: leva sem manifesto mantém o SHA que sempre teve, e o "apliquei
 * ESTE pacote" dos pacotes antigos segue conferível. Com regra entram as exigências, o par exigido de
 * cada predecessora e a PARTIÇÃO — liberada e retida não são o mesmo pacote. O sha do COMMIT segue
 * fora (a identidade é de CONTEÚDO, #2362), e os motivos também: carregam idade, e o SHA não pode
 * mudar com o relógio.
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
    ...(f.ordem.regras.length > 0
      ? {
          ordem: {
            regras: f.ordem.regras
              .map((r) => ({ edge: r.edge, depoisDe: [...r.depoisDe].sort(porNome) }))
              .sort((a, b) => porNome(a.edge, b.edge)),
            exigidos: f.ordem.exigidos
              .map((x) => ({ edge: x.edge, fonte: x.fonte, versao: x.versao }))
              .sort((a, b) => porNome(a.edge, b.edge)),
            liberadas: [...f.ordem.liberadas].sort(porNome),
            retidas: f.ordem.retidas
              .map((r) => ({ edge: r.edge, tipo: r.tipo, espera: [...r.espera].sort(porNome) }))
              .sort((a, b) => porNome(a.edge, b.edge)),
          },
        }
      : {}),
  });
  return createHash('sha256').update(canonico).digest('hex').slice(0, 12);
}

/**
 * O plano tem de ser a leva, sem sobra nem falta: edge sem destino sumiria calada do pacote, e edge
 * com dois destinos sairia na colagem E na lista de retidas.
 */
function conferirPlano(f: PacoteFonte): void {
  const daLeva = f.edges.map((e) => e.edge).sort(porNome);
  const doPlano = [...f.ordem.liberadas, ...f.ordem.retidas.map((r) => r.edge)].sort(porNome);
  if (daLeva.length !== doPlano.length || daLeva.some((e, i) => e !== doPlano[i])) {
    throw new Error(
      `montarPacote: o plano de ondas (${doPlano.join(', ') || '∅'}) não é a leva (${daLeva.join(', ')}) — ` +
        'edge sem destino, ou com dois',
    );
  }
}

/** Monta o pacote. Devolve o texto (markdown, para ARQUIVO) e o SHA que o identifica. */
export function montarPacote(f: PacoteFonte): { texto: string; sha: string } {
  if (f.edges.length === 0) {
    throw new Error('montarPacote: leva vazia — um pacote sem passo nenhum pareceria trabalho feito');
  }
  conferirPlano(f);
  const sha = shaDoPacote(f);
  const liberada = f.veredito.estado === 'LIBERADA';
  const { liberadas, retidas } = f.ordem;
  const emOndas = retidas.length > 0;
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
  if (emOndas) {
    L.push(
      `⏸️ **Entrega em ONDAS.** Há ordem declarada entre edges desta leva (\`deploy-ordem.json\`): ` +
        `**${liberadas.length}** liberada(s) nesta execução, **${retidas.length}** retida(s). A retida NÃO ` +
        'tem colagem aqui — ela sai numa próxima execução do pacote, quando o ledger provar a predecessora. ' +
        'Colar a retida à mão é reencenar o #2469.',
    );
    L.push('');
  }

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
  if (!liberada) {
    L.push('_Não emitido — veja o passo 1._');
  } else if (liberadas.length === 0) {
    L.push('_Não emitido — nenhuma edge desta leva tem a ordem satisfeita; veja as retidas abaixo._');
  } else {
    // Só as LIBERADAS. A retida não é escrita nem "marcada" ao lado: a colagem que a traz junto de um
    // aviso entrega a tentação com a advertência — a mesma regra do passo 1.
    const daOnda = f.edges.filter((e) => liberadas.includes(e.edge));
    L.push('Cole no chat do Lovable:');
    L.push('');
    L.push('~~~');
    L.push(montarPrompt(daOnda.map((e) => ({ edge: e.edge, arquivos: e.arquivos })), f.proc));
    L.push('~~~');
  }
  L.push('');
  if (emOndas) {
    L.push('### Retidas pela ordem entre edges — NÃO cole');
    L.push('');
    for (const r of retidas) {
      const quem = r.espera.map((e) => `\`${e}\``).join(', ');
      L.push(
        r.tipo === 'ADIADA'
          ? `- **\`${r.edge}\`** — ADIADA: sai sozinha numa próxima execução; espera ${quem}.`
          : `- **\`${r.edge}\`** — BLOQUEADA: exige ação antes; espera ${quem}.`,
      );
      for (const m of r.motivos) L.push(`  - ${m}`);
    }
    L.push('');
  }

  // ── Passo 3 — frontend ───────────────────────────────────────────────────────────────────────
  L.push('## Passo 3 — frontend (Publish)');
  L.push('');
  L.push(
    !liberada
      ? '_Não aplicável enquanto o passo 1 estiver bloqueado._'
      : emOndas
        ? '_Não aplicável enquanto houver edge retida: o Publish vem depois da ÚLTIMA onda._'
        : 'Só **depois** de as edges mostrarem **Active**: Lovable → **Publish**. O service worker do ' +
            'PWA só troca de build quando o cliente clica, então o Publish é disponibilidade, não adoção — ' +
            'não derrube nada que a build anterior ainda chame.',
  );
  L.push('');

  // ── Pós-condição ─────────────────────────────────────────────────────────────────────────────
  L.push('## Pós-condição (o que provar depois)');
  L.push('');
  if (!liberada) {
    L.push(`~~~bash`);
    L.push(`bun run pendencias:pacote ${f.edges.map((e) => e.edge).join(' ')}`);
    L.push(`~~~`);
    L.push('');
    L.push('Depois de aplicar a DDL, este comando volta a medir prod e emite o pacote completo.');
  } else if (emOndas) {
    // Onda ≠ entrega (P2 do Codex): o passo seguinte é o PACOTE de novo, não o "confere" do ledger.
    L.push(`~~~bash`);
    if (liberadas.length > 0) L.push(`bun run sonda:sql ${liberadas.join(' ')}`);
    L.push('PEND=$(mktemp -t pend)');
    L.push('bun scripts/pendencias-deploy.ts --json > "$PEND"');
    L.push('bun scripts/pendencias-pacote.ts - < "$PEND"');
    L.push(`~~~`);
    L.push('');
    L.push(
      liberadas.length > 0
        ? 'Isto prova a ONDA, não a entrega: enquanto houver retida o `pendencias:deploy` segue saindo **1**, ' +
            'e isso é o esperado. A próxima onda sai sozinha quando o ledger mostrar cada predecessora ' +
            `servindo o par da REF, com a observação entre ${ASSENTAR_MIN} min e ${FRESCOR_MAX_H} h de idade — ` +
            '"o Lovable disse Active" não é prova de nenhuma das duas coisas.'
        : 'Nenhuma colagem saiu. Faça o que cada retida pede — medir o ledger de novo, sondar a ' +
            'predecessora, aguardar o assentamento — e rode o pacote outra vez.',
    );
  } else {
    L.push(`~~~bash`);
    L.push(`bun run sonda:sql ${f.edges.map((e) => e.edge).join(' ')}`);
    L.push(`bun run pendencias:deploy`);
    L.push(`~~~`);
    L.push('');
    L.push(
      'O `pendencias:deploy` tem de sair **0** para esta leva. Enquanto ele acusar divergência, o ' +
        'deploy não terminou — "o Lovable disse Active" não é prova de que o bundle novo está servindo.',
    );
  }

  return { texto: L.join('\n'), sha };
}
