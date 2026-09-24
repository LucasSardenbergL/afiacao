// Decisões PURAS do `omie-sync-sku-items` sobre o que a Omie respondeu: limite do RUN ≠ falha da
// NFe, o motivo gravado no controle, e o status do run. Sem I/O, sem dependência de runtime —
// testes em adiamento_test.ts (Deno, `--no-remote`). A chamada HTTP que usa estas decisões vive em
// consulta.ts, com dependências injetáveis, testada em consulta_test.ts.
//
// ── Por que existe ───────────────────────────────────────────────────────────────────────────
// O #2031 (2026-08-26) deu ao `callOmie` um deadline compartilhado e passou a LANÇAR quando a
// espera que a Omie pede ("Aguarde N segundos") não cabe no guard de 50s do run. Só que o
// `catch` do laço trata TODA exceção como falha da NFe: `marcarTentativa("consulta_falhou: …")`
// → backoff 6h/24h/72h — e o run fecha `error` "1 consultas Omie tentadas, 0 OK". Medido em
// 2026-09-23 (OBEN, 30 dias): 46 runs `error`, TODOS no minuto :15/:16 do `omie-cron-diario`,
// zero nos 30 runs das 07:00. A causa é o step NFe do mesmo ciclo, que consultou a MESMA NFe
// (`ConsultarRecebimento(nIdReceb)`) segundos antes — a Omie responde "Consumo redundante
// detectado (REDUNDANT)" com N≈50s, que nunca cabe em 50s. A NFe não tem defeito nenhum: é o
// RUN que não tem tempo. Punir a NFe tirava-a da fila por horas e paginava o Sentinela à toa
// (6 e-mails falsos em 30 dias).
//
// ── O contrato ───────────────────────────────────────────────────────────────────────────────
// Um limite que o run não consegue honrar é ADIAMENTO: a NFe NÃO ganha tentativa (mantém as que
// já tinha e segue elegível), o summary conta `consultas_adiadas_por_limite`, e o status do run
// NÃO vira `error` por isso. Falha REAL (HTTP não-2xx, socket abortado, corpo que não é objeto
// JSON) continua lançando e caindo no `catch` → `marcarTentativa`.
//
// A discriminação é por MARCA ESTRUTURAL emitida por quem decidiu (`adiada: true` + `motivo` de
// um conjunto FECHADO), nunca por `instanceof` (classe duplicada atravessa mal bundle) nem por
// texto de mensagem (docs/agent/money-path.md §"Fail-closed que CAPTURA rejeição tem de
// discriminar o que captura"). `ehConsultaAdiada(new Error("limite pede 54s…"))` é FALSE de
// propósito — o mesmo texto num Error é falha.
//
// ── "complete" não prova efeito ──────────────────────────────────────────────────────────────
// Deixar de gritar no adiamento abre o furo oposto: uma fila que NUNCA anda (adiada em todo run,
// ou o guard vencendo antes de alcançá-la) fecharia `complete` para sempre. O sensor
// `avaliarFilaParada` + `decidirErroDoRun` fecham esse furo pelo lado do DADO: NFe da fila elegível
// deste run, consultável (com nIdReceb), ELEGÍVEL HÁ MAIS DE 48h, que o run não tratou (nem
// resposta, nem falha marcada) ⇒ `error` "fila não anda". Independe da vazão das OUTRAS NFes do
// run — a mesma NFe adiada para sempre atrás de três sucessos também grita (achado do Codex no
// desenho). NFe em backoff não conta (está fora da fila elegível); NFe sem nIdReceb não conta (gap
// de cobertura conhecido, sync-registry.md gotcha (c), contado à parte).
//
// ⚠️ A régua é "elegível desde", não "faturada há" — e isto foi MEDIDO, não escolhido (2026-09-24,
// psql-ro): numa linha de PEDIDO o t2 chega em mediana 47h DEPOIS do `created_at`, e 1 em 69 NFes
// aparece para nós com o t2 já passado de 24h. Com a régua do t2, toda NFe de 1–3 dias adiada no
// :15 (a chamada REDUNDANT do step NFe, enquanto o sku-items ainda for step do orquestrador) virava
// "fila não anda" em runs SEGUIDOS — o e-mail falso de volta. "Elegível desde" = fim do backoff
// quando já tentada; senão o MAIOR entre o nascimento da linha e o faturamento (o recebimento não
// é consultável antes de existir). O limiar de 48h garante ao menos UMA passada do diário das 07:00
// — o único run que alcança NFe adiada no :15 ou fora da janela de 3 dias — antes de gritar.
//
// ⚠️ E o sensor NÃO é avaliado quando a chamada vem do ORQUESTRADOR (o :15 do jobid 52): ali o
// adiamento por REDUNDANT é ESPERADO enquanto o sku-items for step dele, e uma NFe cujo nIdReceb
// chegou depois do diário das 07:00 com faturamento de 60h ficaria "parada" nos dois ciclos
// seguintes — página falsa (achado do Codex no código, reproduzido). No caminho do orquestrador o
// adiamento mede a COLISÃO, não a fila. Depois da parte B o orquestrador não chama mais esta edge.

import { cabeEspera } from "../_shared/omie-deadline.ts";

/** Conjunto FECHADO dos motivos de adiamento — é ele que o guard estrutural confere. */
export const MOTIVOS_ADIAMENTO = [
  /** A Omie pediu "Aguarde N segundos" e N não cabe antes do deadline do run. */
  "limite_nao_cabe_no_deadline",
  /** A Omie seguiu pedindo espera em TODAS as retentativas que o run permite. */
  "limite_persistiu_apos_retentativas",
  /** O deadline do run venceu antes de (re)tentar a chamada — nada (mais) saiu para a Omie. */
  "deadline_antes_da_chamada",
] as const;

export type MotivoAdiamento = (typeof MOTIVOS_ADIAMENTO)[number];

/** Consulta ADIADA por limite do run — NÃO é falha da NFe e NÃO marca tentativa. */
export interface ConsultaAdiada {
  readonly adiada: true;
  readonly motivo: MotivoAdiamento;
  /** Espera que a Omie pediu (ms); 0 quando o motivo não envolve espera pedida. */
  readonly esperaMs: number;
  /** Texto humano para o log — NUNCA usado para decidir nada. */
  readonly detalhe: string;
}

export function adiarConsulta(motivo: MotivoAdiamento, esperaMs: number, detalhe: string): ConsultaAdiada {
  return { adiada: true, motivo, esperaMs, detalhe };
}

/** Guard ESTRUTURAL: só o que `adiarConsulta` emite passa. Texto igual num `Error` não passa. */
export function ehConsultaAdiada(x: unknown): x is ConsultaAdiada {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.adiada === true &&
    typeof o.motivo === "string" &&
    (MOTIVOS_ADIAMENTO as readonly string[]).includes(o.motivo) &&
    typeof o.esperaMs === "number" &&
    typeof o.detalhe === "string";
}

/** A Omie sinaliza limite por HTTP 429 OU por faultstring (em HTTP 200 ou não): rate limit,
 *  REDUNDANT, "Já existe uma requisição desse método". A faultstring de limite VENCE o status —
 *  mesma regra do `classifyOmieResponse` da edge irmã (omie-sync-nfes-recebidas/retry.ts). 5xx
 *  sem faultstring de limite é FALHA, não limite. */
export function ehRespostaDeLimite(status: number, faultstring: string): boolean {
  if (status === 429) return true;
  return /rate limit/i.test(faultstring) ||
    /consumo redundante/i.test(faultstring) ||
    /redundant/i.test(faultstring) ||
    faultstring.includes("Já existe uma requisição desse método");
}

/** Espera que a Omie pediu ("Aguarde N segundos") mais 3s de folga; sem N, o fallback do chamador. */
export function esperaPedidaMs(faultstring: string, fallbackMs: number): number {
  const match = faultstring.match(/Aguarde\s+(\d+)\s+segundos/i);
  if (!match) return fallbackMs;
  return (Number(match[1]) + 3) * 1000;
}

export type VeredictoLimite =
  | { tipo: "esperar"; esperaMs: number }
  | { tipo: "adiar"; consulta: ConsultaAdiada };

/**
 * A Omie pediu para esperar: dormir e retentar, ou ADIAR a NFe para o próximo run?
 *
 * Ordem das regras, e por quê:
 *   1. Última tentativa permitida e a Omie ainda pede espera → adiar SEM dormir (dormir agora só
 *      queimaria o guard: não há tentativa seguinte para aproveitar o sono). Antes era um `throw`
 *      depois do laço, tratado como falha da NFe.
 *   2. A espera não cabe antes do deadline (`cabeEspera`, que já reserva o mínimo de um request)
 *      → adiar. É o caso do incidente: REDUNDANT com N≈50s num run de 50s.
 *   3. Senão → esperar e retentar (comportamento que já existia).
 */
export function decidirLimite(p: {
  agora: number;
  deadline: number;
  esperaMs: number;
  tentativa: number;
  maxTentativas: number;
}): VeredictoLimite {
  const segundos = Math.round(p.esperaMs / 1000);
  if (p.tentativa >= p.maxTentativas) {
    return {
      tipo: "adiar",
      consulta: adiarConsulta(
        "limite_persistiu_apos_retentativas",
        p.esperaMs,
        `Omie seguiu pedindo ${segundos}s de espera na tentativa ${p.tentativa}/${p.maxTentativas}`,
      ),
    };
  }
  if (!cabeEspera(p.agora, p.deadline, p.esperaMs)) {
    return {
      tipo: "adiar",
      consulta: adiarConsulta(
        "limite_nao_cabe_no_deadline",
        p.esperaMs,
        `Omie pede ${segundos}s de espera, não cabe antes do deadline do run`,
      ),
    };
  }
  return { tipo: "esperar", esperaMs: p.esperaMs };
}

/**
 * Depois de ADIAR uma NFe, o laço segue para a próxima ou encerra?
 *
 * Limite da Omie é por CHAMADA (REDUNDANT é "a mesma chamada, os mesmos parâmetros"), então outra
 * NFe pode responder — segue (o guard do laço limita o custo: 5s de cadência por adiada). Deadline
 * vencido antes da chamada vale para TODAS as seguintes — encerra, e o chamador marca
 * `interrompido_por_timeout` (é o mesmo corte que o guard do topo do laço faria na próxima volta,
 * só que sem contar mais uma NFe como processada). [Codex, desenho]
 */
export function saidaDoLaco(motivo: MotivoAdiamento): "proxima" | "encerrar" {
  return motivo === "deadline_antes_da_chamada" ? "encerrar" : "proxima";
}

/**
 * O texto gravado em `sku_items_sync_controle.motivo` quando a NFe É marcada (a consulta foi
 * RESPONDIDA). Nenhuma função, view ou tela lê estes valores (auditado 2026-09-24: pg_proc,
 * pg_get_viewdef e src/) — são diagnóstico para quem abre a tabela, então têm de dizer a verdade:
 *
 *   · gravou parte dos itens e parte falhou → `ok_parcial: g de r gravados; …` — o item que falhou
 *     some da fila no run seguinte (a linha gravada já tira o tracking da fila: achado do Codex,
 *     pré-existente, fora deste conserto — ver o histórico); o motivo ao menos o deixa à vista;
 *   · gravou todos os itens → `ok_com_itens`;
 *   · resolveu itens mas NENHUM upsert pegou → `upsert_falhou: …` (antes virava `ok_0_itens`, a
 *     mentira de "a NFe não tem itens" quando quem falhou foi o nosso banco);
 *   · faultstring de negócio → `fault: …`;
 *   · payload SEM a chave `itensRecebimento` → `ok_sem_itensRecebimento` (ausente ≠ zero: separa
 *     "a Omie não mandou a lista" de "a lista veio vazia" — evidência para decidir, sem mudar o
 *     comportamento, se a família Sayerlack série 1 de 0 itens é uma coisa ou a outra);
 *   · itens vieram mas nenhum com `nIdProduto` → `ok_itens_sem_nIdProduto`;
 *   · lista vazia → `ok_0_itens`.
 */
export function motivoDaTentativa(r: {
  faultstring: string | null;
  itensEhLista: boolean;
  itensRecebidos: number;
  itensResolvidos: number;
  itensGravados: number;
  ultimoErroUpsert: string | null;
}): string {
  if (r.itensGravados > 0 && r.itensResolvidos > r.itensGravados) {
    return `ok_parcial: ${r.itensGravados} de ${r.itensResolvidos} gravados; ${r.ultimoErroUpsert ?? "sem mensagem"}`;
  }
  if (r.itensGravados > 0) return "ok_com_itens";
  if (r.itensResolvidos > 0) return `upsert_falhou: ${r.ultimoErroUpsert ?? "sem mensagem"}`;
  if (r.faultstring) return `fault: ${r.faultstring}`;
  if (!r.itensEhLista) return "ok_sem_itensRecebimento";
  if (r.itensRecebidos > 0) return "ok_itens_sem_nIdProduto";
  return "ok_0_itens";
}

/** Há quanto tempo uma NFe tem de estar ELEGÍVEL, sem ser tratada, para a fila contar como
 *  parada: 48h = ao menos uma passada do diário das 07:00 (o único run que alcança NFe fora da
 *  janela de 3 dias ou adiada no :15) mais ~12 runs de 2h. Atraso de horas num leadtime é imaterial
 *  para a estatística (meses); a página falsa não é. */
export const ELEGIVEL_HA_MUITO_MS = 48 * 3_600_000;

/**
 * Desde quando a NFe está ELEGÍVEL (consultável e fora de backoff), em ms — ou `null` quando não dá
 * para afirmar (data ilegível), e aí o sensor NÃO a conta (fail-safe do lado que pagina):
 *   · já tentada → o fim do backoff (`ultima_tentativa` + backoff das `tentativas`);
 *   · nunca tentada → o MAIOR entre o nascimento da linha e o faturamento. Numa linha de PEDIDO o
 *     `created_at` é de dias antes do faturamento, e o recebimento não existe antes da NFe; numa
 *     órfã do sync de NFes o `created_at` é quando ela apareceu. É um piso: o recebimento pode ter
 *     virado consultável DEPOIS (medido: p90 de 17h), e o limiar de 48h absorve essa folga.
 * O backoff chega como parâmetro para este módulo não depender do espelho da fila do index.ts.
 */
export function elegivelDesdeMs(
  controle: { tentativas: number; ultima_tentativa: string | null } | undefined,
  criadaEm: string | null,
  faturadaEm: string | null,
  backoffMs: (tentativas: number) => number,
): number | null {
  if (controle && controle.tentativas > 0) {
    if (!controle.ultima_tentativa) return null;
    const ultima = Date.parse(controle.ultima_tentativa);
    return Number.isFinite(ultima) ? ultima + backoffMs(controle.tentativas) : null;
  }
  const criada = criadaEm ? Date.parse(criadaEm) : NaN;
  const faturada = faturadaEm ? Date.parse(faturadaEm) : NaN;
  if (!Number.isFinite(criada) && !Number.isFinite(faturada)) return null;
  if (!Number.isFinite(criada)) return faturada;
  if (!Number.isFinite(faturada)) return criada;
  return Math.max(criada, faturada);
}

/**
 * Quantos RECEBIMENTOS (nIdReceb — a unidade de uma chamada) da fila elegível estão parados: com
 * alguma linha elegível há mais que `limiteMs` e sem tratamento neste run ("tratado" = a Omie
 * respondeu, ou a falha foi marcada no controle). Sobram os ADIADOS por limite e os NÃO ALCANÇADOS
 * pelo guard.
 *
 * Recebe a fila ANTES do dedup por nIdReceb, de propósito (achado do Codex no código): a fila
 * deduplicada elege a irmã NUNCA tentada, e a idade da irmã que está parada há 60h sumia atrás da
 * de 2h. Aqui cada recebimento leva a MENOR "elegível desde" entre as suas linhas.
 *
 * Fail-safe no sentido do sensor: "elegível desde" indecidível não conta, linha sem nIdReceb não
 * conta (gap (c) do registry, contado à parte), exatamente no limite não conta ("há mais que").
 */
export function avaliarFilaParada(
  filaElegivel: readonly {
    id: string;
    nIdReceb: string | null;
    created_at: string | null;
    t2_data_faturamento: string | null;
  }[],
  controlePorId: ReadonlyMap<string, { tentativas: number; ultima_tentativa: string | null }>,
  recebimentosTratados: ReadonlySet<string>,
  agoraMs: number,
  backoffMs: (tentativas: number) => number,
  limiteMs: number = ELEGIVEL_HA_MUITO_MS,
): number {
  const maisAntigaPorRecebimento = new Map<string, number>();
  for (const linha of filaElegivel) {
    if (!linha.nIdReceb || recebimentosTratados.has(linha.nIdReceb)) continue;
    const desde = elegivelDesdeMs(controlePorId.get(linha.id), linha.created_at, linha.t2_data_faturamento, backoffMs);
    if (desde === null || !Number.isFinite(desde)) continue;
    const atual = maisAntigaPorRecebimento.get(linha.nIdReceb);
    if (atual === undefined || desde < atual) maisAntigaPorRecebimento.set(linha.nIdReceb, desde);
  }
  let parados = 0;
  for (const desde of maisAntigaPorRecebimento.values()) {
    if (agoraMs - desde > limiteMs) parados++;
  }
  return parados;
}

/** O que decide o status do run. Os nomes são os do summary da edge — o chamador passa o summary. */
export interface EstadoDoRun {
  /** NFes que a Omie RESPONDEU (2xx, objeto JSON, sem limite). */
  consultas_detalhadas: number;
  /** NFes com falha REAL (HTTP não-2xx, socket, corpo inválido) — as que marcam tentativa. */
  consultas_falhas: number;
  /** Saída de `avaliarFilaParada`, medida DEPOIS do laço — ou `null` quando o sensor NÃO foi
   *  avaliado (chamada via orquestrador; ver o cabeçalho). `null` nunca vira zero nem `error`. */
  fila_parada_48h: number | null;
  /** Chamadas a `marcarTentativa` feitas no run (1 por NFe respondida ou falhada). */
  controle_marcacoes: number;
  /** Das marcações, quantas NÃO persistiram. */
  controle_falhas: number;
  /** Linhas (tracking, sku) gravadas em `sku_leadtime_history`. */
  itens_processados: number;
  /** Upserts de `sku_leadtime_history` que falharam. */
  erros: number;
  recompute_erro: string | null;
}

/**
 * Mensagem de `error` do run, ou `undefined` (= complete). A primeira regra que casa vence — o
 * `results` guarda todos os contadores, então a mensagem só precisa apontar o mais acionável.
 *
 *   1. Falha sistêmica: houve falha REAL e nenhuma consulta respondeu (rate-limit 3x virou
 *      adiamento; sobra HTTP/socket/corpo inválido). ADIAMENTO NÃO ENTRA — é a correção do
 *      incidente de 2026-08-27..09-23, cuja mensagem era "N consultas Omie tentadas, 0 OK".
 *   2. Controle inoperante: NENHUMA marcação persistiu (grant/RLS) — o backoff morre e o poison
 *      volta. O denominador são as marcações FEITAS, não as consultas tentadas: a NFe adiada não
 *      marca por desenho, e dividir por tentadas esconderia o controle morto num run com adiamento.
 *   3. Escrita morta: houve upsert de leadtime e NENHUM pegou — `complete` com efeito zero.
 *   4. Fila não anda: NFe consultável, elegível há >48h, que o run não tratou.
 *   5. Recompute derivado falhou (migration/grant) — o leadtime deixa de MELHORAR, não piora; por
 *      isso vem por último.
 */
export function decidirErroDoRun(e: EstadoDoRun): string | undefined {
  if (e.consultas_falhas > 0 && e.consultas_detalhadas === 0) {
    return `${e.consultas_falhas} consultas Omie falharam, 0 OK — rate-limit/indisponibilidade?`;
  }
  if (e.controle_marcacoes > 0 && e.controle_falhas === e.controle_marcacoes) {
    return `controle não persistiu em ${e.controle_falhas}/${e.controle_marcacoes} tentativas — backoff inoperante (grant/RLS?)`;
  }
  if (e.erros > 0 && e.itens_processados === 0) {
    return `upsert do leadtime falhou em ${e.erros} itens, 0 gravados — grant/RLS/constraint?`;
  }
  if (e.fila_parada_48h !== null && e.fila_parada_48h > 0) {
    return `fila não anda: ${e.fila_parada_48h} NFes elegíveis há >48h ficaram sem consulta neste run (adiadas por limite ou não alcançadas pelo guard)`;
  }
  if (e.recompute_erro) {
    return `recompute derivado do leadtime falhou (migration 20260716200000 aplicada? grant do service_role?): ${e.recompute_erro}`;
  }
  return undefined;
}
