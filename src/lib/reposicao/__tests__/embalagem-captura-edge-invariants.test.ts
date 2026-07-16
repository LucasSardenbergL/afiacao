import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Invariante de segurança da edge de CAPTURA de preços Sayerlack (money-path):
// "não existe caminho de código que alcance o Efetivar" (spec 2026-07-14, §Fase 1).
// O incidente de ~R$82k com pedidos órfãos no portal é o motivo do gate. A edge de
// captura compartilha só o PADRÃO de login com a de envio — nunca os seletores de
// efetivação/gravação. Se qualquer um destes tokens aparecer no arquivo, o CI quebra.
const EDGE = resolve(process.cwd(), 'supabase/functions/sayerlack-captura-precos/index.ts');

// - btnSalvarNovoPedido: o botão "Efetivar Pedido" — o ÚNICO ponto que coloca pedido na Sayerlack.
// - efetivar: qualquer menção (código/seletor/texto de clique) — a captura nem conhece o conceito.
// - btnGravarItem / save-tab-preco-session: gravação de linha no rascunho — o fluxo de captura
//   lê a linha EM EDIÇÃO e cancela; não grava linha (zero estado no portal, nem em sessão).
const TOKENS_PROIBIDOS = ['btnSalvarNovoPedido', 'efetivar', 'btnGravarItem', 'save-tab-preco-session'];

describe('edge sayerlack-captura-precos: sem caminho até o Efetivar', () => {
  it('o arquivo da edge não contém nenhum token de efetivação/gravação', () => {
    const codigo = readFileSync(EDGE, 'utf8').toLowerCase();
    for (const token of TOKENS_PROIBIDOS) {
      expect(codigo.includes(token.toLowerCase()), `token proibido presente: ${token}`).toBe(false);
    }
  });
});
