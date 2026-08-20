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

  // 1. Sinal positivo de área logada. Vence tudo: com o menu presente a
  //    navegação funciona, e um item "Alterar senha" no dropdown do usuário
  //    não pode ser lido como tela de troca de senha.
  if (s.menuLinks > 0) {
    return {
      tipo: 'dashboard',
      erroTipo: null,
      motivo: 'Dashboard confirmado (' + s.menuLinks + ' itens de menu) em ' + s.url,
      origemDivergente: origemDivergente,
    };
  }

  // 2. Sinal positivo de troca de senha obrigatória.
  const TERMOS = [
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
    'senha expirou',
    'senha expirada',
    'senha esta expirada',
    'senha provisoria',
    'senha temporaria',
    'primeiro acesso',
    'change password',
    'change your password',
    'new password',
    'password expired',
    'password has expired',
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

  let termoAchado: string | null = null;
  for (let i = 0; i < TERMOS.length; i++) {
    if (alvoTexto.indexOf(TERMOS[i]) !== -1) {
      termoAchado = TERMOS[i];
      break;
    }
  }
  if (termoAchado === null) {
    for (let j = 0; j < FRAGMENTOS_URL.length; j++) {
      if (alvoUrl.indexOf(FRAGMENTOS_URL[j]) !== -1) {
        termoAchado = FRAGMENTOS_URL[j];
        break;
      }
    }
  }

  // Dois campos de senha pós-login = "nova senha" + "confirmação". UM campo
  // isolado NÃO basta (pode ser a própria tela de login re-renderizada).
  const formularioDeTroca = s.camposSenha >= 2;

  if (termoAchado !== null || formularioDeTroca) {
    const porQue = termoAchado !== null
      ? 'sinal "' + termoAchado + '"'
      : s.camposSenha + ' campos de senha';
    return {
      tipo: 'troca_de_senha',
      erroTipo: 'PASSWORD_CHANGE_REQUIRED',
      motivo:
        'O portal exige troca de senha antes de liberar o dashboard (' + porQue + '), em ' + s.url +
        '. O automador nao troca senha: precisa de acao humana.',
      origemDivergente: origemDivergente,
    };
  }

  // 3. Nem dashboard nem troca de senha: relata o que foi OBSERVADO, sem inventar causa.
  const extra = origemDivergente
    ? ' A URL saiu da origem configurada do portal (' + String(s.origemEsperada) + ').'
    : '';
  return {
    tipo: 'desconhecido',
    erroTipo: 'POS_LOGIN_NAO_DASHBOARD',
    motivo:
      'Login aceito, mas a pagina pos-login nao e o dashboard (nenhum item de menu) em ' +
      s.url + '.' + extra,
    origemDivergente: origemDivergente,
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
      titulo: 'Senha do portal Sayerlack expirou',
      mensagem:
        'Login falhou no portal ' + portal + '. Provavel expiracao de senha. ' + ACAO_SENHA,
      severidade: 'urgente',
    };
  }

  if (erroTipo === 'POS_LOGIN_NAO_DASHBOARD') {
    if (!ctx.esgotado) return null;
    return {
      titulo: 'Portal Sayerlack nao abre o dashboard apos o login',
      mensagem:
        'O login em ' + portal + ' foi aceito, mas a pagina seguinte nao tem o menu da area ' +
        'logada — as retentativas se esgotaram sem enviar o pedido. Causa NAO identificada pelo ' +
        'automador (pode ser mudanca de layout/endereco do portal, bloqueio da conta ou queda). ' +
        'ACAO: abrir ' + portal + '/login no navegador e conferir o que o portal mostra apos entrar.',
      severidade: 'urgente',
    };
  }

  return null;
}
