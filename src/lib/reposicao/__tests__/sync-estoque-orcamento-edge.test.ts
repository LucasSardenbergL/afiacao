import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';

// Guarda textual do orçamento de tempo do omie-sync-estoque (incidente 2026-10-05 17:40Z, net._http_response
// 104687): o run morreu na fase do PO por deadline, e o throw — fatal por desenho (Codex P1 2026-06-20) — descartou
// o físico já lido. A v1.5 dá 5s a mais às varreduras e registra cada run. A fase do PO segue DEPOIS do físico: o
// paralelo foi revertido no adversarial do #2817, porque lido antes o PO conta duas vezes a NF recebida no meio do
// run. Desde a v1.6 a publicação mora em publicacao.ts, EXECUTADA pelos testes Deno com escritas falsas
// (publicacao_test.ts, fisico_test.ts, registro-com-prazo_test.ts); aqui se vigia ONDE e COMO o handler entrega as
// peças, sobre a fonte SEM comentários. Texto prova presença e ordem, não comportamento.
const fonte = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-estoque/index.ts'), 'utf8'),
);
const fontePublicacao = removerComentarios(
  readFileSync(resolve(__dirname, '../../../../supabase/functions/omie-sync-estoque/publicacao.ts'), 'utf8'),
);
const iHandler = fonte.indexOf('Deno.serve(');

function constante(nome: string): number {
  const m = fonte.match(new RegExp(`const ${nome} = ([\\d_]+);`));
  if (!m) throw new Error(`constante ${nome} não encontrada na edge`);
  return Number(m[1].replace(/_/g, ''));
}

describe('omie-sync-estoque — o par (físico, pendente) e a semântica fatal do PO', () => {
  it('a fase do PO roda DEPOIS do físico inteiro, e o handler não escreve no par: entrega tudo à publicação', () => {
    const iLaco = fonte.indexOf('while (page <= totalPaginas)', iHandler);
    const iFimLaco = fonte.indexOf('const faseFisicoMs', iHandler);
    const iPo = fonte.indexOf('await computePendenteViaPedidosCompra(', iHandler);
    const iConcluir = fonte.indexOf('concluirRun(opsDoBanco(', iHandler);
    expect(iHandler).toBeGreaterThan(0);
    expect(iLaco).toBeGreaterThan(iHandler);
    expect(iFimLaco).toBeGreaterThan(iLaco);
    expect(iPo).toBeGreaterThan(iFimLaco);
    expect(iConcluir).toBeGreaterThan(iPo);
    // uma chamada só (a outra ocorrência é a definição) e nada correndo em paralelo com o laço do físico
    expect(fonte.match(/computePendenteViaPedidosCompra\(/g)).toHaveLength(2);
    expect(fonte.slice(iHandler)).not.toMatch(/Promise\.(all|allSettled|race|any)\(/);
    expect(fontePublicacao).not.toMatch(/Promise\.(all|allSettled|race|any)\(/);
    // a única escrita no par é o adaptador entregue à publicação — que decide QUANDO ela acontece
    expect(fonte.slice(iHandler)).not.toContain('from("sku_estoque_atual")');
    expect(fonte.match(/from\("sku_estoque_atual"\)/g)).toHaveLength(1);
  });

  it('na publicação: gate do físico → fase do PO → gate do pendente → gravação, nessa ordem', () => {
    const iConcluir = fontePublicacao.indexOf('export async function concluirRun(');
    const passos = [
      'exigirFisicoPublicavel(v, e.fisico.faseMs);',
      'await ops.lerPendente();',
      'exigirPendenteConfiavel(pend, fasePoMs);',
      'await gravarEstoque(ops, e, linhas);',
      'await inativarNaoEncontrados(ops, e);',
      'await publicarObservacao(ops, e, pend, gravacaoCompleta);',
    ].map((p) => fontePublicacao.indexOf(p, iConcluir));
    expect(iConcluir).toBeGreaterThan(0);
    for (let i = 0; i < passos.length; i++) expect(passos[i]).toBeGreaterThan(i === 0 ? iConcluir : passos[i - 1]);
  });

  it('erro de varredura do PO continua FATAL: nada entre o físico e a chamada o captura, nem .catch() nela', () => {
    const iFimLaco = fonte.indexOf('const faseFisicoMs', iHandler);
    const iPo = fonte.indexOf('await computePendenteViaPedidosCompra(', iHandler);
    expect(fonte.slice(iFimLaco, iPo)).not.toContain('try {');
    expect(fonte).toMatch(
      /const r = await computePendenteViaPedidosCompra\(appKey, appSecret, habilitadoMap, supabase, deadline\);/,
    );
    // e na publicação: nenhum try aberto entre o início de concluirRun e a fase do PO, nenhum .catch() nela
    const iConcluir = fontePublicacao.indexOf('export async function concluirRun(');
    const iLer = fontePublicacao.indexOf('await ops.lerPendente()', iConcluir);
    expect(fontePublicacao.slice(iConcluir, iLer)).not.toContain('try {');
    expect(fontePublicacao).not.toMatch(/lerPendente\(\)\s*\.catch\(/);
  });

  it('nenhuma falha dentro do callback do registro vira resposta de sucesso', () => {
    // [Codex P2 2026-10-05] um try/catch em volta do callback devolvendo ok:true passava verde. O único `ok: true` do
    // callback é o do caso vazio; o resto é o resumo de concluirRun, cujo ok DERIVA do desfecho (os testes Deno provam
    // que parcial responde ok:false). `ok: false` só existe no catch final, FORA dele. Limite: um catch que devolva o
    // próprio resumo não acrescenta literal e escapa desta guarda.
    const iRegistro = fonte.indexOf('comRegistro(', iHandler);
    const iFimCallback = fonte.indexOf('}, detalhesDoRegistro)', iRegistro);
    expect(iFimCallback).toBeGreaterThan(iRegistro);
    const callback = fonte.slice(iRegistro, iFimCallback);
    expect(callback.match(/\bok: true\b/g)).toHaveLength(1);
    expect(callback).not.toMatch(/\bok: false\b/);
    expect(callback).toContain('return await concluirRun(');
    expect(fontePublicacao).not.toMatch(/\bok: (true|false)\b/);
    expect(fontePublicacao.match(/\bok: desfecho === "completo",/g)).toHaveLength(1);
  });

  it('a fiação não adultera o que decide: o veredito, a confiança do pendente e o marcador do catch', () => {
    // As decisões são testadas no Deno (publicacao_test.ts); o que o Deno não vê é o handler entregá-las intactas.
    const iFimLaco = fonte.indexOf('const faseFisicoMs', iHandler);
    const iVeredito = fonte.indexOf('const vereditoFisico = fisico.veredito();', iHandler);
    expect(iVeredito).toBeGreaterThan(iFimLaco);
    expect(fonte).toContain('fisico: { veredito: vereditoFisico, encontrados: fisico.encontrados,');
    expect(fonte).toContain(
      'return { pendente: r.pendente, confiavel: r.confiavel, problemas: r.problemas, observacao: r };',
    );
    const iCatchFinal = fonte.lastIndexOf('} catch (err) {');
    expect(iCatchFinal).toBeGreaterThan(iHandler);
    expect(fonte.slice(iCatchFinal)).toContain(
      'linhaMarcador(MARKER_FULL, empresaRef, "error", { trigger: "run" }, msg, Date.now())',
    );
  });

  it('a fiação dos membros de grupo: o MESMO recorte do motor, o predicado no acumulador e a entrega à publicação', () => {
    // PR-3 do estoque com dono único: a soma e a gravação dos membros são testadas no Deno (fisico_test/publicacao_test);
    // aqui, que o handler lê os membros com o recorte de gerar_pedidos_sugeridos_ciclo e os entrega sem desviar.
    const iMembros = fonte.indexOf('.from("sku_embalagem_equivalencia")', iHandler);
    expect(iMembros).toBeGreaterThan(iHandler);
    const leitura = fonte.slice(iMembros, fonte.indexOf(';', iMembros));
    expect(leitura).toContain('.eq("empresa", empresa.toLowerCase())');
    expect(leitura).toContain('.eq("ativo", true)');
    expect(leitura).toContain('.gt("fator_para_base", 0)');
    expect(fonte).toContain('.filter((sku) => !habilitadoMap.has(sku))');
    expect(fonte).toContain(
      'criarAcumuladorFisico((sku) => habilitadoMap.has(sku), totalEsperado, (sku) => membrosGrupo.has(sku))',
    );
    expect(fonte).toContain('membros: fisico.membros, membrosIlegiveis: fisico.membrosIlegiveis, membrosErro }');
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

  it('o corte ABSOLUTO da cauda (gravação, inativação, observação) continua em 85s — 5s antes do teto', () => {
    expect(constante('MAX_DURACAO_MS') + constante('FOLGA_CAUDA_MS')).toBe(TETO_CRON_MS - 5_000);
    expect(fonte).toContain('limiteCauda: deadline + FOLGA_CAUDA_MS,');
  });

  it('toda escrita/leitura dos adaptadores carrega o AbortSignal do prazo — senão o prazo da cauda é decorativo', () => {
    const ini = fonte.indexOf('function gravarMarcadorComPrazo(');
    const fim = fonte.indexOf('const CHAVES_REGISTRO');
    expect(ini).toBeGreaterThan(0);
    expect(fim).toBeGreaterThan(ini);
    const adaptadores = fonte.slice(ini, fim);
    const chamadas = adaptadores.match(/supabase\s*\.\s*(from|rpc)\(/g) ?? [];
    expect(chamadas).toHaveLength(7);
    expect(adaptadores.match(/\.abortSignal\(s\)/g)).toHaveLength(chamadas.length);
    // e a leitura do em_transito na fase do PO, que antes podia pendurar o run até o kill do cron
    const iEmTransito = fonte.indexOf('async function fetchEmTransitoKeys(');
    const fimEmTransito = fonte.indexOf('\n}\n', iEmTransito);
    expect(fonte.slice(iEmTransito, fimEmTransito)).toContain('.abortSignal(AbortSignal.timeout(prazo));');
    expect(fonte).toContain('await fetchEmTransitoKeys(supabase, deadline);');
  });

  it('cauda + os 2 marcadores + o fechamento do registro deixam ≥1s para a resposta', () => {
    const fim = constante('MAX_DURACAO_MS') + constante('FOLGA_CAUDA_MS') + 2 * constante('PRAZO_MARCADOR_MS') +
      constante('PRAZO_REGISTRO_MS');
    expect(fim).toBeLessThanOrEqual(TETO_CRON_MS - 1_000);
    // os marcadores usam o prazo FIXO (rodam depois do corte da cauda), nunca o limite da cauda
    expect(fonte).toContain('marcadorMs: PRAZO_MARCADOR_MS,');
  });
});
