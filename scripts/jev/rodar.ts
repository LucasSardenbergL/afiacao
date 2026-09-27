/**
 * rodar.ts — roda o Jev sobre os itens exportados: 3 chamadas por item — `direta` (ordem original),
 * `invertida` (todas as opções, inclusive o "nenhum", de trás para frente) e `repetida` (a direta de
 * novo: separa o efeito de POSIÇÃO do não-determinismo).
 *
 * Uso:  bun scripts/jev/rodar.ts [--dados scripts/jev/.dados] [--dominio boletim_sku|categoria_dre]
 *                                [--limite N] [--concorrencia 4]
 * A chave vem SÓ de `TYPESAFE_API_KEY` (criada em console.typesafe.ai); nunca é impressa.
 * Resultados: <dados>/resultados.jsonl, em APPEND e RETOMÁVEL — chamada já respondida com sucesso
 * nunca é paga de novo; falha é re-tentada na próxima execução.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inverterOpcoes, type Dominio, type ItemBacktest } from './dados';
import type { ResultadoChamada } from './relatorio';
import { perguntarChoice, type PerguntaChoice } from './typesafe';

export const ORDENS = ['direta', 'invertida', 'repetida'] as const;
export type Ordem = (typeof ORDENS)[number];

export const chaveDaChamada = (id: string, ordem: Ordem): string => `${id}|${ordem}`;

export interface ChamadaPlanejada {
  item: ItemBacktest;
  ordem: Ordem;
  pergunta: PerguntaChoice;
}

export function planejarChamadas(itens: readonly ItemBacktest[], feitos: ReadonlySet<string>): ChamadaPlanejada[] {
  const plano: ChamadaPlanejada[] = [];
  for (const item of itens) {
    for (const ordem of ORDENS) {
      if (feitos.has(chaveDaChamada(item.id, ordem))) continue;
      const opcoes = ordem === 'invertida' ? inverterOpcoes(item.opcoes) : item.opcoes;
      plano.push({
        item,
        ordem,
        pergunta: { instructions: item.instrucoes, criteria: opcoes.map((o) => [o.chave, o.descricao] as const) },
      });
    }
  }
  return plano;
}

function lerFeitos(arquivo: string): Set<string> {
  const feitos = new Set<string>();
  if (!existsSync(arquivo)) return feitos;
  for (const linha of readFileSync(arquivo, 'utf8').split('\n')) {
    if (!linha.trim()) continue;
    const r = JSON.parse(linha) as ResultadoChamada;
    if (r.ok) feitos.add(chaveDaChamada(r.id, r.ordem));
  }
  return feitos;
}

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const chave = process.env.TYPESAFE_API_KEY;
  if (!chave) {
    console.error('TYPESAFE_API_KEY ausente: crie a chave em console.typesafe.ai e exporte-a no shell (nunca cole no chat).');
    process.exit(3);
  }
  const dir = arg('--dados') ?? join(import.meta.dirname, '.dados');
  const dominios: Dominio[] = arg('--dominio') ? [arg('--dominio') as Dominio] : ['boletim_sku', 'categoria_dre'];
  const limite = arg('--limite') ? Number(arg('--limite')) : null;
  const concorrencia = Number(arg('--concorrencia') ?? 4);

  const itens = dominios.flatMap((d) => {
    const todos = JSON.parse(readFileSync(join(dir, `${d}.json`), 'utf8')) as ItemBacktest[];
    return limite === null ? todos : todos.slice(0, limite);
  });
  const arquivo = join(dir, 'resultados.jsonl');
  const feitos = lerFeitos(arquivo);
  const plano = planejarChamadas(itens, feitos);
  console.log(`${itens.length} itens · ${plano.length} chamadas pendentes · ${feitos.size} já feitas`);

  let proxima = 0;
  let falhas = 0;
  let concluidas = 0;
  const trabalhador = async () => {
    while (proxima < plano.length) {
      const c = plano[proxima++];
      const r = await perguntarChoice({ chave, state: c.item.state, pergunta: c.pergunta });
      const linha: ResultadoChamada = r.ok
        ? {
            id: c.item.id, ordem: c.ordem, ok: true, escolha: r.escolha, prob: r.prob, probabilidades: r.probabilidades,
            confidence: r.confidence, tokensEntrada: r.tokensEntrada, modelo: r.modelo, tentativas: r.tentativas,
            latenciaMs: r.latenciaMs, latenciaTotalMs: r.latenciaTotalMs,
          }
        : { id: c.item.id, ordem: c.ordem, ok: false, erro: r.erro, status: r.status, tentativas: r.tentativas, latenciaTotalMs: r.latenciaTotalMs };
      appendFileSync(arquivo, `${JSON.stringify(linha)}\n`);
      if (!r.ok) {
        falhas++;
        console.error(`falha ${c.item.id} ${c.ordem}: ${r.erro}`);
        // 401 é da chave, não do item: parar cedo em vez de queimar a fila inteira em erro.
        if (r.status === 401) {
          console.error('401: chave inválida ou revogada — abortando.');
          process.exit(4);
        }
      }
      concluidas++;
      if (concluidas % 50 === 0) console.log(`${concluidas}/${plano.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concorrencia) }, trabalhador));
  console.log(`fim: ${concluidas} chamadas · ${falhas} falha(s)`);
  console.log(falhas === 0 ? 'RODADA-JEV-OK' : 'RODADA-JEV-COM-FALHAS (rode de novo: só as falhas são refeitas)');
}

if (import.meta.main) void main();
