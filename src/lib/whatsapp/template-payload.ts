// Payload de template HSM (Cloud API/360dialog). PURO/testável — espelhado verbatim
// na edge whatsapp-send-template (Deno não importa do src/).
// Meta rejeita body param com newline/tab/4+ espaços consecutivos → sanitize SEMPRE.

export interface TemplatePayloadInput {
  to: string; // dígitos E.164 sem '+'
  templateName: string;
  languageCode?: string;
  bodyParams: string[];
}

export function sanitizeTemplateParam(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/[\n\r]+/g, ', ')
    .replace(/\t/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function validateBodyParams(params: string[], expected: number): string | null {
  if (params.length !== expected) {
    return `template exige ${expected} parâmetro(s) de body; recebeu ${params.length}`;
  }
  const vazio = params.findIndex((p) => sanitizeTemplateParam(p).length === 0);
  if (vazio >= 0) return `parâmetro ${vazio + 1} vazio pós-sanitize`;
  return null;
}

export function buildTemplatePayload(input: TemplatePayloadInput): Record<string, unknown> {
  const params = input.bodyParams.map((t) => ({ type: 'text', text: sanitizeTemplateParam(t) }));
  const template: Record<string, unknown> = {
    name: input.templateName,
    language: { code: input.languageCode ?? 'pt_BR' },
  };
  if (params.length > 0) template.components = [{ type: 'body', parameters: params }];
  return { messaging_product: 'whatsapp', to: input.to, type: 'template', template };
}

export function renderTemplatePreview(corpoReferencia: string, bodyParams: string[]): string {
  return corpoReferencia.replace(/\{\{(\d+)\}\}/g, (m, n) => {
    const idx = Number(n) - 1;
    const v = bodyParams[idx];
    return v === undefined ? m : sanitizeTemplateParam(v);
  });
}
