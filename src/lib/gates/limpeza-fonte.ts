// Limpeza de FONTE para gates textuais — a que entende string, template e regex literal.
//
// Por que existe (classe medida em 2026-08-20, docs/historico/sayerlack-pos-login-falso-positivo.md):
// todo gate textual deste repo limpava comentário com
//   `s.replace(/\/\*[\s\S]*?\*\//g, '')`
// antes de medir. É regex: não sabe o que é string. Qualquer `/*` que apareça DENTRO de uma
// string pareia com o próximo `*/` REAL do arquivo e apaga tudo entre os dois, ANTES de o fiscal
// olhar. O gate fica verde por CEGUEIRA — indistinguível de verde por mérito, que é a assinatura
// de falha mais cara que existe num fiscal (§"Validação só conta com EVIDÊNCIA POSITIVA").
//
// O caso que revelou: o header HTTP `'Accept': '...image/webp,*/*;q=0.8'` das edges Sayerlack
// carrega `/*` no `*/*` do mimetype coringa. Em `sayerlack-captura-precos/index.ts`, 1.041 das
// 1.226 linhas (85%) eram invisíveis aos gates — escondendo 2 sítios reais da classe #1642, que
// só apareceram quando o par foi desfeito à mão.
//
// CONTRATO desta função: remove comentário de LINHA e de BLOCO, e NADA MAIS. String simples,
// dupla, template literal (inclusive o interior de `${…}`) e regex literal saem intactos.
//
// LIMITE CONHECIDO (deliberado, e é o que torna a falha BARATA em vez de catastrófica): sem
// parser de verdade, texto JSX solto (`<p>Don't</p>`) e divisão ambígua podem ser lidos como
// abertura de string/regex. Por isso string de aspas e regex literal ABORTAM na quebra de linha
// — como manda a própria gramática do JS — e o estrago máximo de uma leitura errada é o RESTO
// DA LINHA, nunca 1.041 delas. `medirPreservacao` é o alarme de fumaça para o resto.

// Um `/` só abre regex depois destes caracteres — senão é divisão.
const ANTES_DE_REGEX = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n',
]);

// Palavras-chave depois das quais um `/` abre regex (`return /re/.test(x)`).
const PALAVRAS_ANTES_DE_REGEX =
  /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

function abreRegex(anterior: string): boolean {
  const t = anterior.replace(/\s+$/, '');
  if (t === '') return true;
  const c = t[t.length - 1];
  if (ANTES_DE_REGEX.has(c)) return true;
  return PALAVRAS_ANTES_DE_REGEX.test(t);
}

// Remove comentários de `fonte` preservando as quebras de linha do que saiu — o número de linhas
// do resultado é igual ao da entrada, de propósito: gate que casa com `^…` multiline e gate que
// compara POSIÇÃO (`indexOf` de A antes de B) continuam medindo a mesma coisa.
//
export function removerComentarios(fonte: string): string {
  const partes: string[] = [];
  // CAUDA em vez do texto todo: `abreRegex` precisa do último caractere significativo, e olhar a
  // saída acumulada a cada `/` fazia o stripper ser O(n²) — 27× mais lento que a regex que ele
  // substitui, o bastante para estourar o timeout de 20s do vitest em gate que varre 2.390 fontes.
  let cauda = '\n';
  const empurrar = (t: string) => {
    if (t === '') return;
    partes.push(t);
    cauda = (cauda + t).slice(-16);
  };

  let i = 0;
  let inicioTrecho = 0;
  const n = fonte.length;
  const preservaLinhas = (trecho: string) => trecho.replace(/[^\n]/g, '');

  while (i < n) {
    const c = fonte[i];
    if (c !== '/' && c !== '"' && c !== "'" && c !== '`') {
      i++;
      continue;
    }
    empurrar(fonte.slice(inicioTrecho, i));

    const prox = fonte[i + 1];

    if (c === '/' && prox === '/') {
      while (i < n && fonte[i] !== '\n') i++;
      inicioTrecho = i;
      continue;
    }

    if (c === '/' && prox === '*') {
      const fim = fonte.indexOf('*/', i + 2);
      const ate = fim === -1 ? n : fim + 2;
      empurrar(preservaLinhas(fonte.slice(i, ate)));
      i = ate;
      inicioTrecho = i;
      continue;
    }

    if (c === '"' || c === "'") {
      const fecha = fimDeString(fonte, i);
      if (fecha !== -1) {
        empurrar(fonte.slice(i, fecha + 1));
        i = fecha + 1;
        inicioTrecho = i;
        continue;
      }
      // Não fechou na mesma linha: não era string (texto JSX, apóstrofo de prosa). Segue como
      // código — o caractere sai verbatim e o resto da linha é reavaliado normalmente.
      empurrar(c);
      i++;
      inicioTrecho = i;
      continue;
    }

    if (c === '`') {
      const fecha = fimDeTemplate(fonte, i);
      const ate = fecha === -1 ? n : fecha + 1;
      empurrar(fonte.slice(i, ate));
      i = ate;
      inicioTrecho = i;
      continue;
    }

    if (abreRegex(cauda)) {
      const fecha = fimDeRegex(fonte, i);
      if (fecha !== -1) {
        empurrar(fonte.slice(i, fecha + 1));
        i = fecha + 1;
        inicioTrecho = i;
        continue;
      }
    }

    empurrar(c);
    i++;
    inicioTrecho = i;
  }

  empurrar(fonte.slice(inicioTrecho, n));
  return partes.join('');
}

// Índice da aspa de fechamento, ou -1 se a linha acabar antes (⇒ não era string).
function fimDeString(s: string, ini: number): number {
  const aspas = s[ini];
  let i = ini + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') return -1;
    if (c === aspas) return i;
    i++;
  }
  return -1;
}

// Índice da crase de fechamento, respeitando `${…}` aninhado (que pode conter outra crase).
function fimDeTemplate(s: string, ini: number): number {
  let i = ini + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i;
    if (c === '$' && s[i + 1] === '{') {
      let prof = 1;
      i += 2;
      while (i < s.length && prof > 0) {
        const d = s[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '`') { const f = fimDeTemplate(s, i); i = f === -1 ? s.length : f + 1; continue; }
        if (d === "'" || d === '"') { const f = fimDeString(s, i); i = f === -1 ? i + 1 : f + 1; continue; }
        if (d === '{') prof++;
        if (d === '}') prof--;
        i++;
      }
      continue;
    }
    i++;
  }
  return -1;
}

// Índice da `/` de fechamento do regex literal (classe `[…]` protege a barra), ou -1.
function fimDeRegex(s: string, ini: number): number {
  let i = ini + 1;
  let classe = false;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '\n') return -1;
    if (classe) {
      if (c === ']') classe = false;
    } else if (c === '[') {
      classe = true;
    } else if (c === '/') {
      return i;
    }
    i++;
  }
  return -1;
}

// Alarme de fumaça do stripper: quanto do arquivo SOBROU depois da limpeza.
//
// Os gates já provam que o walker anda (quantos ARQUIVOS leu). Isto é o denominador que faltava
// no outro eixo: quanto de CADA arquivo o fiscal chegou a olhar. Um stripper que engole a
// metade do arquivo por má-leitura devolve fração baixa aqui muito antes de alguém notar que
// um gate virou decoração.
//
// Conta LINHAS NÃO-VAZIAS: linha de comentário some por desenho, então a fração nunca é 1 —
// o que se vigia é o desabamento (o caso Sayerlack devolvia 0,15).
//
export function medirPreservacao(fonte: string): {
  linhasOriginais: number;
  linhasPreservadas: number;
  fracao: number;
} {
  const naoVazias = (s: string) => s.split('\n').filter((l) => l.trim() !== '').length;
  const linhasOriginais = naoVazias(fonte);
  const linhasPreservadas = naoVazias(removerComentarios(fonte));
  return {
    linhasOriginais,
    linhasPreservadas,
    fracao: linhasOriginais === 0 ? 1 : linhasPreservadas / linhasOriginais,
  };
}

// Alarme CALIBRADO do stripper: o maior BLOCO CONTÍGUO de linhas que a limpeza descartou.
//
// A fração acima é grossa demais para o caso real: `sayerlack-captura-precos/index.ts` envenenado
// preservava 0,118 do arquivo, e há `versao.ts` legítimo em 0,154 — não dá para separar os dois
// por fração. O que separa é a FORMA do estrago: comentário de verdade vem em cabeçalho, e o
// maior cabeçalho honesto do repo tem 88 linhas (`useFarmerScoring.ts`, medido em 2026-08-20 nos
// 2.390 fontes de `src/`+`supabase/functions/`+`scripts/`); a região comida pelo par falso tinha
// 924. Um teto de 150 fica 1,7× acima do maior legítimo e 6× abaixo do estrago medido.
//
// Linha em branco no ORIGINAL é neutra (não interrompe o bloco): a região envenenada tinha linhas
// vazias no meio, e contá-las como fronteira quebrava o bloco em pedaços de <88 — o alarme
// silenciava exatamente no caso que ele existe para pegar.
export function maiorBlocoDescartado(fonte: string): number {
  const antes = fonte.split('\n');
  const depois = removerComentarios(fonte).split('\n');
  let maior = 0;
  let atual = 0;
  for (let i = 0; i < antes.length; i++) {
    if (antes[i].trim() === '') continue;
    atual = (depois[i] ?? '').trim() === '' ? atual + 1 : 0;
    if (atual > maior) maior = atual;
  }
  return maior;
}
