/**
 * Build MÍNIMO definido pelo servidor — as regras puras.
 *
 * POR QUE ISTO EXISTE: o modo `prompt` do PWA (vite.config.ts) deixa o operador no build
 * velho até ele clicar "Atualizar", por desenho — um deploy não pode recarregar o app no
 * meio do turno. Mas uma migration que fecha coluna (as migrations B, #3072/#3084, fecham
 * as colunas de margem) QUEBRA o build velho com 42501, e até aqui não havia como exigir
 * que o staff estivesse no build novo antes de aplicá-la: só pedir e torcer.
 *
 * Como funciona: uma linha em `company_config` (`key = 'pwa_build_minimo'`, legível pelo
 * staff pela RLS que a tabela já tem; escrita só pelo master) diz
 * `{"build_minimo_em": <ISO>, "prazo": <ISO>}`. Build com carimbo anterior ao mínimo:
 *   - antes do prazo → banner fixo "Atualize até <prazo>";
 *   - depois do prazo → modal bloqueante com "Atualizar".
 * NUNCA recarrega sozinho: o modal só tira o operador do caminho; quem recarrega é o
 * clique. A fila offline sobrevive ao reload (localStorage); o formulário meio-digitado
 * não — por isso o prazo existe.
 *
 * Como subir o mínimo antes de uma migration que quebra build velho: `docs/agent/deploy.md`
 * §PWA ("Build mínimo").
 */

export const CHAVE_CONFIG_BUILD_MINIMO = 'pwa_build_minimo';

export interface BuildMinimo {
  /** Carimbo (`app-build-em`) do primeiro build aceito. Anterior a ele = abaixo do mínimo. */
  buildMinimoEm: string;
  /** A partir deste instante, abaixo do mínimo bloqueia (antes, só avisa). */
  prazo: string;
}

function instante(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * Lê o `value` (texto JSON) da linha de config. Linha ausente, JSON quebrado ou campo
 * ilegível → `null` = SEM exigência. Deliberado: um erro de digitação na config não pode
 * travar o staff inteiro fora do app — falhar aberto aqui custa só o aviso.
 */
export function lerConfigBuildMinimo(valor: string | null | undefined): BuildMinimo | null {
  if (!valor) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(valor);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const { build_minimo_em, prazo } = obj as Record<string, unknown>;
  if (instante(build_minimo_em) === null || instante(prazo) === null) return null;
  return { buildMinimoEm: build_minimo_em as string, prazo: prazo as string };
}

export type ComparacaoBuild = 'abaixo' | 'em_dia' | 'desconhecido';

/**
 * Compara o carimbo de um build com o mínimo. Carimbo desconhecido (build sem o `<meta>`,
 * HTML de forma nova) → `desconhecido`, nunca `abaixo`: ausência de dado não bloqueia.
 * Igual ao mínimo é `em_dia` — o mínimo É o primeiro build aceito.
 */
export function compararBuild(buildEm: string | null, minimoEm: string): ComparacaoBuild {
  const b = instante(buildEm);
  const m = instante(minimoEm);
  if (b === null || m === null) return 'desconhecido';
  return b < m ? 'abaixo' : 'em_dia';
}

export type Exigencia =
  | { tipo: 'nenhuma' }
  | { tipo: 'aviso'; prazo: string }
  | { tipo: 'bloqueio'; prazo: string };

export interface EntradaExigencia {
  /** Carimbo do build que ESTE documento executa. */
  buildEm: string | null;
  /** Carimbo do build que o servidor entrega — só conhecido após uma checagem. */
  buildServidorEm: string | null;
  config: BuildMinimo | null;
  agora: number;
}

/**
 * A decisão: nenhuma · aviso (banner até o prazo) · bloqueio (modal, depois do prazo).
 *
 * Guard do servidor atrasado: se o build que o SERVIDOR entrega também está abaixo do
 * mínimo (o mínimo foi erguido antes do Publish que o satisfaz), atualizar não resolve —
 * não há build bom para baixar. Bloquear ali trancaria o staff sem saída; fica no aviso.
 */
export function decidirExigencia({ buildEm, buildServidorEm, config, agora }: EntradaExigencia): Exigencia {
  if (!config) return { tipo: 'nenhuma' };
  if (compararBuild(buildEm, config.buildMinimoEm) !== 'abaixo') return { tipo: 'nenhuma' };
  if (buildServidorEm !== null && compararBuild(buildServidorEm, config.buildMinimoEm) === 'abaixo') {
    return { tipo: 'aviso', prazo: config.prazo };
  }
  const prazo = instante(config.prazo) as number;
  return agora >= prazo ? { tipo: 'bloqueio', prazo: config.prazo } : { tipo: 'aviso', prazo: config.prazo };
}

/** "20/10 às 18:00" no fuso da operação (o aparelho pode estar em outro). */
export function formatarPrazo(prazo: string): string {
  const d = new Date(prazo);
  const data = d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
  const hora = d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  return `${data} às ${hora}`;
}
