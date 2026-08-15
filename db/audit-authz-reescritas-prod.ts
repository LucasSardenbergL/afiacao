#!/usr/bin/env bun
/**
 * audit-authz-reescritas-prod.ts — AUDITORIA de prod (READ-ONLY via psql-ro) do corpo VIVO das
 * funções do AUTHZ_MANIFEST. Segunda camada da Parte D; a primeira é o gate estático
 * (scripts/lib/authz-reescrita.ts → Parte D do `authz:check`).
 *
 * Por que DUAS e nenhuma sozinha basta — e aqui isso não é simetria retórica, é o desenho:
 *   · a Parte D lê o REPO. Ela sabe DIZER que uma migration recriou a função reescrevendo a
 *     definição viva (`pg_get_functiondef` + `EXECUTE`), mas por construção NÃO sabe qual corpo
 *     saiu disso — simular `regexp_replace` do Postgres em JS produziria um corpo que ninguém
 *     executou, e o verde afirmaria cobertura inventada;
 *   · este audit lê o BANCO. Ele mede o corpo que de fato roda e passa o MESMO `checkGate` do
 *     manifest por cima dele — a prova que o CI não tem como fazer (o CI não tem psql-ro).
 *
 * Duas asserções, e a segunda é a que fecha o laço da baseline:
 *   A. gate VIVO: `checkGate(corpo de prod, requiredGate)` para todas as entradas do manifest.
 *      É o que separa "a Parte A validou algum corpo" de "o corpo que roda está protegido".
 *   B. âncora de md5: para cada entrada de AUTHZ_REESCRITAS_CONHECIDAS, o `prosrc` normalizado
 *      de prod tem de bater com o `md5ProdEsperado` registrado. É isso que transforma a baseline
 *      de desculpa em asserção verificável: se alguém reescrever de novo por fora, o md5 muda e
 *      isto fica vermelho, mesmo que nenhum arquivo do repo tenha mudado.
 *
 * Uso:   bun run authz:audit:prod ; echo $?     → 0 ok · 1 divergência · 2 erro de execução
 *
 * ⚠️ Divergência de md5 NÃO é por si só um incêndio: uma migration que mergeou e ainda não foi
 * aplicada no SQL Editor também aparece aqui (merge na main ≠ produção, docs/agent/database.md).
 * Por isso o relatório separa "gate VIVO falhou" (autorização) de "md5 divergiu" (drift), e a
 * mensagem manda confirmar o estado de aplicação ANTES de concluir — senão o diff acusa a coisa
 * errada, que foi exatamente o risco medido em 2026-08-14 na 20260814022626.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkGate, stripNoise } from '../scripts/lib/authz-contract';
import { AUTHZ_MANIFEST } from '../scripts/authz-manifest';
import { AUTHZ_REESCRITAS_CONHECIDAS } from '../scripts/authz-reescritas-conhecidas';

const PSQL = process.env.PSQL_RO ?? join(homedir(), '.config', 'afiacao', 'psql-ro');

/** Erro de EXECUÇÃO (não de contrato): exit 2. Um audit que não conseguiu medir não pode sair 0 —
 *  ausência de dado não é aprovação. */
function erroFatal(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(2);
}

/** `\x1e` como separador: o corpo de uma função contém `|`, tabs e quebras de linha à vontade. */
const SEP = '\x1e';

/**
 * O corpo vai em BASE64, e isso não é preciosismo — é correção medida. A 1ª versão trazia o
 * `prosrc` cru achatando `chr(10)` para espaço (para caber numa linha do psql). Sem as quebras
 * de linha, `--` deixa de terminar no fim da linha e o `stripComments` passa a apagar o corpo
 * INTEIRO a partir do primeiro comentário: o audit acusou 8 das 19 funções "sem gate em prod",
 * todas falso-alarme. O `replace(..., chr(10), '')` de fora tira as quebras que o próprio
 * `encode(...,'base64')` do Postgres insere a cada 76 caracteres.
 */
function montarQuery(nomes: string[]): string {
  const lista = nomes.map((n) => `'${n.split('.')[1]}'`).join(',');
  return `SELECT 'ROW' || '${SEP}' || n.nspname || '.' || p.proname
       || '${SEP}' || p.oid::regprocedure::text
       || '${SEP}' || md5(regexp_replace(btrim(p.prosrc), '\\s+', ' ', 'g'))
       || '${SEP}' || replace(encode(convert_to(p.prosrc, 'UTF8'), 'base64'), chr(10), '')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname IN ('public','private') AND p.proname IN (${lista});`;
}

interface Viva {
  chave: string;
  assinatura: string;
  md5: string;
  corpo: string;
}

function medir(nomes: string[]): Viva[] {
  let saida: string;
  try {
    saida = execFileSync(PSQL, ['-tA', '-c', montarQuery(nomes)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    erroFatal(`falha ao consultar o banco via psql-ro (${PSQL}): ${(e as Error).message}`);
  }
  const out: Viva[] = [];
  for (const linha of saida.split('\n')) {
    if (!linha.startsWith(`ROW${SEP}`)) continue; // descarta o eco de SET e linhas em branco
    const [, chave, assinatura, md5, b64] = linha.split(SEP);
    out.push({ chave, assinatura, md5, corpo: Buffer.from(b64 ?? '', 'base64').toString('utf8') });
  }
  return out;
}

function main(): void {
  const nomes = Object.keys(AUTHZ_MANIFEST);
  const vivas = medir(nomes);
  if (vivas.length === 0) erroFatal('nenhuma função lida do banco — psql-ro respondeu vazio (query ou permissão?).');

  const porChave = new Map<string, Viva[]>();
  for (const v of vivas) porChave.set(v.chave, [...(porChave.get(v.chave) ?? []), v]);

  const falhasGate: string[] = [];
  const ausentes: string[] = [];
  const driftMd5: string[] = [];

  // A. o gate do manifest vale no corpo que RODA
  for (const [chave, entry] of Object.entries(AUTHZ_MANIFEST)) {
    const achadas = porChave.get(chave);
    if (!achadas || achadas.length === 0) {
      ausentes.push(chave);
      continue;
    }
    for (const v of achadas) {
      const res = checkGate(stripNoise(v.corpo), entry.requiredGate);
      if (!res.ok) {
        const porque = res.missing.length ? `falta ${res.missing.join('/')}` : `${res.weak.join('/')} sem forma de bloqueio`;
        falhasGate.push(`${v.assinatura} — ${porque}`);
      }
    }
  }

  // B. âncora de md5 das reescritas baselinadas
  for (const r of AUTHZ_REESCRITAS_CONHECIDAS) {
    const achadas = porChave.get(r.funcao) ?? [];
    if (achadas.length === 0) continue; // já contabilizada em `ausentes`
    if (!achadas.some((v) => v.md5 === r.md5ProdEsperado)) {
      driftMd5.push(
        `${r.funcao} (${r.arquivo}): esperado ${r.md5ProdEsperado}, prod tem ${achadas.map((v) => v.md5).join(' / ')}`,
      );
    }
  }

  console.log(`🔎 authz:audit:prod — ${vivas.length} definição(ões) lida(s) para ${nomes.length} chave(s) do manifest.`);
  for (const a of ausentes) console.error(`❌ AUSENTE_EM_PROD: ${a} está no AUTHZ_MANIFEST e não existe no banco.`);
  for (const f of falhasGate) console.error(`❌ GATE_VIVO_FALHOU: ${f}`);
  for (const d of driftMd5) console.error(`❌ MD5_DIVERGIU: ${d}`);

  if (driftMd5.length > 0) {
    console.error(
      `\n⚠️ md5 divergente NÃO é conclusão: pode ser reescrita nova por fora, OU migration que mergeou e ainda não foi aplicada no SQL Editor. Confirme o estado de aplicação (marcador no prosrc) ANTES de concluir — senão o diff acusa a coisa errada.`,
    );
  }
  if (falhasGate.length + ausentes.length + driftMd5.length > 0) {
    console.error(`\nauthz:audit:prod — ${falhasGate.length + ausentes.length + driftMd5.length} divergência(s).`);
    process.exit(1);
  }
  console.log(
    `✅ gate do manifest vale no corpo VIVO das ${nomes.length} funções, e as ${AUTHZ_REESCRITAS_CONHECIDAS.length} reescritas baselinadas batem no md5 de prod.`,
  );
}

if (import.meta.main) main();
