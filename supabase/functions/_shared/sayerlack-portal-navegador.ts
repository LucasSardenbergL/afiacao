// Trecho do script do NAVEGADOR (Browserless) comum às edges que LEEM o portal Sayerlack:
// `sayerlack-importar-pedido-portal` e `sayerlack-varrer-pedidos-portal`. Do login até a Consulta Pedidos pronta para
// filtrar (jQuery + DataTables ligados). Interpolado como TEXTO dentro do template `BROWSERLESS_FUNCTION` de cada uma.
//
// Contrato com quem interpola (variáveis do escopo do script): page, context (user, pass, portalUrl), trace, t0,
// budgetFor, sleep, falha, fillInput, classificarPosLogin. Só LEITURA: nenhum clique de gravação; o único clique é
// "Entrar" e o do menu. Sem crase e sem cifrão-chave aqui dentro (é texto de template).
// Extraído na revisão Fable+Codex (2026-11): as duas edges tinham ~60 linhas idênticas.

export const ABRIR_CONSULTA_PEDIDOS = `
    trace.push({ step: 'login_start', t: Date.now() - t0 });
    await page.goto(portalUrl + '/login', { waitUntil: 'domcontentloaded', timeout: budgetFor('login-goto', 30000) });
    await page.waitForSelector('#user', { timeout: budgetFor('login-form', 10000) });
    await fillInput('#user', user);
    await fillInput('#password', pass);
    const navPromise = page.waitForNavigation({ timeout: budgetFor('login-nav', 15000) }).catch(() => null);
    const clicouEntrar = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => (b.innerText || '').trim().includes('Entrar'));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!clicouEntrar) return await falha('LOGIN_FAILED', 'Botão Entrar não encontrado na tela de login');
    await navPromise;
    await sleep(1500);

    // Pós-login: confirmação POSITIVA de dashboard (sidebar expandida ANTES de medir — mesma ordem do envio).
    await page.evaluate(() => {
      const app = document.querySelector('#app');
      if (app && app.classList.contains('app-sidebar-minified')) {
        const b = document.querySelector('.app-sidebar-minify-btn');
        if (b) b.click();
      }
    });
    await page.waitForFunction(
      () => document.querySelectorAll('#sidebar .menu-link, .app-sidebar .menu-link').length > 0,
      { timeout: budgetFor('pos-login-dashboard', 15000), polling: 250 }
    ).catch(() => null);
    const sinais = await page.evaluate(function() {
      const menu = document.querySelectorAll('#sidebar .menu-link, .app-sidebar .menu-link');
      const senhas = Array.from(document.querySelectorAll('input[type=password]')).filter(function(el) { return el.offsetParent !== null; });
      return { url: window.location.href, menuLinks: menu.length, camposSenha: senhas.length, titulo: document.title || '',
               texto: (document.body ? (document.body.innerText || '') : '').substring(0, 3000) };
    });
    sinais.origemEsperada = portalUrl || null;
    const posLogin = classificarPosLogin(sinais);
    trace.push({ step: 'pos_login_check', tipo: posLogin.tipo, url: sinais.url, menuLinks: sinais.menuLinks, t: Date.now() - t0 });
    if (posLogin.tipo !== 'dashboard') {
      return await falha('POS_LOGIN_NAO_DASHBOARD', 'Login não chegou à área logada do portal (' + posLogin.tipo + ')');
    }

    // === Consulta Pedidos: pelo MENU (goto direto pode cair em /login/...) com fallback de goto ===
    const navConsulta = page.waitForNavigation({ timeout: budgetFor('nav-consulta', 20000) }).catch(() => null);
    const clicouMenu = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href]')).find((x) => (x.getAttribute('href') || '').endsWith('/order-viewer'));
      if (a) { a.click(); return true; }
      return false;
    });
    if (clicouMenu) await navConsulta;
    if (page.url().indexOf('/order-viewer') === -1) {
      await page.goto(portalUrl + '/order-viewer', { waitUntil: 'domcontentloaded', timeout: budgetFor('goto-consulta', 30000) });
    }
    trace.push({ step: 'consulta_aberta', via_menu: clicouMenu, url: page.url(), t: Date.now() - t0 });
    const temForm = await page.waitForSelector('#getFilterData', { timeout: budgetFor('form-consulta', 15000) }).then(() => true).catch(() => false);
    if (!temForm) return await falha('CONSULTA_INDISPONIVEL', 'Tela Consulta Pedidos sem o botão Filtrar');
    // O botão aparece ANTES de o portal ligar o jQuery e o DataTables: clicar nessa janela não dispara a consulta e a
    // tabela fica vazia (1º uso real, pedido 2141068, 2026-10-16: "0 linha(s) lida(s)" com o pedido existindo).
    // Espera a tabela INICIALIZADA (classe dataTable, posta pelo DataTables) antes de filtrar.
    const pronta = await page.waitForFunction(
      () => !!window.jQuery && !!document.querySelector('table.dataTable'),
      { timeout: budgetFor('consulta-pronta', 20000), polling: 250 },
    ).then(() => true).catch(() => false);
    trace.push({ step: 'consulta_pronta', pronta, t: Date.now() - t0 });
    if (!pronta) return await falha('CONSULTA_INDISPONIVEL', 'Tabela da Consulta Pedidos não inicializou (jQuery/DataTables)');
`;
