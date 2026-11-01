const $ = id => document.getElementById(id);
const DEFAULTS = {enabled:true, autoRefresh:true, refreshSeconds:60, lastMessage:'', lastAt:''};

async function refresh(){
  const d = await chrome.storage.local.get(DEFAULTS);
  $('state').textContent = d.enabled ? 'Automação ativada neste navegador.' : 'Automação pausada.';
  $('toggle').textContent = d.enabled ? 'Pausar automação' : 'Ativar automação';
  $('auto').checked = d.autoRefresh;
  $('secs').value = d.refreshSeconds;
  $('last').textContent = d.lastMessage
    ? `${d.lastMessage}${d.lastAt ? ' · ' + d.lastAt : ''}`
    : 'A extensão atua na lista de chamados (Assistência > Chamados) que estiver aberta.';
}

$('toggle').addEventListener('click', async () => {
  const d = await chrome.storage.local.get({enabled:true});
  await chrome.storage.local.set({enabled: !d.enabled});
  refresh();
});
$('auto').addEventListener('change', () => chrome.storage.local.set({autoRefresh: $('auto').checked}));
$('secs').addEventListener('change', () => {
  const v = Math.max(15, parseInt($('secs').value, 10) || 60);
  $('secs').value = v;
  chrome.storage.local.set({refreshSeconds: v});
});
$('run').addEventListener('click', async () => {
  $('run').disabled = true;
  $('last').textContent = 'Executando…';
  try {
    const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
    await chrome.tabs.sendMessage(tab.id, {type:'run-now'});
  } catch (error) {
    // Quando dá certo, o GLPI recarrega a página ao enviar e o canal fecha antes da
    // resposta. Não é falha: a página já gravou o resultado. Só avisa se ninguém ouviu.
    if (!/(channel|port) closed/i.test(error?.message || '')) {
      await chrome.storage.local.set({
        lastMessage:'Esta aba não é a lista de chamados do GLPI (ou foi aberta antes da extensão). Abra Assistência > Chamados ou atualize com F5 e tente de novo.',
        lastAt:new Date().toLocaleString('pt-BR')
      });
    }
  }
  $('run').disabled = false;
  refresh();
});
refresh();
