(() => {
  if (window.__glpiPlanejadorInstalled) return;
  window.__glpiPlanejadorInstalled = true;

  const SOURCE = 'GLPI Planejador';
  const SCAN_EVERY_MS = 5000;
  const MAX_ATTEMPTS = 2;                 // tentativas por chamado antes de pausar
  const RETRY_AFTER_MS = 10 * 60 * 1000;  // depois de pausar, tenta de novo após 10 min
  const ATTEMPTS_KEY = 'glpiPlanejadorTentativas';
  const SENT_KEY = 'glpiPlanejadorEnviados';   // chamados do último envio (para desmarcar na volta)
  const ON_NOVO_KEY = 'glpiPlanejadorNaListaNovo'; // esta aba já esteve na lista de chamados Novo
  const DEFAULTS = { enabled: true, autoRefresh: true, refreshSeconds: 60 };
  const loadedAt = Date.now();

  let busy = false;
  let lastLogged = '';
  let timer = null;
  let novoList = null;   // resultado de isNovoList() para esta página

  // ---------------------------------------------------------------- utilidades
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  // minúsculas, sem acento, espaços normalizados: "Ações" -> "acoes"
  const norm = s => (s || '').replace(/\s+/g, ' ').trim()
    .toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const textOf = el => el?.innerText || el?.textContent || '';
  const visible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  // Esperas movidas a eventos do DOM (MutationObserver), não a timers: o Chrome
  // atrasa timers de abas ocultas/minimizadas (até 1x por minuto), mas não os
  // callbacks de MutationObserver nem as mensagens. O setTimeout abaixo só
  // serve de limite máximo (falha), e o setInterval é só reforço quando visível.
  function waitFor(fn, timeout = 8000) {
    return new Promise(resolve => {
      let done = false;
      let obs = null, limit = null, poll = null;
      const finish = value => {
        if (done) return;
        done = true;
        obs?.disconnect(); clearTimeout(limit); clearInterval(poll);
        resolve(value);
      };
      const check = () => {
        let value = null;
        try { value = fn(); } catch (_) { /* tenta de novo na próxima mutação */ }
        if (value) finish(value);
      };
      obs = new MutationObserver(check);
      obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      limit = setTimeout(() => finish(null), timeout);
      poll = setInterval(check, 250);
      check();
    });
  }

  // Cede a vez ao navegador (para o GLPI processar o clique) sem usar timer.
  const yieldTask = () => new Promise(resolve => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });

  async function log(msg) {
    console.info(`[${SOURCE}] ${msg}`);
    lastLogged = msg;
    try {
      await chrome.storage.local.set({ lastMessage: msg, lastAt: new Date().toLocaleString('pt-BR') });
    } catch (_) { /* extensão recarregada: ignora */ }
  }
  async function logOnce(msg) { if (msg !== lastLogged) await log(msg); }

  async function getCfg() {
    try { return await chrome.storage.local.get(DEFAULTS); }
    catch (_) { return { ...DEFAULTS, enabled: false }; }
  }

  // Tentativas por chamado (sobrevivem ao reload da página, evitam laço infinito)
  function getAttempts() {
    try { return JSON.parse(sessionStorage.getItem(ATTEMPTS_KEY) || '{}'); } catch (_) { return {}; }
  }
  function saveAttempts(obj) {
    try { sessionStorage.setItem(ATTEMPTS_KEY, JSON.stringify(obj)); } catch (_) { /* ignora */ }
  }
  function canTry(attempts, id) {
    const a = attempts[id];
    if (!a) return true;
    if (Date.now() - a.ts > RETRY_AFTER_MS) return true;
    return a.count < MAX_ATTEMPTS;
  }
  function markAttempts(ids) {
    const attempts = getAttempts();
    for (const id of ids) {
      const a = attempts[id];
      const expired = a && Date.now() - a.ts > RETRY_AFTER_MS;
      attempts[id] = { count: (a && !expired ? a.count : 0) + 1, ts: Date.now() };
    }
    saveAttempts(attempts);
  }

  // ------------------------------------------------------- lista de chamados
  function isTicketList() {
    return /\/front\/ticket\.php$/.test(location.pathname);
  }

  // Critérios da busca ativa, como o GLPI montou o formulário acima da lista:
  // criteria[0][field]=12, criteria[0][searchtype]=equals, criteria[0][value]=1...
  // Critérios dentro de grupo ficam de fora; o "E/OU" do próprio grupo entra.
  function readCriteria() {
    const crits = new Map();
    for (const el of document.querySelectorAll('[name^="criteria["]')) {
      const m = /^criteria\[(\d+)\]\[(\w+)\]$/.exec(el.name);
      if (!m) continue;
      if (!crits.has(m[1])) crits.set(m[1], {});
      crits.get(m[1])[m[2]] = el.value;
    }
    return [...crits.values()];
  }

  // Só age na lista "dos novos chamados": a busca tem Status é Novo (campo 12,
  // "é", valor 1), nenhum "OU" que traga chamados de outro status e não é a
  // lixeira. Lido uma vez por página: é o filtro que a lista está mostrando,
  // mesmo que alguém mexa no formulário depois sem clicar em Pesquisar.
  function isNovoList() {
    if (novoList !== null) return novoList;
    const crits = readCriteria();
    if (!crits.length) return false;   // formulário de busca ainda não apareceu
    const trash = [...document.querySelectorAll('input[name="is_deleted"]')]
      .some(el => (el.type === 'checkbox' ? el.checked : el.value === '1'));
    const widened = crits.slice(1).some(c => /OR/i.test(c.link || ''));
    const novo = crits.some(c => c.field === '12' && c.searchtype === 'equals' && c.value === '1'
      && !/NOT/i.test(c.link || '') && c.meta !== '1' && (!c.itemtype || c.itemtype === 'Ticket'));
    novoList = novo && !widened && !trash;
    if (novoList) pinFilterInUrl(crits);
    return novoList;
  }

  function wasOnNovoList() {
    try { return !!sessionStorage.getItem(ON_NOVO_KEY); } catch (_) { return false; }
  }

  // Aberta pelo menu (sem filtro na URL), a lista usa a última busca da sessão do
  // GLPI, que vale para todas as abas: abrir "solucionados" em outra aba faria
  // esta aba virar "solucionados" no próximo recarregamento. Grava o filtro na URL.
  function pinFilterInUrl(crits) {
    if (/[?&]criteria/.test(location.search)) return;
    if (crits.some(c => !('field' in c))) return; // tem grupo: deixa como está
    const params = new URLSearchParams();
    crits.forEach((c, i) => {
      for (const [key, value] of Object.entries(c)) params.set(`criteria[${i}][${key}]`, value);
    });
    history.replaceState(history.state, '', `${location.pathname}?${params}`);
  }

  function statusIndex(table) {
    for (const head of table.querySelectorAll('thead tr')) {
      const cells = [...head.cells];
      let i = cells.findIndex(c => norm(textOf(c)) === 'status');
      if (i < 0) i = cells.findIndex(c => norm(textOf(c)).includes('status'));
      if (i >= 0) return i;
    }
    return -1;
  }

  function ticketId(row) {
    // A caixa da linha se chama item[Ticket][123]: é o ID certo mesmo que outra
    // coluna com link (requerente, entidade...) venha antes do título.
    const cb = row.querySelector('input[type="checkbox"][name^="item["]');
    const byName = cb && /\[(\d+)\]$/.exec(cb.name);
    if (byName) return byName[1];
    const link = row.querySelector('a[href*="ticket.form.php"]') || row.querySelector('a[href*="id="]');
    const m = link && /[?&]id=(\d+)/.exec(link.getAttribute('href') || '');
    if (m) return m[1];
    const cell = [...row.cells].find(c => /^\d[\d\s.]*$/.test(textOf(c).trim()));
    return cell ? textOf(cell).replace(/\D/g, '') : norm(textOf(row)).slice(0, 80);
  }

  function collectRows() {
    const out = { tableFound: false, novos: [], foreignChecked: [], others: 0 };
    for (const table of document.querySelectorAll('table')) {
      if (!visible(table)) continue;
      const idx = statusIndex(table);
      if (idx < 0) continue;
      out.tableFound = true;
      for (const row of table.querySelectorAll('tbody tr')) {
        if (!visible(row)) continue;
        const cell = row.cells[idx];
        if (!cell) continue;
        const cb = row.querySelector('input[type="checkbox"]');
        if (norm(textOf(cell)) === 'novo') {
          if (cb && !cb.disabled) out.novos.push({ row, cb, id: ticketId(row) });
        } else {
          out.others++;
          if (cb && cb.checked) out.foreignChecked.push(row);
        }
      }
    }
    return out;
  }

  function setChecked(cb, want) {
    if (cb.checked !== want) cb.click();
  }

  // Depois do envio o GLPI volta para a lista com os chamados enviados ainda
  // marcados (ele lembra a seleção). Essas marcas são da extensão: se ficarem,
  // bloqueiam o recarregamento automático (parece "usuário selecionando") e
  // contam como "chamado de outro status marcado". Roda uma vez, na volta.
  function clearOwnSelection() {
    let sent = null;
    try { sent = JSON.parse(sessionStorage.getItem(SENT_KEY) || 'null'); } catch (_) { /* ignora */ }
    if (!Array.isArray(sent)) return false;
    try { sessionStorage.removeItem(SENT_KEY); } catch (_) { /* ignora */ }
    for (const cb of document.querySelectorAll('table tbody input[type="checkbox"]:checked')) {
      const row = cb.closest('tr');
      if (row && sent.includes(ticketId(row))) cb.click();
    }
    return true;
  }

  // ------------------------------------------------------------ janela "Ações"
  const MODAL_SELECTOR = '.modal.show,.modal[style*="display: block"],.ui-dialog,dialog[open],[role="dialog"]';

  function openModals() {
    return [...document.querySelectorAll(MODAL_SELECTOR)].filter(visible);
  }

  // Só reconhece a janela real (modal visível com título "Ações"). Não usa mais
  // busca por texto solto na página: "Organização" contém "ação" e fazia a
  // extensão achar que a janela já estava aberta.
  function findActionDialog() {
    const roots = openModals();
    const byTitle = roots.find(el =>
      [...el.querySelectorAll('.modal-title,.ui-dialog-title,h1,h2,h3,h4,h5,h6')]
        .some(t => norm(textOf(t)) === 'acoes'));
    if (byTitle) return byTitle;
    return roots.find(el => [...el.querySelectorAll('select')]
      .some(s => [...s.options].some(o => isUpdateAction(optInfo(o), o)))) || null;
  }

  async function closeDialog() {
    const dialog = findActionDialog();
    if (!dialog) return;
    const btn = dialog.querySelector('.btn-close,[data-bs-dismiss="modal"],[data-dismiss="modal"],button.close,.ui-dialog-titlebar-close');
    if (btn) btn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(() => !findActionDialog(), 2000);
  }

  function findActionsButton() {
    return [...document.querySelectorAll('button,a,[role="button"]')]
      .filter(visible)
      .find(el => !el.closest(MODAL_SELECTOR) && norm(textOf(el)) === 'acoes') || null;
  }

  // ------------------------------------------- <select> (inclusive os do select2)
  // O select2 do GLPI esconde o <select> nativo mas ele continua no DOM. Mexer
  // nele e disparar "change" é o que o GLPI escuta para carregar o próximo campo.
  // No <select> nativo a opção é só "Status" dentro do optgroup "Características";
  // o texto "Características - Status" só existe na tela, montado pelo select2.
  const optInfo = opt => {
    const group = opt.parentElement?.tagName === 'OPTGROUP' ? opt.parentElement.label : '';
    const text = norm(opt.textContent);
    return { text, group: norm(group), full: group ? norm(`${group} - ${opt.textContent}`) : text };
  };

  const isUpdateAction = (i, o) => i.text === 'atualizar' || /(^|:)update$/i.test(o.value);
  const isStatusField = i => i.full === 'caracteristicas - status' || i.text === 'caracteristicas - status';
  const isStatusFieldLoose = i => i.text === 'status';
  const isPlanned = (i, o, s) => i.text === 'em atendimento (planejado)' || (s.name === 'status' && o.value === '3');

  function findSelect(dialog, matcher) {
    for (const select of dialog.querySelectorAll('select')) {
      const option = [...select.options].find(o => matcher(optInfo(o), o, select));
      if (option) return { select, option };
    }
    return null;
  }

  function fireChange(select) {
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setSelectValue(select, option) {
    select.value = option.value;
    option.selected = true;
    fireChange(select);
  }

  function fireMouse(el, types) {
    for (const type of types) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  }

  // Plano B: escolher pelo menu do select2, com a sequência de mouse que ele exige
  // (abre com mousedown e seleciona com mouseup/click; só .click() não abre).
  async function pickViaSelect2(select, option) {
    const container = select.nextElementSibling;
    const trigger = container?.querySelector?.('.select2-selection');
    if (!trigger) return false;
    const want = optInfo(option);
    fireMouse(trigger, ['mousedown']);
    const item = await waitFor(() => [...document.querySelectorAll('.select2-results__option[role="option"],.select2-results__option[aria-selected]')]
      .filter(visible)
      .find(li => {
        if (norm(textOf(li)) !== want.text) return false;
        const groupEl = li.closest('.select2-results__options--nested')?.parentElement?.querySelector('.select2-results__group');
        return !want.group || !groupEl || norm(textOf(groupEl)) === want.group;
      }), 3000);
    if (!item) { fireMouse(trigger, ['mousedown']); return false; }
    fireMouse(item, ['mouseup', 'click']);
    return true;
  }

  function describeSelects(dialog) {
    return [...dialog.querySelectorAll('select')].map(s => {
      const opts = [...s.options].slice(0, 6).map(o => o.textContent.trim()).join(' | ');
      return `[${s.name || s.id || 'select'}: ${opts}${s.options.length > 6 ? ' …' : ''}]`;
    }).join(' ') || '(nenhum select na janela)';
  }

  // Escolhe a opção e espera (sem "sleep" fixo) o GLPI carregar o próximo passo.
  async function pick(dialog, hit, nextFinder) {
    if (hit.select.value !== hit.option.value) setSelectValue(hit.select, hit.option);
    if (!nextFinder) return hit;
    let next = await waitFor(nextFinder, 4000);
    if (next) return next;
    setSelectValue(hit.select, hit.option);            // reforça o evento "change"
    next = await waitFor(nextFinder, 4000);
    if (next) return next;
    if (await pickViaSelect2(hit.select, hit.option)) next = await waitFor(nextFinder, 6000);
    return next;
  }

  async function fillActionDialog(dialog) {
    // 1) Ação = Atualizar
    const action = await waitFor(() => findSelect(dialog, isUpdateAction), 8000);
    if (!action) throw new Error(`não achei a ação "Atualizar" na janela. Selects: ${describeSelects(dialog)}`);

    // 2) Campo = Características - Status
    const findField = () => findSelect(dialog, isStatusField) || findSelect(dialog, isStatusFieldLoose);
    const field = await pick(dialog, action, findField);
    if (!field) throw new Error(`o campo "Características - Status" não apareceu após escolher Atualizar. Selects: ${describeSelects(dialog)}`);

    // 3) Valor = Em atendimento (planejado)
    const findPlanned = () => findSelect(dialog, isPlanned);
    const status = await pick(dialog, field, findPlanned);
    if (!status) throw new Error(`a lista de status não apareceu após escolher Status. Selects: ${describeSelects(dialog)}`);
    await pick(dialog, status, null);
    await yieldTask();
    if (status.select.value !== status.option.value) {
      throw new Error('não consegui definir "Em atendimento (planejado)" no formulário');
    }

    // 4) Enviar
    const send = await waitFor(() => [...dialog.querySelectorAll('button,input[type="submit"],input[type="button"]')]
      .filter(visible)
      .filter(el => norm(el.matches('input') ? el.value : textOf(el)) === 'enviar')
      .pop(), 5000);
    if (!send) throw new Error('não encontrei o botão Enviar dentro da janela Ações');
    return send;
  }

  // ----------------------------------------------------------------- execução
  async function processNovos(force) {
    if (openModals().length) {             // há uma janela aberta (não é nossa): não mexe
      if (force) await log('Há uma janela aberta na página do GLPI. Feche-a e tente de novo.');
      return true;
    }

    let rows = collectRows();
    if (!rows.tableFound) {
      if (force) await log('Não encontrei a tabela de chamados com a coluna Status nesta página.');
      return false;
    }
    if (clearOwnSelection()) rows = collectRows();
    const { novos, foreignChecked, others } = rows;
    if (others) {                          // segunda trava: na lista Novo todos são Novo
      if (force) await log('A lista tem chamados que não estão com status Novo. Não alterei nada.');
      return false;
    }
    if (!novos.length) {
      if (force) await log('Nenhum chamado com status Novo nesta página.');
      return false;
    }

    const attempts = getAttempts();
    const todo = novos.filter(n => force || canTry(attempts, n.id));
    if (!todo.length) {
      await logOnce(`Chamado(s) ${novos.map(n => '#' + n.id).join(', ')} continuam Novo após ${MAX_ATTEMPTS} tentativas; pausei por 10 min. Use "Executar agora" para forçar.`);
      return false;
    }
    if (foreignChecked.length) {
      await logOnce('Há chamados que NÃO são Novo marcados na lista. Desmarque-os para a automação continuar (evita alterar o chamado errado).');
      return true;
    }

    const ids = todo.map(n => n.id);
    markAttempts(ids);
    try {
      for (const n of novos) setChecked(n.cb, todo.includes(n));
      await yieldTask();
      if (!todo.every(n => n.cb.checked)) throw new Error('não consegui marcar a caixa de seleção dos chamados Novo');

      const actions = findActionsButton();
      if (!actions) throw new Error('não encontrei o botão Ações acima da lista');
      actions.click();

      const dialog = await waitFor(findActionDialog, 8000);
      if (!dialog) throw new Error('cliquei em Ações mas a janela não abriu');

      const send = await fillActionDialog(dialog);
      await log(`Enviando "Em atendimento (planejado)" para ${ids.length} chamado(s): ${ids.map(i => '#' + i).join(', ')}`);
      try { sessionStorage.setItem(SENT_KEY, JSON.stringify(ids)); } catch (_) { /* ignora */ }
      send.click();

      // O GLPI normalmente recarrega a lista sozinho. Se não recarregar, recarrega aqui.
      await waitFor(() => !document.contains(dialog) || !visible(dialog), 20000);
      await sleep(1500);
      location.reload();
    } catch (error) {
      await closeDialog();
      for (const n of todo) { try { setChecked(n.cb, false); } catch (_) { /* linha já saiu da página */ } }
      await log(`Falha: ${error?.message || error}`);
    }
    return true;
  }

  // "Aba ativa" = a aba selecionada na SUA janela. Janela minimizada, atrás de
  // outra ou em outro monitor continua valendo; trocar para outra aba da mesma
  // janela pausa. Quem sabe isso é o service worker (a página não enxerga).
  async function tabIsActive() {
    try { return !!(await chrome.runtime.sendMessage({ type: 'is-active' }))?.active; }
    catch (_) { return false; }
  }

  function userIsTyping() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.isContentEditable || /^(textarea|select)$/i.test(el.tagName)) return true;
    return /^input$/i.test(el.tagName) && !/^(checkbox|radio|button|submit)$/i.test(el.type);
  }

  function maybeRefresh(cfg) {
    if (!cfg.autoRefresh) return;
    const secs = Math.max(15, Number(cfg.refreshSeconds) || 60);
    if (Date.now() - loadedAt < secs * 1000) return;
    if (openModals().length || userIsTyping()) return;
    if (document.querySelector('table tbody input[type="checkbox"]:checked')) return; // usuário selecionando
    location.reload();
  }

  async function scan(force = false) {
    if (!chrome.runtime?.id) { clearInterval(timer); return; } // extensão foi recarregada
    if (!isTicketList()) {
      if (force) await log('Abra a lista de chamados (Assistência > Chamados) e tente de novo.');
      return;
    }
    if (busy) {
      if (force) await log('Já há uma execução em andamento. Aguarde alguns segundos.');
      return;
    }
    // Marca "ocupado" antes de qualquer await: o timer de 5 s e o despertador do
    // service worker podem chegar juntos, e duas execuções ao mesmo tempo mexem
    // na mesma janela Ações e falham as duas (gastando as tentativas do chamado).
    busy = true;
    try {
      const cfg = await getCfg();
      if (!force && !cfg.enabled) return;
      if (!force && !(await tabIsActive())) return;
      // Fora da lista de chamados Novo não marca, não envia e não recarrega nada.
      if (!isNovoList()) {
        if (force) {
          await log('Esta lista não é a de chamados Novo (filtro "Status é Novo"). Não alterei nada.');
        } else if (wasOnNovoList()) {
          await logOnce('A aba do GLPI saiu da lista de chamados Novo. A automação fica parada até você voltar para o filtro "Status é Novo".');
        }
        return;
      }
      try { sessionStorage.setItem(ON_NOVO_KEY, '1'); } catch (_) { /* ignora */ }
      const handled = await processNovos(force);
      if (!handled && !force) maybeRefresh(cfg);
    } catch (error) {
      await log(`Erro na automação: ${error?.message || error}`);
    } finally {
      busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'run-now') {            // botão "Executar agora" do popup
      scan(true).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg?.type === 'tick') {               // despertador do service worker
      scan(false);
      sendResponse({ ok: true });
    }
    return false;
  });

  timer = setInterval(scan, SCAN_EVERY_MS);
  setTimeout(scan, 1500);
})();
