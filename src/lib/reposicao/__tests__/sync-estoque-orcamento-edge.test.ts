import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Guarda textual do orçamento de tempo do omie-sync-estoque (incidente 2026-10-05 17:40Z, net._http_response
// 104687): o run morreu na fase do PO por deadline, e o throw — fatal por desenho (Codex P1 2026-06-20) — descartou
// o físico já lido. A v1.5 dá 5s a mais às varreduras e registra cada run. A fase do PO segue DEPOIS do físico: o
// paralelo foi revertido no adversarial do #2817, porque lido antes o PO conta duas vezes a NF recebida no meio do
// run. O adaptador do registro tem testes Deno (registro-com-prazo_test.ts); aqui se vigia ONDE e COMO o handler usa
// as peças, sobre a fonte SEM comentários. Texto prova presença e ordem, não comportamento.
const fonte = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-estoque/index.ts'), 'utf8'),
);
const iHandler = fonte.indexOf('Deno.serve(');

function constante(nome: string): number {
  const m = fonte.match(new RegExp(`const ${nome} = ([\\d_]+);`));
  if (!m) throw new Error(`constante ${nome} não encontrada na edge`);
  return Number(m[1].replace(/_/g, ''));
}

describe('omie-sync-estoque — o par (físico, pendente) e a semântica fatal do PO', () => {
  it('a fase do PO roda DEPOIS do físico inteiro e ANTES de qualquer acesso à sku_estoque_atual', () => {
    const iLaco = fonte.indexOf('while (page <= totalPaginas)', iHandler);
    const iFimLaco = fonte.indexOf('const faseFisicoMs', iHandler);
    const iPo = fonte.indexOf('await computePendenteViaPedidosCompra(', iHandler);
    const iEstoque = fonte.indexOf('.from("sku_estoque_atual")', iHandler);
    expect(iHandler).toBeGreaterThan(0);
    expect(iLaco).toBeGreaterThan(iHandler);
    expect(iFimLaco).toBeGreaterThan(iLaco);
    expect(iPo).toBeGreaterThan(iFimLaco);
    expect(iEstoque).toBeGreaterThan(iPo);
    // uma chamada só (a outra ocorrência é a definição) e nada correndo em paralelo com o laço do físico
    expect(fonte.match(/computePendenteViaPedidosCompra\(/g)).toHaveLength(2);
    expect(fonte.slice(iHandler)).not.toMatch(/Promise\.(all|allSettled|race|any)\(/);
  });

  it('erro de varredura do PO continua FATAL: nada entre o físico e a chamada o captura, nem .catch() nela', () => {
    const iFimLaco = fonte.indexOf('const faseFisicoMs', iHandler);
    const iPo = fonte.indexOf('await computePendenteViaPedidosCompra(', iHandler);
    expect(fonte.slice(iFimLaco, iPo)).not.toContain('try {');
    expect(fonte).toMatch(
      /const r = await computePendenteViaPedidosCompra\(appKey, appSecret, habilitadoMap, supabase, deadline\);/,
    );
  });

  it('nenhuma falha dentro do callback do registro vira resposta de sucesso', () => {
    // [Codex P2 2026-10-05] um try/catch em volta do callback devolvendo ok:true passava verde. Os únicos `ok: true`
    // do callback são o do caso vazio e o do resumo; `ok: false` só existe no catch final, FORA dele. Limite: um catch
    // que devolva o próprio resumo não acrescenta literal e escapa desta guarda.
    const iRegistro = fonte.indexOf('comRegistro(', iHandler);
    const iFimCallback = fonte.indexOf('}, detalhesDoRegistro)', iRegistro);
    expect(iFimCallback).toBeGreaterThan(iRegistro);
    const callback = fonte.slice(iRegistro, iFimCallback);
    expect(callback.match(/\bok: true\b/g)).toHaveLength(2);
    expect(callback).not.toMatch(/\bok: false\b/);
  });

  it('o erro do ListarPosEstoque ganha página e relógio como SUFIXO — o startsWith("AUTH_ERROR") segue vendo a auth', () => {
    expect(fonte).toMatch(/throw new Error\(\s*`\$\{mensagemDeErro\(err\) \?\? "falha sem mensagem"\} \(pág \$\{page\}/);
    expect(fonte).toContain('msg.startsWith("AUTH_ERROR")');
  });
});

describe('omie-sync-estoque — registro do run em acoes_execucoes', () => {
  it('abre o registro DEPOIS do client e ANTES do guard das credenciais e de qualquer chamada Omie', () => {
    const iClient = fonte.indexOf('createClient(', iHandler);
    const iRegistro = fonte.indexOf('comRegistro(', iHandler);
    const iCredenciais = fonte.indexOf('getOmieCredentials(empresa)', iHandler);
    const iPrimeiraOmie = fonte.indexOf('callOmie<', iHandler);
    expect(iClient).toBeGreaterThan(iHandler);
    expect(iRegistro).toBeGreaterThan(iClient);
    // guard fora do callback não deixa linha de falha (lição do analytics-outbox-drain, apagão de 2026-08-26)
    expect(iCredenciais).toBeGreaterThan(iRegistro);
    expect(iPrimeiraOmie).toBeGreaterThan(iRegistro);
  });

  it('as escritas do registro passam pelo adaptador COM PRAZO (Codex P1 2026-10-05)', () => {
    expect(fonte).toMatch(
      /const dbRegistro = registroComPrazo\(supabase as unknown as DbRegistro, PRAZO_REGISTRO_MS\);/,
    );
    expect(fonte).toContain('comRegistro(dbRegistro, ACAO_REGISTRO,');
  });

  it('slug próprio, escritor único: a edge (o botão da tela registra o composto, outra ação)', () => {
    expect(fonte).toContain('"reposicao.sync_estoque"');
    expect(fonte).not.toContain('"reposicao.sincronizar_recalcular"');
  });
});

describe('omie-sync-estoque — deadline cabe no teto do cron', () => {
  // Espelho do que vive em PROD, não no repo: cron.job 31 ('0 9 * * *') e 124 ('40 9,11,…,19 * * *') chamam a edge
  // com timeout_milliseconds := 90000 (medido em 2026-10-05). Mudou o teto lá? Mude aqui e o deadline junto.
  const TETO_CRON_MS = 90_000;

  it('o deadline deixa ≥10s de cauda dentro dos 90s do pg_net', () => {
    expect(constante('MAX_DURACAO_MS')).toBeLessThanOrEqual(TETO_CRON_MS - 10_000);
  });

  it('o corte ABSOLUTO da observação (deadline + folga) continua em 85s — 5s antes do teto', () => {
    expect(constante('MAX_DURACAO_MS') + constante('FOLGA_PUBLICACAO_MS')).toBe(TETO_CRON_MS - 5_000);
  });

  it('corte da observação + prazo do fechamento do registro deixam ≥3s para os marcadores e a resposta', () => {
    const fim = constante('MAX_DURACAO_MS') + constante('FOLGA_PUBLICACAO_MS') + constante('PRAZO_REGISTRO_MS');
    expect(fim).toBeLessThanOrEqual(TETO_CRON_MS - 3_000);
  });
});
