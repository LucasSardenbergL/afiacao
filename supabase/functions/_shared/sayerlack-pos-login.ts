// Confirmação POSITIVA de dashboard após o login no portal Sayerlack (money-path).
//
// Motivo: `login_success via url_changed` prova apenas que a URL saiu de `/login` —
// NÃO que a área logada apareceu. No incidente 2026-08-20 (pedido 1939, 3 falhas)
// o portal redirecionou para fora do dashboard, o `url_changed` deu FALSO POSITIVO
// e o fluxo só morreu 3s depois esperando o link do menu ("Waiting failed:
// 3000ms exceeded" → erroTipo EXCEPTION). Como o `fornecedor_alerta` só era
// inserido para LOGIN_FAILED, a causa real não chegou a ninguém.
//
// ⚠️ ESPELHADO VERBATIM em supabase/functions/_shared/sayerlack-pos-login.ts
// (Deno não importa de src/). Paridade byte-a-byte garantida por
// __tests__/sayerlack-pos-login.parity.test.ts — edite os DOIS juntos.
//
// ⚠️ `classificarPosLogin` é INTERPOLADA no script do Browserless via
// `${classificarPosLogin.toString()}`: precisa ser SELF-CONTAINED (não pode
// referenciar nada do escopo do módulo) e o corpo não pode conter crase nem `${`.
// A COLETA dos sinais fica no `page.evaluate` de cada edge (DOM burro), porque
// `page.evaluate` roda no contexto da página e não enxerga este escopo.

/** Sinais brutos colhidos da página imediatamente após o submit do login. */
export interface SinaisPosLogin {
  /** `page.url()` no momento da coleta. */
  url: string;
  /** Origem do portal configurado (`SAYERLACK_PORTAL_URL`), ou null se ilegível. */
  origemEsperada: string | null;
  /** Quantos `.menu-link` a sidebar da área logada expôs. */
  menuLinks: number;
  /** Quantos `input[type=password]` visíveis a página tem. */
  camposSenha: number;
  /** `document.title`. */
  titulo: string;
  /** `body.innerText` truncado. */
  texto: string;
}

export type TipoPosLogin = 'dashboard' | 'troca_de_senha' | 'desconhecido';

export interface ResultadoPosLogin {
  tipo: TipoPosLogin;
  /** erroTipo do envelope; `null` quando é dashboard (sem erro). */
  erroTipo: string | null;
  /** Frase pronta para o campo `erro` e para a evidência. */
  motivo: string;
  /** A URL pós-login saiu da origem do portal configurado (fato objetivo). */
  origemDivergente: boolean;
  /** Havia menu E sinal forte de troca de senha ao mesmo tempo (menu stale/SPA). */
  conflitoDeSinais: boolean;
}

/**
 * Classifica a página pós-login. Precisão > recall:
 *  - só chama `dashboard` com sinal POSITIVO (menu da área logada presente);
 *  - só chama `troca_de_senha` com sinal POSITIVO (texto/URL explícitos ou os
 *    DOIS campos de senha de um formulário de troca);
 *  - o resto é `desconhecido` — ausente ≠ senha expirada. O diagnóstico
 *    inventado é o que faz o founder trocar a senha à toa.
 *
 * SELF-CONTAINED de propósito (ver cabeçalho): é interpolada no Browserless.
 */
export function classificarPosLogin(s: SinaisPosLogin): ResultadoPosLogin {
  const normalizar = function (v: string): string {
    return String(v || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  };

  const origemDe = function (v: string | null): string | null {
    const raw = String(v || '').trim();
    if (!raw) return null;
    const m = raw.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i);
    return m ? m[0].toLowerCase() : null;
  };

  const origemAtual = origemDe(s.url);
  const origemAlvo = origemDe(s.origemEsperada);
  const origemDivergente = origemAtual !== null && origemAlvo !== null && origemAtual !== origemAlvo;

  // FORTE: afirma EXPIRAÇÃO/OBRIGATORIEDADE. Só aparece numa tela que realmente barra o
  // acesso — vale sozinho, e vale até contra a presença de menu.
  const TERMOS_FORTES = [
    'senha expirou',
    'senha expirada',
    'senha esta expirada',
    'sua senha expir',
    'senha provisoria',
    'senha temporaria',
    'troca de senha obrigatoria',
    'troque sua senha',
    'password expired',
    'password has expired',
    'must change your password',
    'must be changed',
  ];
  // FRACO: nomeia a AÇÃO, não a obrigação. "Alterar senha" é item normal do dropdown de
  // usuário em dashboard saudável (Codex challenge P1: com drift do seletor .menu-link,
  // sozinho ele travaria pedido bom como não-retentável e mandaria trocar a senha à toa).
  // Só conta CORROBORADO por pelo menos um campo de senha na tela.
  const TERMOS_FRACOS = [
    'trocar senha',
    'troca de senha',
    'trocar a senha',
    'alterar senha',
    'alterar a senha',
    'alteracao de senha',
    'alteracao da senha',
    'nova senha',
    'redefinir senha',
    'redefinir a senha',
    'atualizar senha',
    'atualizar a senha',
    'renove suas credenciais',
    'primeiro acesso',
    'change password',
    'change your password',
    'new password',
    'reset password',
    'update your password',
  ];
  const FRAGMENTOS_URL = [
    'trocar-senha',
    'troca-senha',
    'trocarsenha',
    'alterar-senha',
    'alterarsenha',
    'nova-senha',
    'novasenha',
    'senha-expirada',
    'redefinir-senha',
    'change-password',
    'changepassword',
    'new-password',
    'newpassword',
    'reset-password',
    'resetpassword',
    'password-expired',
    'passwordexpired',
    'primeiro-acesso',
    'primeiroacesso',
    'first-access',
    'firstaccess',
  ];

  const alvoTexto = normalizar(s.titulo) + ' ' + normalizar(s.texto);
  const alvoUrl = normalizar(s.url);
  const achar = function (lista: string[], alvo: string): string | null {
    for (let i = 0; i < lista.length; i++) {
      if (alvo.indexOf(lista[i]) !== -1) return lista[i];
    }
    return null;
  };

  const forte = achar(TERMOS_FORTES, alvoTexto);
  const fraco = achar(TERMOS_FRACOS, alvoTexto);
  const naUrl = achar(FRAGMENTOS_URL, alvoUrl);
  // DOIS campos de senha pós-login = "nova senha" + "confirmação": formulário de troca,
  // sinal forte por si. UM campo apenas CORROBORA um termo fraco (portal que pede a senha
  // atual numa etapa), nunca decide sozinho — a tela de login re-renderizada também tem um.
  const formularioDeTroca = s.camposSenha >= 2;

  const sinalForte = forte !== null || naUrl !== null || formularioDeTroca;
  const sinalCorroborado = fraco !== null && s.camposSenha >= 1;

  // Sinal FORTE vence o menu: nós de sidebar sobrevivem a redirect de SPA e a menu stale,
  // e deixar o menu ganhar cegamente esconderia uma troca de senha REAL — que é o bug
  // original voltando por outra porta (Codex challenge P1).
  const conflitoDeSinais = s.menuLinks > 0 && sinalForte;

  if (sinalForte || sinalCorroborado) {
    const porQue = forte !== null
      ? 'sinal "' + forte + '"'
      : naUrl !== null
        ? 'URL com "' + naUrl + '"'
        : formularioDeTroca
          ? s.camposSenha + ' campos de senha'
          : 'sinal "' + String(fraco) + '" com ' + s.camposSenha + ' campo(s) de senha';
    const nota = conflitoDeSinais
      ? ' Havia itens de menu na pagina ao mesmo tempo (menu stale ou SPA): o sinal de senha prevaleceu.'
      : '';
    return {
      tipo: 'troca_de_senha',
      erroTipo: 'PASSWORD_CHANGE_REQUIRED',
      motivo:
        'O portal exige troca de senha antes de liberar o dashboard (' + porQue + '), em ' + s.url +
        '. O automador nao troca senha: precisa de acao humana.' + nota,
      origemDivergente: origemDivergente,
      conflitoDeSinais: conflitoDeSinais,
    };
  }

  // Sinal POSITIVO de area logada, agora que nenhum sinal de senha o contesta.
  if (s.menuLinks > 0) {
    return {
      tipo: 'dashboard',
      erroTipo: null,
      motivo: 'Dashboard confirmado (' + s.menuLinks + ' itens de menu) em ' + s.url,
      origemDivergente: origemDivergente,
      conflitoDeSinais: false,
    };
  }

  // Nem dashboard nem troca de senha: relata o que foi OBSERVADO, sem inventar causa.
  const extra = origemDivergente
    ? ' A URL saiu da origem configurada do portal (' + String(s.origemEsperada) + ').'
    : '';
  const pista = fraco !== null
    ? ' Havia o texto "' + fraco + '" na pagina, mas sem campo de senha que o corrobore.'
    : '';
  return {
    tipo: 'desconhecido',
    erroTipo: 'POS_LOGIN_NAO_DASHBOARD',
    motivo:
      'Login aceito, mas a pagina pos-login nao e o dashboard (nenhum item de menu) em ' +
      s.url + '.' + extra + pista,
    origemDivergente: origemDivergente,
    conflitoDeSinais: false,
  };
}

export interface AlertaPortal {
  titulo: string;
  mensagem: string;
  severidade: 'urgente' | 'atencao';
}

export interface ContextoAlerta {
  /** As retentativas acabaram (MAX_TENTATIVAS atingido). */
  esgotado: boolean;
  /** `SAYERLACK_PORTAL_URL` — o founder precisa saber ONDE agir. */
  portalUrl: string | null | undefined;
  /** A URL pós-login saiu da origem configurada — fato objetivo, alerta na hora. */
  origemDivergente?: boolean;
}

const ACAO_SENHA =
  'ACAO: 1) Trocar senha no portal Sayerlack, 2) Atualizar SAYERLACK_PORTAL_PASS no Supabase ' +
  'Edge Functions Secrets, 3) Em /admin/reposicao/pedidos, clicar em "Forcar reenvio ao portal" ' +
  'no pedido afetado.';

/**
 * Decide se um `erroTipo` do automador merece `fornecedor_alerta` — e com que texto.
 *
 * O bug de 2026-08-20 foi ausência de alerta: só `LOGIN_FAILED` inseria, e a falha
 * real chegou como `EXCEPTION`. Aqui a decisão é explícita e testável:
 *  - falha de credencial/senha alerta na PRIMEIRA vez (retentar não resolve);
 *  - causa desconhecida alerta só ao ESGOTAR as retentativas (pode ser transitória,
 *    e alertar a cada tentativa vira ruído que dessensibiliza o alerta);
 *  - erroTipo sem alerta definido devolve `null` — não se inventa aviso.
 */
export function decidirAlertaPortal(
  erroTipo: string | null | undefined,
  ctx: ContextoAlerta,
): AlertaPortal | null {
  const portal = ctx.portalUrl ? String(ctx.portalUrl) : '(URL do portal nao configurada)';
  const tipo = erroTipo ? String(erroTipo) : 'sem erroTipo';

  // Falha de credencial/senha: retentar não resolve, avisa na primeira.
  if (erroTipo === 'PASSWORD_CHANGE_REQUIRED') {
    return {
      titulo: 'Portal Sayerlack exige troca de senha',
      mensagem:
        'O login em ' + portal + ' foi aceito, mas o portal abriu a tela de TROCA DE SENHA em vez ' +
        'do dashboard — o pedido nao foi enviado. ' + ACAO_SENHA,
      severidade: 'urgente',
    };
  }

  if (erroTipo === 'LOGIN_FAILED') {
    return {
      titulo: 'Login do portal Sayerlack falhou',
      mensagem:
        'Login recusado em ' + portal + '. A causa mais comum e expiracao de senha, mas conta ' +
        'bloqueada, bloqueio por WAF ou mudanca no formulario dao o MESMO sintoma — confira antes ' +
        'de trocar a senha. ' + ACAO_SENHA,
      severidade: 'urgente',
    };
  }

  // Mudança de ORIGEM é fato objetivo e forte: 40+ logins bem-sucedidos vinham da origem
  // configurada. Não espera esgotar — retentar não muda para onde o portal redireciona.
  if (ctx.origemDivergente === true) {
    return {
      titulo: 'Portal Sayerlack redirecionou para outro endereço',
      mensagem:
        'O login em ' + portal + ' foi aceito, mas o portal levou a outro endereço (origem ' +
        'diferente da configurada) e a pagina seguinte nao tem o menu da area logada — o pedido ' +
        'nao foi enviado (' + tipo + '). ACAO: abrir ' + portal + '/login no navegador e ver para ' +
        'onde o portal leva. Se o endereco mudou de vez, o SAYERLACK_PORTAL_URL precisa ser revisto.',
      severidade: 'urgente',
    };
  }

  // Antes de esgotar, causa não-identificada segue calada: a retentativa é o caminho normal
  // e alertar a cada tentativa dessensibiliza o alerta que existe para o caso raro.
  if (!ctx.esgotado) return null;

  // ESGOTOU. Daqui em diante SEMPRE alerta — inclusive erroTipo desconhecido ou ausente.
  // Esta é a lição do incidente na forma de CLASSE: o alerta antigo era gateado por um
  // erroTipo específico e a falha real chegou com outro rótulo (EXCEPTION), então o pedido
  // parou calado. O rótulo agora só escolhe o TEXTO — nunca decide se o founder é avisado.
  if (erroTipo === 'POS_LOGIN_NAO_DASHBOARD') {
    return {
      titulo: 'Portal Sayerlack nao abre o dashboard apos o login',
      mensagem:
        'O login em ' + portal + ' foi aceito, mas a pagina seguinte nao tem o menu da area ' +
        'logada — as retentativas se esgotaram sem enviar o pedido. Causa NAO identificada pelo ' +
        'automador (pode ser mudanca de layout do portal, bloqueio da conta ou queda). ' +
        'ACAO: abrir ' + portal + '/login no navegador e conferir o que o portal mostra apos entrar.',
      severidade: 'urgente',
    };
  }

  return {
    titulo: 'Pedido ao portal Sayerlack parou apos esgotar as tentativas',
    mensagem:
      'O automador tentou ate o limite e nao enviou o pedido em ' + portal + '. Ultimo erro: ' +
      tipo + '. Nenhum pedido foi colocado no fornecedor (o clique de finalizacao nunca ocorreu). ' +
      'ACAO: abrir a tentativa em /admin/reposicao/pedidos e ver o trace/screenshot para saber o ' +
      'que o portal mostrou.',
    severidade: 'urgente',
  };
}

/**
 * Falha SISTÊMICA do portal — a que vale igual para todos os pedidos do lote.
 *
 * Codex challenge 2026-08-20: sem isto, um portal pedindo troca de senha faz o lote
 * gastar os 5 pedidos batendo na mesma parede. Antes deste PR o custo era baixo (viravam
 * `erro_retentavel` e voltavam para a fila); com `PASSWORD_CHANGE_REQUIRED` marcado como
 * pré-submit, os 5 virariam NÃO-retentáveis de uma vez — 5 pedidos travados e 5 alertas
 * urgentes iguais, por uma causa só. Depois do primeiro, o resto fica pendente e é
 * retentado quando a senha for corrigida.
 *
 * Só entram tipos que provam falha de CREDENCIAL/ACESSO: um `SKU_NOT_FOUND` é do pedido,
 * não do portal, e interromper o lote por ele suprimiria compra boa.
 */
export function ehFalhaSistemicaDoPortal(erroTipo: string | null | undefined): boolean {
  return erroTipo === 'PASSWORD_CHANGE_REQUIRED' || erroTipo === 'LOGIN_FAILED';
}
