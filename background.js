// Service worker do GLPI Planejador.
// 1) Acorda a aba ativa de cada janela a cada 30 s. Alarmes não sofrem o atraso
//    que o Chrome aplica a timers de páginas ocultas/minimizadas.
// 2) Responde à página se ela é a aba ativa da própria janela.

const ALARM = 'glpi-planejador-tick';

function ensureAlarm() {
  chrome.alarms.get(ALARM, alarm => {
    if (!alarm) chrome.alarms.create(ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
  });
}
chrome.runtime.onInstalled.addListener(ensureAlarm);
chrome.runtime.onStartup.addListener(ensureAlarm);
ensureAlarm();

function poke(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'tick' }).catch(() => { /* aba sem a extensão (recarregue com F5) */ });
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== ALARM) return;
  // uma aba ativa por janela, inclusive de janelas minimizadas ou em segundo plano.
  // Sem permissão de host a URL da aba não vem preenchida; tudo bem: só a lista de
  // chamados tem o content script, nas outras abas a mensagem falha em silêncio.
  const tabs = await chrome.tabs.query({ active: true });
  for (const tab of tabs) poke(tab.id);
});

// Ao voltar para a aba do GLPI, verifica na hora.
chrome.tabs.onActivated.addListener(({ tabId }) => poke(tabId));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'is-active' || !sender.tab) return false;
  chrome.tabs.get(sender.tab.id)
    .then(tab => sendResponse({ active: !!tab.active }))
    .catch(() => sendResponse({ active: false }));
  return true;
});
