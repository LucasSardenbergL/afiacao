import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { removerComentarios, maiorBlocoDescartado } from '@/lib/gates/limpeza-fonte';

/**
 * Sentinela do Session Replay — prova que a gravação de tela continua DESLIGADA.
 *
 * Por que existe: até 2026-08-25 o `posthog.init()` trazia
 * `session_recording: { maskAllInputs: true }`, e o comentário ao lado dizia
 * "mascarar inputs por padrão pra privacidade". A descrição estava errada num
 * sentido caro — `maskAllInputs` mascara CAMPO DE FORMULÁRIO, não o texto
 * RENDERIZADO; a máscara de texto é `maskTextSelector`, e ela nunca esteve no
 * config. O replay gravava razão social, CNPJ, preço e saldo como aparecem na
 * tela. Nada no CI olhava para isso: `grep -rn session_recording src scripts`
 * devolvia UMA linha, o próprio config. Decisão sem gate reincide, então aqui
 * está o gate.
 *
 * ⚠️ Este gate lê a FONTE como texto e por isso limpa comentário com o stripper
 * COMPARTILHADO (`removerComentarios`), nunca com regex local. Não é zelo
 * abstrato: o comentário que documenta o desligamento MENCIONA
 * `session_recording` e `maskTextSelector` de propósito — um gate ingênuo
 * casaria com a própria explicação e passaria (ou reprovaria) por cegueira,
 * medindo o comentário em vez do código.
 */

const CAMINHO = 'src/lib/analytics.ts';
const RAIZ = resolve(__dirname, '../../..');

function fonteSemComentarios(): string {
  return removerComentarios(readFileSync(resolve(RAIZ, CAMINHO), 'utf8'));
}

describe('analytics: Session Replay fica desligado', () => {
  it('o init declara disable_session_recording: true', () => {
    expect(fonteSemComentarios()).toMatch(/disable_session_recording\s*:\s*true/);
  });

  it('não existe bloco session_recording ligando a gravação', () => {
    // Casa a CHAVE de config, não a palavra solta — `disable_session_recording`
    // contém `session_recording` como substring e daria falso positivo.
    expect(fonteSemComentarios()).not.toMatch(/(^|[^_\w])session_recording\s*:/);
  });

  it('religar exige maskTextSelector junto — maskAllInputs sozinho não basta', () => {
    const fonte = fonteSemComentarios();
    if (/(^|[^_\w])session_recording\s*:/.test(fonte)) {
      // Se um dia o replay voltar, ele volta com máscara de TEXTO, não só de input.
      expect(fonte).toMatch(/maskTextSelector/);
    }
  });

  it('o stripper preservou o código — o gate não mediu um arquivo esvaziado', () => {
    // Sentinela do maior bloco contíguo descartado: se um `/*` dentro de string
    // fizesse o stripper comer o miolo do arquivo, as asserções acima ficariam
    // verdes por CEGUEIRA. O comentário-cabeçalho do `disable_session_recording`
    // é o maior bloco legítimo aqui; qualquer descarte muito acima disso é sinal
    // de que o stripper pareou errado.
    const bruto = readFileSync(resolve(RAIZ, CAMINHO), 'utf8');
    expect(maiorBlocoDescartado(bruto)).toBeLessThan(1600);
    expect(fonteSemComentarios()).toContain('posthog.init(');
  });
});
