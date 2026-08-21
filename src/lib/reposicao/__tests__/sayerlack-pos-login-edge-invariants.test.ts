import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Gate de FORMA das duas edges Sayerlack (a 4ª perna do CI de edge —
// docs/historico/ci-testes-edge-deno.md): o vitest não RODA a edge, ele a LÊ.
//
// O que ele defende: `login_success via url_changed` prova só que a URL saiu de
// /login. Em 2026-08-20 o portal passou a exigir troca de senha, o falso positivo
// atravessou o login e a corrida morreu 3s depois no menu, como "Waiting failed:
// 3000ms exceeded" (erroTipo EXCEPTION) — e o `fornecedor_alerta` só disparava para
// LOGIN_FAILED, então ninguém soube da causa real enquanto o pedido 1939 falhava 3×.
//
// Sem este gate, remover a confirmação pós-login não quebra NADA: a lógica pura segue
// verde (ela existe), a suíte Deno não cobre o script do Browserless e o typecheck
// não sabe que a chamada é obrigatória. É a forma que protege a semântica.
const ROOT = process.cwd();
const ENVIO = resolve(ROOT, 'supabase/functions/enviar-pedido-portal-sayerlack/index.ts');
const CAPTURA = resolve(ROOT, 'supabase/functions/sayerlack-captura-precos/index.ts');
const ler = (p: string) => readFileSync(p, 'utf8');

describe('edges Sayerlack: a confirmação de dashboard pós-login não pode sumir', () => {
  for (const [nome, caminho] of [['envio', ENVIO], ['captura', CAPTURA]] as const) {
    it(`${nome}: interpola a classificação compartilhada no script do Browserless`, () => {
      const src = ler(caminho);
      expect(src).toContain('from "../_shared/sayerlack-pos-login.ts"');
      // Interpolação por .toString() — fonte única testada, não uma 2ª cópia da regra.
      expect(src).toContain('${classificarPosLogin.toString()}');
    });

    it(`${nome}: a página pós-login vira falha NOMEADA quando não é dashboard`, () => {
      const src = ler(caminho);
      expect(src).toContain('classificarPosLogin(sinaisPosLogin)');
      expect(src).toMatch(/posLogin\.tipo !== 'dashboard'/);
      // O erroTipo vem da classificação — nunca de um literal solto no meio do fluxo,
      // que voltaria a divergir entre as duas edges.
      expect(src).toContain('erroTipo: posLogin.erroTipo');
    });

    it(`${nome}: coleta os sinais no page.evaluate (o escopo do Browserless não chega ao DOM)`, () => {
      const src = ler(caminho);
      expect(src).toContain('input[type=password]');
      expect(src).toMatch(/menuLinks: menu\.length/);
      expect(src).toContain('sinaisPosLogin.origemEsperada = portalUrl');
    });
  }

  it('envio: troca de senha é erro PRÉ-SUBMIT — retentar com a mesma senha repete a tela', () => {
    const src = ler(ENVIO);
    expect(src).toMatch(/tipo === 'PASSWORD_CHANGE_REQUIRED'/);
  });

  it('envio: o alerta é decidido pela função pura, não por um `if` de erroTipo solto', () => {
    const src = ler(ENVIO);
    expect(src).toContain('decidirAlertaPortal(erroTipo, {');
    // A forma pré-fix: o insert do alerta gateado por um único erroTipo literal.
    // Se ela voltar, o próximo tipo de falha nasce mudo de novo.
    expect(src).not.toMatch(/if\s*\(\s*erroTipo === "LOGIN_FAILED"\s*\)/);
    // Alerta também no ramo de esgotamento — foi onde o incidente morreu calado.
    expect(src).toMatch(/alertarFornecedor\([\s\S]{0,300}?esgotado[,\s]/);
  });

  // Codex challenge 2026-08-20 (P1): o gate media `.menu-link` ANTES da expansão da sidebar,
  // que é a interação que materializa os links. Um dashboard legítimo viraria
  // POS_LOGIN_NAO_DASHBOARD e travaria pedido bom. A expansão TEM de vir antes de medir.
  for (const [nome, caminho] of [['envio', ENVIO], ['captura', CAPTURA]] as const) {
    it(`${nome}: expande a sidebar ANTES de medir o menu (ordem da interação)`, () => {
      const src = ler(caminho);
      const expansao = src.indexOf('app-sidebar-minify-btn');
      const espera = src.indexOf("budgetFor('pos-login-dashboard'");
      const classificacao = src.indexOf('classificarPosLogin(sinaisPosLogin)');
      expect(expansao).toBeGreaterThan(-1);
      expect(expansao).toBeLessThan(espera);
      expect(espera).toBeLessThan(classificacao);
      // E não sobrou um segundo par expandir+esperar gastando o mesmo deadline global.
      expect(src.split('app-sidebar-minify-btn').length - 1).toBe(1);
    });
  }

  it('envio: o lote para na primeira falha SISTÊMICA — não queima os 5 pedidos', () => {
    const src = ler(ENVIO);
    expect(src).toContain('ehFalhaSistemicaDoPortal(ultimo.erro_tipo)');
    // `break`, não `continue`: os pedidos restantes ficam PENDENTES e voltam sozinhos.
    expect(src).toMatch(/ehFalhaSistemicaDoPortal\(ultimo\.erro_tipo\)\)[\s\S]{0,400}?break;/);
  });

  it('envio: a evidência do pós-login chega ao envelope (sem isso não dá para medir em prod)', () => {
    const src = ler(ENVIO);
    expect(src).toContain('posLoginCheck: data.posLoginCheck || null');
  });

  it('calibração: o gate enxerga a forma pré-fix e não confunde com a pós-fix', () => {
    // Um detector que nunca prova o que barra empata "está limpo" com "está quebrado".
    const preFix = 'if (erroTipo === "LOGIN_FAILED") {\n  await supabase.from("fornecedor_alerta").insert({';
    const posFix = 'await alertarFornecedor(supabase, erroTipo, pedido.id, { esgotado: true });';
    expect(/if\s*\(\s*erroTipo === "LOGIN_FAILED"\s*\)/.test(preFix)).toBe(true);
    expect(/if\s*\(\s*erroTipo === "LOGIN_FAILED"\s*\)/.test(posFix)).toBe(false);
  });

  // O guard "não use comentário de bloco nestas edges" foi RETIRADO, não esquecido: ele
  // existia porque o stripper dos gates textuais era regex e o `/*` do `*/*` no header
  // `Accept` apagava o miolo do arquivo. Isso morreu com `@/lib/gates/limpeza-fonte`
  // (máquina de estados que entende string), adotado pelos 10 gates. Manter a proibição
  // seria dívida: uma regra de estilo sem a razão que a justificava — e o guard geral de
  // preservação agora mora no próprio limpeza-fonte, para TODOS os arquivos, não só estes.
});
