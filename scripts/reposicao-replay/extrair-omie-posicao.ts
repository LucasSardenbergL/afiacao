// extrair-omie-posicao.ts — posição de estoque DATADA do Omie (OBEN) para ancorar o estado inicial do replay TSB
// (spec §5.9 "Estado inicial", achado 1 do Codex). O banco não guarda saldo histórico: a edge `cmc-snapshot-backfill`
// chama o mesmo `ListarPosEstoque` com `dDataPosicao`, mas grava só o `nCMC`. Este script é SÓ LEITURA no Omie e grava
// em $REPLAY_DADOS (nunca no repositório).
//
// Uso (no Mac):  bun scripts/reposicao-replay/extrair-omie-posicao.ts [AAAA-MM-DD ...]
//   sem datas: a véspera do início do aquecimento (fim de 2025-10-20 = abertura de 2025-10-21), o fim do aquecimento
//   (2026-01-31) e o fim da calibração (2026-04-30) — as duas últimas só para a CONFERÊNCIA (R31).
// Credenciais: ~/.config/afiacao/omie-oben.env (OMIE_OBEN_APP_KEY, OMIE_OBEN_APP_SECRET). A chave NUNCA é impressa,
// logada nem gravada: toda mensagem de erro passa por `redigir`.
// Saída: $REPLAY_DADOS/posicao_omie_<data>.csv — `nCodProd|cCodigo|nSaldo|nCMC`, cabeçalho, última linha `fim|ok`.
// R45: `nCMC` = CMC contábil do ERP na data (valoração point-in-time do capital); ausente ou ≤ 0 fica VAZIO.
// `nCodProd` é o `omie_codigo_produto` = `sku_codigo_omie` (a chave `sku` do replay), como a edge grava em cmc_snapshot.
// Saldo ausente na resposta fica VAZIO (ausente ≠ zero).
// Exit: 0 ok · 2 sem arquivo de credenciais (nenhuma chamada feita) · 3 credencial ilegível ou pasta de saída DENTRO do
// repositório (nenhuma chamada feita) · 1 falha da API/paginação (nada parcial gravado).
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mensagemDeErro } from '../../src/lib/erro-mensagem';
import { addDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { classificarFaultstring, redigirSegredo } from '../../supabase/functions/_shared/omie-falha';
import { MAX_PAGINAS_POS_ESTOQUE } from '../../supabase/functions/_shared/omie-paginacao';
import { INICIO_AQUECIMENTO, JANELAS } from './config';

const OMIE_API_URL = 'https://app.omie.com.br/api/v1';

// Cópia VERBATIM da política de `_shared/cmc-snapshot-retry.ts` (decidirRetentativaCmcSnapshot): aquele módulo importa
// `./omie-falha.ts` com extensão, que o tsconfig de scripts/ não aceita. 5 tentativas; backoff 1/2/4/8 s; retenta só
// `transitorio`/`indeterminada` pela classificação de FAULTSTRING (o EOF não retenta).
const MAX_TENTATIVAS_CMC_SNAPSHOT = 5;
function decidirRetentativaCmcSnapshot(mensagem: string, tentativa: number): { retentar: boolean; atrasoMs: number } {
  const classe = classificarFaultstring(mensagem);
  const retentar = (classe === 'transitorio' || classe === 'indeterminada') && tentativa < MAX_TENTATIVAS_CMC_SNAPSHOT;
  return { retentar, atrasoMs: retentar ? 1000 * 2 ** (Math.max(1, Math.floor(tentativa)) - 1) : 0 };
}
const CONTA = 'oben';

export interface Credenciais {
  key: string;
  secret: string;
}

/** Lê `NOME=valor` (aceita `export` e aspas). Erro nunca cita valor. */
export function lerCredenciais(texto: string): Credenciais {
  const kv = new Map<string, string>();
  for (const bruta of texto.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(bruta);
    if (!m || bruta.trim().startsWith('#')) continue;
    kv.set(m[1], m[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  const key = kv.get('OMIE_OBEN_APP_KEY') ?? '';
  const secret = kv.get('OMIE_OBEN_APP_SECRET') ?? '';
  if (!key || !secret) throw new Error('credenciais incompletas: OMIE_OBEN_APP_KEY e OMIE_OBEN_APP_SECRET são obrigatórias');
  return { key, secret };
}

/** Mascara a chave e o segredo literais e, por cima, a máscara do helper das edges (dígitos longos ecoados). */
export function redigir(texto: string, c: Credenciais): string {
  let t = texto;
  for (const s of [c.key, c.secret]) if (s) t = t.split(s).join('***');
  return redigirSegredo(t);
}

export interface ProdutoPosicao {
  nCodProd?: number;
  cCodigo?: string;
  nSaldo?: number;
  /** CMC contábil do ERP na data da posição (R45). */
  nCMC?: number;
}
export interface RespostaPosicao {
  produtos?: ProdutoPosicao[];
  nTotPaginas?: number;
  faultstring?: string;
}
export type Transporte = (corpo: string) => Promise<{ ok: boolean; status: number; texto: string }>;
export type Chamada = (param: Record<string, unknown>) => Promise<RespostaPosicao>;

const faultDe = (texto: string): string => {
  try {
    const j = JSON.parse(texto) as { faultstring?: unknown };
    return typeof j.faultstring === 'string' ? j.faultstring : '';
  } catch {
    return '';
  }
};

/**
 * Chamada ao Omie com a política de retentativa da edge `cmc-snapshot-backfill` (mesma classificação e backoff 1/2/4/8 s,
 * via `decidirRetentativaCmcSnapshot`), serializada. A faultstring de EOF ("Não existem registros para a página") é FIM:
 * vira página vazia, sem retentar. Toda mensagem sai redigida.
 */
export function criarChamada(c: Credenciais, transporte: Transporte, dormir: (ms: number) => Promise<void>): Chamada {
  return async (param) => {
    const corpo = JSON.stringify({ call: 'ListarPosEstoque', app_key: c.key, app_secret: c.secret, param: [param] });
    let ultimo: Error | null = null;
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_CMC_SNAPSHOT; tentativa++) {
      try {
        const r = await transporte(corpo);
        // o Omie devolve a faultstring de EOF também com HTTP 500: é fim, não falha
        if (!r.ok && classificarFaultstring(faultDe(r.texto)) === 'fim_de_pagina') return { produtos: [] };
        if (!r.ok) throw new Error(`Omie (${CONTA}) HTTP ${r.status}: ${redigir(r.texto, c).slice(0, 300)}`);
        const res = JSON.parse(r.texto) as RespostaPosicao;
        if (res.faultstring) {
          if (classificarFaultstring(res.faultstring) === 'fim_de_pagina') return { produtos: [] };
          throw new Error(`Omie (${CONTA}): ${redigir(String(res.faultstring), c)}`);
        }
        return res;
      } catch (e) {
        ultimo = new Error(redigir(mensagemDeErro(e) ?? 'erro sem mensagem', c));
        const d = decidirRetentativaCmcSnapshot(ultimo.message, tentativa);
        if (!d.retentar) throw ultimo;
        await dormir(d.atrasoMs);
      }
    }
    throw ultimo ?? new Error(`Omie (${CONTA}): falha após ${MAX_TENTATIVAS_CMC_SNAPSHOT} tentativas`);
  };
}

export interface LinhaPosicao {
  nCodProd: number;
  cCodigo: string;
  nSaldo: number | null;
  /** R45: CMC na data; ausente, não numérico ou ≤ 0 ⇒ null (nunca 0). */
  nCMC: number | null;
}

/** AAAA-MM-DD → DD/MM/AAAA. */
export function dataBr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`data inválida "${iso}" (use AAAA-MM-DD)`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/**
 * Pagina até a PRIMEIRA página vazia — não confia em `nTotPaginas`. Guardas (fail-closed, nada parcial volta):
 * passar de `maxPaginas` lança; página idêntica à anterior (Omie ignorando `nPagina`) lança; `nCodProd` repetido entre
 * páginas lança; `nCodProd` inválido lança.
 */
export async function paginarPosicao(chamar: Chamada, dataIso: string, maxPaginas = MAX_PAGINAS_POS_ESTOQUE): Promise<{ linhas: LinhaPosicao[]; paginas: number }> {
  const linhas: LinhaPosicao[] = [];
  const vistos = new Set<number>();
  let anterior = '';
  for (let pagina = 1; ; pagina++) {
    if (pagina > maxPaginas) throw new Error(`passou de ${maxPaginas} páginas sem página vazia (${dataIso}) — abortando, nada gravado`);
    const res = await chamar({ nPagina: pagina, nRegPorPagina: 100, cExibeTodos: 'S', dDataPosicao: dataBr(dataIso) });
    const produtos = res.produtos ?? [];
    if (produtos.length === 0) return { linhas, paginas: pagina - 1 };
    const impressao = produtos.map((p) => String(p.nCodProd)).join(',');
    if (impressao === anterior) throw new Error(`página ${pagina} repete a anterior (${dataIso}) — o Omie ignorou nPagina; abortando`);
    anterior = impressao;
    for (const p of produtos) {
      const cod = Number(p.nCodProd);
      if (!Number.isSafeInteger(cod) || cod <= 0) throw new Error(`nCodProd inválido na página ${pagina} (${dataIso})`);
      if (vistos.has(cod)) throw new Error(`nCodProd ${cod} repetido entre páginas (${dataIso}) — abortando`);
      vistos.add(cod);
      linhas.push({ nCodProd: cod, cCodigo: typeof p.cCodigo === 'string' ? p.cCodigo : '', nSaldo: typeof p.nSaldo === 'number' && Number.isFinite(p.nSaldo) ? p.nSaldo : null,
        nCMC: typeof p.nCMC === 'number' && Number.isFinite(p.nCMC) && p.nCMC > 0 ? p.nCMC : null,
      });
    }
  }
}

const campoCsv = (s: string): string => (/[|"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function paraCsv(linhas: LinhaPosicao[]): string {
  const corpo = [...linhas]
    .sort((a, b) => a.nCodProd - b.nCodProd)
    .map((l) => `${l.nCodProd}|${campoCsv(l.cCodigo)}|${l.nSaldo === null ? '' : String(l.nSaldo)}|${l.nCMC === null ? '' : String(l.nCMC)}`);
  return ['nCodProd|cCodigo|nSaldo|nCMC', ...corpo, 'fim|ok'].join('\n') + '\n';
}

/** Datas padrão (R31): véspera do aquecimento (fim do dia = abertura de INICIO_AQUECIMENTO); fim do aquecimento e fim da
 * calibração (conferência: posição(31/01) + eventos de 01/02 a 30/04 contra posição(30/04)). */
export const DATAS_PADRAO = [addDias(INICIO_AQUECIMENTO, -1), JANELAS.aquecimentoFim, JANELAS.calibracaoFim];

/** `dir` é `raiz` ou está abaixo dela (caminhos absolutos já resolvidos). */
/**
 * Caminho CANÔNICO (N2): `realpath` do ancestral existente mais profundo + o resto ainda não criado. Assim um symlink fora
 * do repositório que aponta para dentro dele não fura a guarda.
 */
function canonico(p: string): string {
  let atual = resolve(p);
  const resto: string[] = [];
  while (!existsSync(atual)) {
    const pai = dirname(atual);
    if (pai === atual) break;
    resto.unshift(basename(atual));
    atual = pai;
  }
  return existsSync(atual) ? join(realpathSync(atual), ...resto) : resolve(p);
}

export function dentroDe(dir: string, raiz: string): boolean {
  const d = canonico(dir);
  const r = canonico(raiz);
  return d === r || d.startsWith(r + sep);
}

async function main(): Promise<number> {
  const arqCred = join(homedir(), '.config', 'afiacao', 'omie-oben.env');
  if (!existsSync(arqCred)) {
    console.error(`sem credenciais em ${arqCred} — nenhuma chamada feita`);
    return 2;
  }
  let cred: Credenciais;
  try {
    cred = lerCredenciais(readFileSync(arqCred, 'utf8'));
  } catch (e) {
    console.error(`credencial ilegível: ${e instanceof Error ? e.message : 'erro'} — nenhuma chamada feita`); // mensagem nunca cita valor
    return 3;
  }
  const dir = process.env.REPLAY_DADOS ?? join(homedir(), '.cache', 'afiacao', 'reposicao-replay');
  const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  if (dentroDe(dir, repo)) {
    console.error(`pasta de saída ${dir} está DENTRO do repositório (${repo}) — recuso (dados nunca no repo)`);
    return 3;
  }
  const datas = process.argv.slice(2).length ? process.argv.slice(2) : DATAS_PADRAO;
  const transporte: Transporte = async (corpo) => {
    const r = await fetch(`${OMIE_API_URL}/estoque/consulta/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo });
    return { ok: r.ok, status: r.status, texto: await r.text() };
  };
  const chamar = criarChamada(cred, transporte, (ms) => new Promise((r) => setTimeout(r, ms)));
  for (const d of datas) {
    try {
      const { linhas, paginas } = await paginarPosicao(chamar, d);
      if (linhas.length === 0) throw new Error(`nenhum produto na posição de ${d} — não gravo vazio`);
      const destino = join(dir, `posicao_omie_${d}.csv`);
      writeFileSync(`${destino}.tmp`, paraCsv(linhas));
      renameSync(`${destino}.tmp`, destino);
      const comSaldo = linhas.filter((l) => l.nSaldo !== null).length;
      console.log(`posicao ${d}: ${linhas.length} produtos (${comSaldo} com nSaldo), ${paginas} páginas -> ${destino}`);
    } catch (e) {
      console.error(`posicao ${d}: FALHA: ${redigir(mensagemDeErro(e) ?? 'erro sem mensagem', cred)}`);
      return 1;
    }
  }
  return 0;
}

if (import.meta.main) {
  main()
    .then((rc) => process.exit(rc))
    .catch(() => {
      console.error('falha inesperada (detalhe suprimido para não vazar credencial)');
      process.exit(1);
    });
}
