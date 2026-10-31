function applyAppearance() {
  let theme;
  try { theme=localStorage.getItem('crewos-theme'); } catch {}
  if(theme!=='dark'&&theme!=='light')theme=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';
  document.documentElement.dataset.theme=theme;
}
applyAppearance();
window.addEventListener('storage',event=>{if(event.key==='crewos-theme'||event.key===null)applyAppearance();});
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',applyAppearance);
const status = document.querySelector('#status');
document.querySelector('#reconnect')?.addEventListener('click',()=>location.reload());
let rfb;
let browserTimer;
let frameUrl;

function showStatus(message) { status.textContent = message; }

async function connectBrowser(workflowId) {
  const frame = document.querySelector('#browser-frame');
  document.querySelector('#desktop').hidden = true;
  frame.hidden = false;
  const refresh = async () => {
    try {
      const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/browser/frame`, { credentials: 'same-origin', cache: 'no-store' });
      if (response.ok) {
        if (frameUrl) URL.revokeObjectURL(frameUrl);
        frameUrl = URL.createObjectURL(await response.blob());
        frame.src = frameUrl;
        showStatus('Live browser · read only · refreshes every second');
      } else {
        const data = await response.json().catch(() => ({}));
        showStatus(data.message || 'Waiting for the employee’s browser session…');
        if (response.status === 404 || data.message?.includes('available while the task is active')) {
          showStatus('Browser session ended. Open the task replay from CrewOS.');
          return;
        }
      }
    } catch (error) { showStatus(error.message || 'Browser view disconnected.'); }
    browserTimer = setTimeout(refresh, 1000);
  };
  await refresh();
}

async function connect() {
  const params = new URLSearchParams(location.search);
  const workflowId = params.get('workflowId');
  if (workflowId) return connectBrowser(workflowId);
  const environmentId = params.get('environmentId');
  if (!environmentId) throw new Error('Choose a desktop from the CrewOS office page.');

  const response = await fetch(`/api/environments/${encodeURIComponent(environmentId)}/stream`, { credentials: 'same-origin', cache: 'no-store' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Could not open the desktop stream.');
  if (typeof data.streamUrl !== 'string' || !data.streamUrl.startsWith('wss://')) throw new Error('Solari returned an invalid desktop stream.');

  const { default: RFB } = await import('/vendor/novnc/core/rfb.js');
  rfb = new RFB(document.querySelector('#desktop'), data.streamUrl);
  rfb.scaleViewport = true;
  rfb.clipViewport = true;
  rfb.viewOnly = true;
  rfb.addEventListener('connect', () => {
    showStatus('Live desktop · read only');
  });
  rfb.addEventListener('disconnect', (event) => {
    showStatus(event.detail.clean ? 'Desktop stream closed' : 'Desktop stream disconnected');
  });
  rfb.addEventListener('credentialsrequired', () => showStatus('The desktop requested credentials. Reopen the view from CrewOS.'));
}

connect().catch((error) => showStatus(error.message));
window.addEventListener('pagehide', () => { clearTimeout(browserTimer); if (frameUrl) URL.revokeObjectURL(frameUrl); rfb?.disconnect(); }, { once: true });
