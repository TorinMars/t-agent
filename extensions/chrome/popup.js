const state = await chrome.runtime.sendMessage({
    type: 'popup.state'
  }),
  button = document.querySelector('#toggle');
document.querySelector('#status').textContent = state.status + (state.recording ? ' · recording' : '');
button.textContent = state.how ? 'Take back' : 'Let T-Agent use this tab';
button.disabled = !state.scriptable;
button.onclick = async () => {
  const response = await chrome.runtime.sendMessage({
    type: state.how ? 'takeback' : 'handover',
    tab_id: state.tab_id
  });
  if (response.error) document.querySelector('#status').textContent = response.error;else window.close();
};
document.querySelector('#settings').onclick = () => chrome.runtime.openOptionsPage();
