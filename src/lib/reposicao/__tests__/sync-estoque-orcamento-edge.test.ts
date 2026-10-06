import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Guarda textual do orçamento de tempo do omie-sync-estoque (incidente 2026-10-05 17:40Z, net._http_response
// 104687): a fase do PO rodava DEPOIS das 75 páginas do ListarPosEstoque, esbarrou no deadline, e o throw — fatal
// por desenho (Codex P1 2026-06-20) — descartou o físico já lido. O helper do paralelismo tem os testes Deno
// (fase-paralela_test.ts); aqui se vigia ONDE e COMO o handler o usa, sobre a fonte SEM comentários.
const fonte = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-estoque/index.ts'), 'utf8'),
);
const iHandler = fonte.indexOf('Deno.serve(');

function constante(nome: string): number {
  const m = fonte.match(new RegExp(`const ${nome} = ([\\d_]+);`));
  if (!m) throw new Error(`constante ${nome} não encontrada na edge`);
  return Number(m[1].replace(/_/g, ''));
}

describe('omie-sync-estoque — a fase do PO não fica na cauda do run', () => {
  it('o PO é DISPARADO antes do laço do ListarPosEstoque e só AGUARDADO depois dele', () => {
    const iDisparo = fonte.indexOf('dispararFase(', iHandler);
    const iLaco = fonte.indexOf('while (page <= totalPaginas)', iHandler);
    const iFimLaco = fonte.indexOf('const faseFisicoMs', iHandler);
    const iEspera = fonte.indexOf('await fasePo.resultado()', iHandler);
    expect(iHandler).toBeGreaterThan(0);
    expect(iDisparo).toBeGreaterThan(iHandler);
    expect(iLaco).toBeGreaterThan(iDisparo);
    expect(iFimLaco).toBeGreaterThan(iLaco);
    expect(iEspera).toBeGreaterThan(iFimLaco);
    // o que se dispara é a varredura do PO — e ela não volta a ser chamada em série em lugar nenhum
    expect(fonte.slice(iDisparo, fonte.indexOf(';', iDisparo))).toContain('computePendenteViaPedidosCompra(');
    expect(fonte).not.toMatch(/await\s+computePendenteViaPedidosCompra\(/);
  });

  it('erro de varredura do PO continua FATAL: aborta o físico cedo e é relançado, nunca engolido', () => {
    const iLaco = fonte.indexOf('while (page <= totalPaginas)', iHandler);
    const iAborto = fonte.indexOf('if (falhaPo) throw falhaPo.erro', iLaco);
    const iChamadaFisico = fonte.indexOf('callOmie<OmiePosEstoqueResponse>(', iLaco);
    expect(iAborto).toBeGreaterThan(iLaco);
    expect(iChamadaFisico).toBeGreaterThan(iAborto); // checa ANTES de pedir a próxima página
    const iFimLaco = fonte.indexOf('const faseFisicoMs', iHandler);
    const iEspera = fonte.indexOf('await fasePo.resultado()', iHandler);
    // sem try/catch em volta da espera e sem .catch() nela: a rejeição sobe até o catch do handler (marcador 'error')
    expect(fonte.slice(iFimLaco, iEspera)).not.toContain('try {');
    expect(fonte.slice(iEspera, iEspera + 60)).not.toContain('.catch(');
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
    const iDisparo = fonte.indexOf('dispararFase(', iHandler);
    const iPrimeiraOmie = fonte.indexOf('callOmie<', iHandler);
    expect(iClient).toBeGreaterThan(iHandler);
    expect(iRegistro).toBeGreaterThan(iClient);
    // guard fora do callback não deixa linha de falha (lição do analytics-outbox-drain, apagão de 2026-08-26)
    expect(iCredenciais).toBeGreaterThan(iRegistro);
    expect(iDisparo).toBeGreaterThan(iRegistro);
    expect(iPrimeiraOmie).toBeGreaterThan(iRegistro);
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
});
