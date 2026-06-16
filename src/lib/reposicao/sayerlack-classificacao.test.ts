import { describe, it, expect } from "vitest";
import {
  classifyEnvelopeStatus,
  decidirStatusDeno,
  type ClassifyInput,
} from "./sayerlack-classificacao";

const base: ClassifyInput = {
  success: false,
  protocolo: null,
  protocoloAutoExtraido: false,
  efetivarAttempted: false,
  erroTipo: null,
};

describe("classifyEnvelopeStatus — Camada 1 (Browserless)", () => {
  it("caso 355: timeout PRÉ-Efetivar (efetivarAttempted=false) → erro_retentavel (auto-retry)", () => {
    const r = classifyEnvelopeStatus({ ...base, efetivarAttempted: false, erroTipo: "EXCEPTION" });
    expect(r.status).toBe("erro_retentavel");
    expect(r.safeToRetry).toBe(true);
    expect(r.needsReconciliation).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("clicou Efetivar + sem sinal (efetivarAttempted=true) → indeterminado", () => {
    const r = classifyEnvelopeStatus({ ...base, efetivarAttempted: true, erroTipo: "EXCEPTION" });
    expect(r.status).toBe("indeterminado_requer_conciliacao");
    expect(r.safeToRetry).toBe(false);
    expect(r.needsReconciliation).toBe(true);
  });

  it("P1.1 Codex: clicou Efetivar mas recorder perdeu o POST (efetivarAttempted=true) → indeterminado, NÃO retentável", () => {
    // requestSent não existe mais na decisão; o que importa é efetivarAttempted.
    const r = classifyEnvelopeStatus({ ...base, efetivarAttempted: true, erroTipo: "EXCEPTION" });
    expect(r.status).toBe("indeterminado_requer_conciliacao");
    expect(r.safeToRetry).toBe(false);
  });

  it("undefined-safety: efetivarAttempted ausente (undefined) → indeterminado (fail-closed), nunca retentável", () => {
    const r = classifyEnvelopeStatus({ ...base, efetivarAttempted: undefined, erroTipo: "EXCEPTION" });
    expect(r.status).toBe("indeterminado_requer_conciliacao");
    expect(r.safeToRetry).toBe(false);
  });

  it("success=true com protocolo → sucesso_portal", () => {
    const r = classifyEnvelopeStatus({ ...base, success: true, protocolo: "123456", efetivarAttempted: true });
    expect(r.status).toBe("sucesso_portal");
    expect(r.ok).toBe(true);
    expect(r.needsReconciliation).toBe(false);
  });

  it("success=true SEM protocolo → aceito_portal_sem_protocolo (precisa conciliar)", () => {
    const r = classifyEnvelopeStatus({ ...base, success: true, protocolo: null, efetivarAttempted: true });
    expect(r.status).toBe("aceito_portal_sem_protocolo");
    expect(r.ok).toBe(true);
    expect(r.needsReconciliation).toBe(true);
  });

  it("P1.3 Codex: protocolo auto-extraído + efetivarAttempted=true → sucesso_portal", () => {
    const r = classifyEnvelopeStatus({
      ...base,
      protocolo: "999",
      protocoloAutoExtraido: true,
      efetivarAttempted: true,
    });
    expect(r.status).toBe("sucesso_portal");
    expect(r.ok).toBe(true);
  });

  it("P1.3 Codex: protocolo auto-extraído de resposta de RASCUNHO (efetivarAttempted=false) → NÃO vira sucesso (cai em erro_retentavel)", () => {
    const r = classifyEnvelopeStatus({
      ...base,
      protocolo: "999",
      protocoloAutoExtraido: true,
      efetivarAttempted: false,
    });
    expect(r.status).toBe("erro_retentavel");
    expect(r.ok).toBe(false);
  });

  it("P1.3 borda: protocolo auto-extraído MAS efetivarAttempted undefined → NÃO sucesso → indeterminado (fail-closed)", () => {
    const r = classifyEnvelopeStatus({
      ...base,
      protocolo: "999",
      protocoloAutoExtraido: true,
      efetivarAttempted: undefined,
    });
    expect(r.status).toBe("indeterminado_requer_conciliacao");
    expect(r.ok).toBe(false);
  });

  it("SKU_NOT_FOUND (erro lógico pré-submit) → erro_nao_retentavel, mesmo com efetivarAttempted=false", () => {
    const r = classifyEnvelopeStatus({ ...base, erroTipo: "SKU_NOT_FOUND", efetivarAttempted: false });
    expect(r.status).toBe("erro_nao_retentavel");
    expect(r.safeToRetry).toBe(false);
    expect(r.needsReconciliation).toBe(false);
  });

  it("GRUPO_LEADTIME_MISMATCH → erro_nao_retentavel", () => {
    const r = classifyEnvelopeStatus({ ...base, erroTipo: "GRUPO_LEADTIME_MISMATCH", efetivarAttempted: false });
    expect(r.status).toBe("erro_nao_retentavel");
  });

  it("LOGIN_FAILED / CLIENTE_NOT_FOUND → erro_nao_retentavel", () => {
    expect(classifyEnvelopeStatus({ ...base, erroTipo: "LOGIN_FAILED" }).status).toBe("erro_nao_retentavel");
    expect(classifyEnvelopeStatus({ ...base, erroTipo: "CLIENTE_NOT_FOUND" }).status).toBe("erro_nao_retentavel");
  });

  it("erro genérico (NAVIGATION_FAILED) pré-rascunho, efetivarAttempted=false → erro_retentavel", () => {
    const r = classifyEnvelopeStatus({ ...base, erroTipo: "NAVIGATION_FAILED", efetivarAttempted: false });
    expect(r.status).toBe("erro_retentavel");
    expect(r.safeToRetry).toBe(true);
  });

  it("erro lógico pré-submit precede a checagem de efetivarAttempted (ordem importa)", () => {
    // Mesmo se por algum motivo efetivarAttempted=true, um erro lógico determinístico continua não-retentável.
    const r = classifyEnvelopeStatus({ ...base, erroTipo: "SKU_NOT_FOUND", efetivarAttempted: true });
    expect(r.status).toBe("erro_nao_retentavel");
  });
});

describe("decidirStatusDeno — Camada 2 (rede de segurança Deno)", () => {
  it("erro_retentavel + efetivarAttempted=true → ENDURECE para indeterminado", () => {
    expect(decidirStatusDeno("erro_retentavel", true)).toBe("indeterminado_requer_conciliacao");
  });

  it("erro_retentavel + efetivarAttempted=false EXPLÍCITO → mantém erro_retentavel (auto-retry)", () => {
    expect(decidirStatusDeno("erro_retentavel", false)).toBe("erro_retentavel");
  });

  it("erro_retentavel + efetivarAttempted=undefined → ENDURECE para indeterminado (undefined-safety)", () => {
    expect(decidirStatusDeno("erro_retentavel", undefined)).toBe("indeterminado_requer_conciliacao");
  });

  it("P1.2 Codex: status DESCONHECIDO → indeterminado (fail-closed), nunca passa adiante como retentável", () => {
    expect(decidirStatusDeno("estado_invemtado", false)).toBe("indeterminado_requer_conciliacao");
    expect(decidirStatusDeno("", false)).toBe("indeterminado_requer_conciliacao");
  });

  it("NUNCA rebaixa: indeterminado/sucesso/aceito/erro_nao_retentavel passam intactos", () => {
    expect(decidirStatusDeno("indeterminado_requer_conciliacao", false)).toBe("indeterminado_requer_conciliacao");
    expect(decidirStatusDeno("indeterminado_requer_conciliacao", true)).toBe("indeterminado_requer_conciliacao");
    expect(decidirStatusDeno("sucesso_portal", true)).toBe("sucesso_portal");
    expect(decidirStatusDeno("aceito_portal_sem_protocolo", true)).toBe("aceito_portal_sem_protocolo");
    expect(decidirStatusDeno("erro_nao_retentavel", false)).toBe("erro_nao_retentavel");
  });
});

describe("consistência entre as duas camadas", () => {
  it("355 ponta-a-ponta: Camada 1 → erro_retentavel; Camada 2 (efetivarAttempted=false) mantém retentável", () => {
    const c1 = classifyEnvelopeStatus({ ...base, efetivarAttempted: false, erroTipo: "EXCEPTION" });
    expect(c1.status).toBe("erro_retentavel");
    expect(decidirStatusDeno(c1.status, false)).toBe("erro_retentavel");
  });

  it("clicou ponta-a-ponta: Camada 1 → indeterminado; Camada 2 não afrouxa", () => {
    const c1 = classifyEnvelopeStatus({ ...base, efetivarAttempted: true, erroTipo: "EXCEPTION" });
    expect(c1.status).toBe("indeterminado_requer_conciliacao");
    expect(decidirStatusDeno(c1.status, true)).toBe("indeterminado_requer_conciliacao");
  });
});
