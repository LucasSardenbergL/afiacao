/**
 * fila-idade.ts — EIXO FILA de `pendencias.sh`: a fila durável está sendo CONSUMIDA?
 *
 * POR QUÊ. Ao tirar o chip do caminho (hook `chip-duplicata-guard.sh`, #2374 antes dele), a
 * pendência passa a morar num destino durável — issue — em vez de num card perecível. Isso troca
 * um modo de falha por outro: antes a tarefa EVAPORAVA com a sessão; agora ela pode APODRECER
 * para sempre, e apodrecer é silencioso. O parecer do Codex (gpt-6-astra, 2026-09-08) nomeou esse
 * risco como o mais provável do desenho e prescreveu exatamente este sensor:
 *
 *   "idade do item elegível mais antigo sem avanço comprovado. Alerta inicial: 48 horas.
 *    Comentários automáticos e tentativas repetidas não reiniciam esse relógio."
 *
 * A ARMADILHA QUE ESTE ARQUIVO EXISTE PARA EVITAR: medir por `updatedAt`. Um bot que comenta
 * "ainda pendente" toda madrugada mantém `updatedAt` fresco para sempre — o painel fica verde
 * enquanto nada anda. Movimentação não é entrega. Por isso o relógio corre desde `createdAt` e
 * só PARA com AVANÇO COMPROVADO, que aqui tem uma definição estreita e verificável:
 *
 *   avanço = existe PR (aberto, fechado ou mergeado) que referencia `#N` no título ou no corpo.
 *
 * Comentário não é avanço. Label não é avanço. Reabrir não é avanço.
 *
 * EXIT (o contrato de `rodar_eixo` em modo `exit`, igual ao `pendencias-deploy.ts`):
 *   0 = consultei e nenhum item passou do teto
 *   1 = há item(ns) parados além do teto  → PENDÊNCIA
 *   2 = NÃO consegui consultar (gh ausente/sem auth/erro) → "não consultado" ≠ "limpo"
 */
import { execFileSync } from 'node:child_process';
import { mensagemDeErro } from '@/lib/erro-mensagem';

export interface ItemFila {
  number: number;
  title: string;
  createdAt: string;
}

export interface Parado {
  numero: number;
  titulo: string;
  horas: number;
}

const TETO_HORAS_PADRAO = 48;

/**
 * Núcleo PURO (sem rede) — é o que os testes exercitam.
 * `referenciados` é o conjunto de números de issue citados por algum PR.
 */
export function avaliarFila(
  issues: ItemFila[],
  referenciados: ReadonlySet<number>,
  agoraMs: number,
  tetoHoras: number = TETO_HORAS_PADRAO,
): { parados: Parado[]; maisAntigoHoras: number } {
  const parados: Parado[] = [];
  let maisAntigoHoras = 0;

  for (const issue of issues) {
    if (referenciados.has(issue.number)) continue; // avanço comprovado: sai do relógio
    const criadoMs = Date.parse(issue.createdAt);
    if (Number.isNaN(criadoMs)) continue; // data ilegível não vira idade fabricada
    const horas = (agoraMs - criadoMs) / 3_600_000;
    if (horas > maisAntigoHoras) maisAntigoHoras = horas;
    if (horas >= tetoHoras) {
      parados.push({ numero: issue.number, titulo: issue.title, horas: Math.floor(horas) });
    }
  }

  parados.sort((a, b) => b.horas - a.horas);
  return { parados, maisAntigoHoras };
}

/** Extrai todo `#123` citado por PRs — título e corpo. */
export function referenciasDePRs(prs: { title: string; body: string | null }[]): Set<number> {
  const vistos = new Set<number>();
  for (const pr of prs) {
    const texto = `${pr.title}\n${pr.body ?? ''}`;
    for (const m of texto.matchAll(/#(\d+)/g)) {
      const n = Number(m[1]);
      if (Number.isInteger(n)) vistos.add(n);
    }
  }
  return vistos;
}

function gh(args: string[]): string {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

function main(): never {
  const teto = Number(process.env.FILA_TETO_HORAS ?? TETO_HORAS_PADRAO);
  if (!Number.isFinite(teto) || teto <= 0) {
    console.error(`FILA_TETO_HORAS inválido: ${process.env.FILA_TETO_HORAS}`);
    process.exit(2);
  }

  let issues: ItemFila[];
  let prs: { title: string; body: string | null }[];
  try {
    issues = JSON.parse(
      gh(['issue', 'list', '--state', 'open', '--limit', '300', '--json', 'number,title,createdAt']),
    ) as ItemFila[];
    prs = JSON.parse(
      gh(['pr', 'list', '--state', 'all', '--limit', '300', '--json', 'title,body']),
    ) as { title: string; body: string | null }[];
  } catch (erro) {
    // Fail-CLOSED: sem consulta não há veredito. Exit 2 faz o `pendencias.sh` imprimir
    // "NÃO CONSULTADO", que é a verdade — e não "nada pendente", que seria fabricação.
    // `String(err)` cru fabrica "[object Object]" no erro PLANO (gate erro-object-object).
    // `?? ` explícito: sem mensagem utilizável o helper devolve null, e QUEM CHAMA decide o texto.
    console.error(`não consegui consultar o GitHub: ${mensagemDeErro(erro) ?? 'erro sem mensagem utilizável'}`);
    process.exit(2);
  }

  const { parados, maisAntigoHoras } = avaliarFila(
    issues,
    referenciasDePRs(prs),
    Date.now(),
    teto,
  );

  console.log(
    `   ${issues.length} issue(s) aberta(s) · teto ${teto}h · item mais antigo sem avanço: ${Math.floor(maisAntigoHoras)}h`,
  );

  if (parados.length === 0) {
    console.log('   ✅ nenhum item da fila parado além do teto');
    process.exit(0);
  }

  console.log(`   ⚠️ ${parados.length} item(ns) sem NENHUM PR que os referencie:`);
  for (const p of parados.slice(0, 10)) {
    console.log(`      #${p.numero} (${p.horas}h) ${p.titulo.slice(0, 72)}`);
  }
  if (parados.length > 10) console.log(`      … e mais ${parados.length - 10}`);
  console.log('   Avanço = PR que referencia a issue. Comentário e label NÃO param o relógio.');
  process.exit(1);
}

// `import.meta.main` é do Bun — o teste importa o módulo sem disparar a rede.
if (import.meta.main) main();
