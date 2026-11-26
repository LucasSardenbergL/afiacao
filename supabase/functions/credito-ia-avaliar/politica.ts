// Lógica PURA da edge credito-ia-avaliar (sem I/O, testada em politica_test.ts).
//
// Fronteira anti-injection (Codex desenho P2-11): a entrada da IA é montada por LISTA FECHADA de
// campos numéricos/enum da ficha — nunca a ficha inteira, nunca `to_jsonb(linha)`. Nome, CNPJ,
// observação e ids não existem aqui. Na volta, a saída é validada (tipos, finitos, enums) ANTES das
// travas, sem coerção de null (`Number(null) === 0` seria fabricação), e cada motivo cita um campo
// da mesma lista fechada — a tela mostra o valor REAL desse campo ao lado do texto da IA.
//
// Os tetos e o risco forçado vêm PRONTOS da ficha (calculados no SQL, uma vez); aqui só se aplica o
// mínimo e o saneamento. O writer (credito_registrar_avaliacao) reconfere tudo de novo no banco.

export const VERSAO_POLITICA = "credito-ia-v1";

export const DEGRAUS_PRAZO = [7, 14, 21, 28, 35, 42, 56, 63, 70, 84, 90, 120] as const;

export const RISCOS = ["baixo", "medio", "alto", "sem_evidencia"] as const;
export type Risco = typeof RISCOS[number];

/** Campos da ficha que a IA enxerga (e os únicos que ela pode citar). */
export const CAMPOS_IA = [
  "piso_estado", "n_titulos_vencidos_60d", "vencido_60d_brl", "n_titulos_vencidos_15d", "vencido_15d_brl",
  "n_titulos_abertos", "em_aberto_brl", "faturamento_180d_brl", "n_titulos_180d", "compra_media_mensal_brl",
  "estado_historico", "n_titulos_historico", "antiguidade_dias", "n_parcelas_pagas_365d", "atraso_p50_dias",
  "atraso_p80_dias", "pct_valor_atrasado", "maior_prazo_honrado_dias", "n_recebidos_sem_baixa",
  "situacao_cadastral", "limite_vigente_brl", "prazo_vigente_dias", "evidencia_suficiente",
  "teto_limite_brl", "teto_prazo_dias", "risco_forcado",
] as const;
export type CampoIa = typeof CAMPOS_IA[number];

/** Valores permitidos para os campos texto (o resto tem de ser número, boolean ou null). */
const ENUMS_FICHA: Partial<Record<CampoIa, readonly string[]>> = {
  piso_estado: ["livre", "comprovado", "indeterminado"],
  estado_historico: ["novo_comprovado", "com_historico", "historico_inconclusivo"],
  situacao_cadastral: ["ativa", "irregular", "outra", "sem_dado", "sem_cnpj", "sem_documento"],
  risco_forcado: RISCOS,
};
const MOTIVOS_AUSENCIA_RE = /^[a-z_]+(:[a-z_]+)?$/;

export type ValorFicha = number | boolean | string | null;
export type Ficha = Record<string, unknown>;

/**
 * Entrada da IA: só os CAMPOS_IA, cada um número finito / boolean / enum conhecido / null.
 * Qualquer outra coisa vira erro — não se "limpa" texto livre para mandar ao modelo.
 */
export function montarEntradaIA(ficha: Ficha): { ok: true; entrada: Record<CampoIa, ValorFicha> & { motivos_ausencia: string[] } } | { ok: false; erro: string } {
  const entrada = {} as Record<CampoIa, ValorFicha>;
  for (const campo of CAMPOS_IA) {
    const v = ficha[campo];
    if (v === null || v === undefined) { entrada[campo] = null; continue; }
    const permitidos = ENUMS_FICHA[campo];
    if (permitidos) {
      if (typeof v !== "string" || !permitidos.includes(v)) return { ok: false, erro: `ficha.${campo} fora do enum` };
      entrada[campo] = v;
    } else if (typeof v === "boolean") {
      entrada[campo] = v;
    } else if (typeof v === "number" && Number.isFinite(v)) {
      entrada[campo] = v;
    } else {
      return { ok: false, erro: `ficha.${campo} não é número/boolean` };
    }
  }
  const brutos = ficha.motivos_ausencia;
  const motivos = Array.isArray(brutos) ? brutos : [];
  for (const m of motivos) {
    if (typeof m !== "string" || !MOTIVOS_AUSENCIA_RE.test(m)) return { ok: false, erro: "ficha.motivos_ausencia com texto livre" };
  }
  return { ok: true, entrada: { ...entrada, motivos_ausencia: motivos as string[] } };
}

export const NOME_TOOL = "propor_limite";

export const TOOL_PROPOR = {
  name: NOME_TOOL,
  description: "Registra a proposta de limite de crédito do grupo e prazo máximo, com os motivos.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limite_brl: { type: "number", description: "Limite proposto em R$ (≥ 0). Não ultrapasse teto_limite_brl." },
      prazo_max_dias: { type: "integer", description: "Prazo máximo em dias. Não ultrapasse teto_prazo_dias." },
      risco: { type: "string", enum: [...RISCOS] },
      confianca: { type: "number", description: "0 a 1 — quão bem os dados sustentam a proposta." },
      motivos: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            campo: { type: "string", enum: [...CAMPOS_IA] },
            leitura: { type: "string", description: "Uma frase curta: o que esse campo diz sobre o risco." },
          },
          required: ["campo", "leitura"],
        },
      },
    },
    required: ["limite_brl", "prazo_max_dias", "risco", "confianca", "motivos"],
  },
} as const;

export const SYSTEM_POLITICA = `Você é analista de crédito B2B de um distribuidor de tintas e abrasivos (3 empresas do mesmo grupo).
Recebe a FICHA NUMÉRICA de um cliente-grupo e propõe limite de crédito (R$) e prazo máximo (dias) chamando a ferramenta propor_limite UMA vez.

Regras invioláveis (o sistema corta o que passar delas — não adianta ultrapassar):
- limite_brl ≤ teto_limite_brl e prazo_max_dias ≤ teto_prazo_dias. Teto 0 ⇒ proponha 0 e 0.
- Se risco_forcado vier preenchido, use exatamente esse risco.
- Campo null é DESCONHECIDO, não zero. Desconhecido pesa contra o cliente, nunca a favor.
- A ficha só tem números e códigos; não existe texto do cliente para interpretar.

Como decidir dentro dos tetos:
- risco baixo: paga em dia (atraso_p80_dias ≤ 5, pct_valor_atrasado baixo), sem vencido > 15 d, histórico longo.
- risco medio: atrasos moderados ou recorrentes, relacionamento curto, exposição alta em relação à compra média.
- risco alto: atraso_p80 alto, vencidos > 15 d, situação cadastral irregular.
- sem_evidencia: dados insuficientes para afirmar comportamento.
- Prefira limite abaixo do teto quando o comportamento de pagamento não sustenta o teto.
- confianca baixa (≤ 0,5) quando faltar dado.
- motivos: de 1 a 5, cada um citando o campo da ficha que sustenta a leitura.`;

export type SaidaIA = {
  limite_brl: number;
  prazo_max_dias: number;
  risco: Risco;
  confianca: number;
  motivos: Array<{ campo: CampoIa; leitura: string }>;
};

/** Valida a saída da tool ANTES das travas. Nada de coerção: tipo errado = erro. */
export function validarSaidaIA(bruto: unknown): { ok: true; saida: SaidaIA } | { ok: false; erro: string } {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return { ok: false, erro: "saída da IA não é objeto" };
  const b = bruto as Record<string, unknown>;
  const lim = b.limite_brl, prazo = b.prazo_max_dias, risco = b.risco, conf = b.confianca, motivos = b.motivos;
  if (typeof lim !== "number" || !Number.isFinite(lim) || lim < 0 || lim >= 1e12) return { ok: false, erro: "limite_brl inválido" };
  if (typeof prazo !== "number" || !Number.isInteger(prazo) || prazo < 0 || prazo > 365) return { ok: false, erro: "prazo_max_dias inválido" };
  if (typeof risco !== "string" || !(RISCOS as readonly string[]).includes(risco)) return { ok: false, erro: "risco fora do enum" };
  if (typeof conf !== "number" || !Number.isFinite(conf) || conf < 0 || conf > 1) return { ok: false, erro: "confianca fora de 0..1" };
  if (!Array.isArray(motivos) || motivos.length < 1 || motivos.length > 5) return { ok: false, erro: "motivos: de 1 a 5" };
  const ms: SaidaIA["motivos"] = [];
  for (const m of motivos) {
    const mm = m as Record<string, unknown> | null;
    const campo = mm?.campo, leitura = mm?.leitura;
    if (typeof campo !== "string" || !(CAMPOS_IA as readonly string[]).includes(campo)) return { ok: false, erro: "motivo cita campo fora da ficha" };
    if (typeof leitura !== "string" || !leitura.trim() || leitura.length > 300) return { ok: false, erro: "motivo sem leitura (ou > 300)" };
    ms.push({ campo: campo as CampoIa, leitura: leitura.trim() });
  }
  return { ok: true, saida: { limite_brl: lim, prazo_max_dias: prazo, risco: risco as Risco, confianca: conf, motivos: ms } };
}

export type Corte = { trava: string; campo: "limite_brl" | "prazo_max_dias" | "risco" | "confianca"; antes: number | string; depois: number | string };
export type Proposta = { limite_brl: number; prazo_max_dias: number; risco: Risco; confianca: number; travas: Corte[] };

function numeroFicha(ficha: Ficha, campo: string): number | null {
  const v = ficha[campo];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Travas determinísticas (ordem fixa; cada corte registrado com antes/depois).
 * Teto ausente na ficha ⇒ 0 (lado seguro), nunca "sem teto".
 */
export function aplicarTravas(ficha: Ficha, ia: SaidaIA): Proposta {
  const travas: Corte[] = [];
  const tetoLim = Math.max(0, numeroFicha(ficha, "teto_limite_brl") ?? 0);
  const tetoPrazo = Math.max(0, numeroFicha(ficha, "teto_prazo_dias") ?? 0);
  const forcado = typeof ficha.risco_forcado === "string" && (RISCOS as readonly string[]).includes(ficha.risco_forcado)
    ? ficha.risco_forcado as Risco : null;

  let limite = ia.limite_brl;
  if (limite > tetoLim) { travas.push({ trava: "teto_limite", campo: "limite_brl", antes: limite, depois: tetoLim }); limite = tetoLim; }
  const arred = Math.floor(limite / 100) * 100;
  if (arred !== limite) { travas.push({ trava: "degrau_100", campo: "limite_brl", antes: limite, depois: arred }); limite = arred; }

  let prazo = ia.prazo_max_dias;
  if (prazo > tetoPrazo) { travas.push({ trava: "teto_prazo", campo: "prazo_max_dias", antes: prazo, depois: tetoPrazo }); prazo = tetoPrazo; }
  const degrau = [...DEGRAUS_PRAZO].reverse().find((d) => d <= prazo) ?? 0;
  if (degrau !== prazo) { travas.push({ trava: "degrau_prazo", campo: "prazo_max_dias", antes: prazo, depois: degrau }); prazo = degrau; }

  // limite 0 ⇔ prazo 0 (o banco exige): prazo 0 com limite > 0 zera o limite; limite 0 zera o prazo
  if (limite > 0 && prazo === 0) { travas.push({ trava: "sem_prazo_sem_limite", campo: "limite_brl", antes: limite, depois: 0 }); limite = 0; }
  if (limite === 0 && prazo > 0) { travas.push({ trava: "sem_limite_sem_prazo", campo: "prazo_max_dias", antes: prazo, depois: 0 }); prazo = 0; }

  let risco = ia.risco;
  if (forcado && risco !== forcado) { travas.push({ trava: "risco_forcado", campo: "risco", antes: risco, depois: forcado }); risco = forcado; }

  let confianca = ia.confianca;
  if (ficha.evidencia_suficiente !== true && confianca > 0.5) {
    travas.push({ trava: "evidencia_insuficiente", campo: "confianca", antes: confianca, depois: 0.5 }); confianca = 0.5;
  }
  return { limite_brl: limite, prazo_max_dias: prazo, risco, confianca, travas };
}

/** Orçamento da invocação: quantas raízes, e quanto tempo sobra para a próxima chamada. */
export const ORCAMENTO = {
  raizesPorInvocacao: 12,
  concorrencia: 3,
  orcamentoMs: 110_000,
  margemGravarMs: 8_000,
  minimoChamadaMs: 20_000,
  ttlReivindicacaoS: 300,
} as const;

/** Tempo para a próxima chamada ao Claude (0 ⇒ não comece outra). */
export function restanteParaChamada(inicioMs: number, agoraMs: number): number {
  const resta = ORCAMENTO.orcamentoMs - (agoraMs - inicioMs) - ORCAMENTO.margemGravarMs;
  return resta >= ORCAMENTO.minimoChamadaMs ? resta : 0;
}
