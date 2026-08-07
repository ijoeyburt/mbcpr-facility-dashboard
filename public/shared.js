// ---------- access code gate ----------
function getStoredCode() {
  return localStorage.getItem('accessCode') || '';
}

function ensureAccessCode() {
  return new Promise((resolve) => {
    const existing = getStoredCode();
    if (existing) return resolve(existing);
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="modal" style="max-width:300px; text-align:center;">
        <p class="modal-title" style="margin-bottom:8px;">Enter access code</p>
        <input id="gate-code" type="password" style="width:100%; padding:0.6rem; font-size:16px; text-align:center; border:1px solid var(--border-strong); border-radius:10px;" />
        <button class="primary" id="gate-submit" style="width:100%; margin-top:12px;">Continue</button>
      </div>`;
    document.body.appendChild(overlay);
    const submit = () => {
      const val = document.getElementById('gate-code').value.trim();
      if (!val) return;
      localStorage.setItem('accessCode', val);
      overlay.remove();
      resolve(val);
    };
    document.getElementById('gate-submit').addEventListener('click', submit);
    document.getElementById('gate-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  });
}

async function apiFetch(url, opts = {}) {
  const code = getStoredCode();
  opts.headers = Object.assign({}, opts.headers, {
    'Content-Type': 'application/json',
    'X-Access-Code': code,
  });
  const res = await fetch(url, opts);
  if (res.status === 401) {
    localStorage.removeItem('accessCode');
    location.reload();
    throw new Error('Access code rejected');
  }
  return res;
}

// ---------- websocket ----------
let ws = null;
function connectWS(role, onOpen, onMessage) {
  const code = getStoredCode();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/?role=${role}&code=${encodeURIComponent(code)}`);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => onOpen && onOpen());
  ws.addEventListener('close', () => setTimeout(() => connectWS(role, onOpen, onMessage), 3000));
  if (onMessage) ws.addEventListener('message', onMessage);
  return ws;
}

function sendControlMessage(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---------- push to talk ----------
// Zone is fixed to "both" for mic broadcasts (no zone picker on the main screen).
const ZONE_BYTE = { pool: 0, poolhouse: 1, both: 2 };

let audioCtx, micStream, mediaRecorder, gainNode, compressorNode, recordedChunks;

async function startTalking(zone = 'both') {
  if (!micStream) {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { autoGainControl: false, echoCancellation: true, noiseSuppression: true },
    });
  }
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(micStream);
  gainNode = audioCtx.createGain();
  gainNode.gain.value = 1.3;
  compressorNode = audioCtx.createDynamicsCompressor();
  const dest = audioCtx.createMediaStreamDestination();
  source.connect(gainNode).connect(compressorNode).connect(dest);

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(dest.stream);
  mediaRecorder.ondataavailable = (e) => e.data.size && recordedChunks.push(e.data);
  mediaRecorder.onstop = () => sendClip(zone);
  mediaRecorder.start();
}

function stopTalking() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
}

async function sendClip(zone) {
  if (!recordedChunks.length || !ws || ws.readyState !== WebSocket.OPEN) return;
  const blob = new Blob(recordedChunks, { type: recordedChunks[0].type || 'audio/webm' });
  const mimeType = blob.type;
  const audioBuf = await blob.arrayBuffer();
  const mimeBytes = new TextEncoder().encode(mimeType);
  const header = new Uint8Array(1 + mimeBytes.length + 1);
  header[0] = mimeBytes.length;
  header.set(mimeBytes, 1);
  header[1 + mimeBytes.length] = ZONE_BYTE[zone] ?? 2;
  const payload = new Uint8Array(header.length + audioBuf.byteLength);
  payload.set(header, 0);
  payload.set(new Uint8Array(audioBuf), header.length);
  ws.send(payload.buffer);
}

function wirePushToTalk(buttonEl, zone = 'both') {
  const start = (e) => {
    e.preventDefault();
    buttonEl.classList.add('talking');
    startTalking(zone);
  };
  const end = (e) => {
    e.preventDefault();
    buttonEl.classList.remove('talking');
    stopTalking();
  };
  buttonEl.addEventListener('mousedown', start);
  buttonEl.addEventListener('touchstart', start);
  buttonEl.addEventListener('mouseup', end);
  buttonEl.addEventListener('mouseleave', end);
  buttonEl.addEventListener('touchend', end);
}

// ---------- music popup ----------
async function openMusicPopup() {
  const res = await apiFetch('/api/playlists');
  const playlists = await res.json();
  let selectedPlaylist = null;
  let selectedZone = 'both';

  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <p class="modal-title">Music</p>
        <button class="close-btn" aria-label="Close">&times;</button>
      </div>
      <p class="section-label">Playlist</p>
      <div class="playlist-grid" id="playlist-options"></div>
      <p class="section-label">Zone</p>
      <div class="zone-grid" id="zone-options">
        <button data-zone="pool">Pool</button>
        <button data-zone="poolhouse">Pool house</button>
        <button data-zone="both">Both</button>
      </div>
      <button class="primary submit-btn" id="play-btn">Play</button>
      <button class="danger-outline submit-btn" id="stop-btn" style="margin-top:8px;">Stop</button>
    </div>`;
  document.body.appendChild(overlay);

  const playlistWrap = overlay.querySelector('#playlist-options');
  playlists.forEach((p) => {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.addEventListener('click', () => {
      selectedPlaylist = p.id;
      [...playlistWrap.children].forEach((c) => c.classList.remove('selected'));
      b.classList.add('selected');
    });
    playlistWrap.appendChild(b);
  });

  const zoneWrap = overlay.querySelector('#zone-options');
  [...zoneWrap.children].forEach((b) => {
    if (b.dataset.zone === 'both') b.classList.add('selected');
    b.addEventListener('click', () => {
      selectedZone = b.dataset.zone;
      [...zoneWrap.children].forEach((c) => c.classList.remove('selected'));
      b.classList.add('selected');
    });
  });

  overlay.querySelector('.close-btn').addEventListener('click', () => overlay.remove());
  overlay.querySelector('#play-btn').addEventListener('click', () => {
    if (!selectedPlaylist) return alert('Pick a playlist first.');
    sendControlMessage({ type: 'play', playlist: selectedPlaylist, zone: selectedZone, mode: 'shuffle-loop' });
    overlay.remove();
  });
  overlay.querySelector('#stop-btn').addEventListener('click', () => {
    sendControlMessage({ type: 'stop', zone: selectedZone });
    overlay.remove();
  });
}

// ---------- task popups ----------
function formatDue(task) {
  if (task.recurring === false) return task.lastCompleted ? 'Filed previously' : 'One-off report';
  if (!task.lastCompleted) return 'Never completed - due now';
  if (task.overdue) return `Overdue - was due ${new Date(task.dueAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return `Next due ${new Date(task.dueAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

function renderTaskGrid(containerEl, tasks, { includeReports = true } = {}) {
  containerEl.innerHTML = '';
  tasks
    .filter((t) => includeReports || t.type !== 'report')
    .forEach((task) => {
      const card = document.createElement('button');
      card.className = 'task-card' + (task.overdue ? ' overdue' : task.lastCompleted ? ' done' : '');
      card.innerHTML = `
        <div class="row">
          <span class="name">${task.title}</span>
        </div>
        <span class="meta">${formatDue(task)}</span>`;
      card.addEventListener('click', () => openTaskPopup(task, containerEl));
      containerEl.appendChild(card);
    });
}

function openTaskPopup(task, gridEl) {
  const overlay = document.createElement('div');
  overlay.className = 'overlay';

  let bodyHtml = '';
  if (task.type === 'checklist') {
    bodyHtml = task.fields
      .map((f) => {
        if (f.type === 'text') {
          return `<div class="field"><label>${f.label}</label><input type="text" data-key="${f.key}" placeholder="${f.placeholder || ''}" /></div>`;
        }
        return `<div class="check-row">
          <input type="checkbox" data-key="${f.key}" />
          <span>${f.label}</span>
          <input type="text" data-init="${f.key}" placeholder="Init." />
        </div>`;
      })
      .join('');
  } else if (task.type === 'numeric') {
    bodyHtml =
      task.groups
        .map(
          (g) => `<div class="field-group">
        <p class="group-label">${g.label}</p>
        <div class="group-fields">
          ${g.fields.map((f) => `<div><label style="font-size:11px;color:var(--text-muted);">${f.label}</label><input type="number" step="0.1" data-key="${f.key}" /></div>`).join('')}
        </div>
      </div>`
        )
        .join('') + `<div class="field"><label>Initials</label><input type="text" data-key="initials" style="width:80px;" /></div>`;
  } else if (task.type === 'report') {
    bodyHtml = task.fields
      .map((f) => {
        const tag = f.type === 'textarea' ? `<textarea data-key="${f.key}"></textarea>` : `<input type="text" data-key="${f.key}" placeholder="${f.placeholder || ''}" />`;
        return `<div class="field"><label>${f.label}</label>${tag}</div>`;
      })
      .join('');
  }

  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <p class="modal-title">${task.title}</p>
        <button class="close-btn" aria-label="Close">&times;</button>
      </div>
      <p class="modal-meta">${formatDue(task)}${task.note ? ' &middot; ' + task.note : ''}</p>
      ${bodyHtml}
      <button class="primary submit-btn" id="task-submit">Submit</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-btn').addEventListener('click', () => overlay.remove());

  overlay.querySelector('#task-submit').addEventListener('click', async () => {
    const values = {};
    overlay.querySelectorAll('[data-key]').forEach((el) => {
      if (el.type === 'checkbox') values[el.dataset.key] = el.checked;
      else values[el.dataset.key] = el.value;
    });
    overlay.querySelectorAll('[data-init]').forEach((el) => {
      values[el.dataset.init + '_initials'] = el.value;
    });

    const endpoint = task.id === 'incident' ? '/api/incidents' : task.id === 'referral' ? '/api/referrals' : `/api/tasks/${task.id}/submit`;
    await apiFetch(endpoint, { method: 'POST', body: JSON.stringify({ values }) });
    overlay.remove();
    if (gridEl) {
      const res = await apiFetch('/api/tasks');
      renderTaskGrid(gridEl, await res.json(), { includeReports: gridEl.dataset.includeReports !== 'false' });
    }
  });
}

// ---------- notices ----------
async function loadNotice(noticeEl) {
  const res = await apiFetch('/api/notices');
  const notice = await res.json();
  if (!notice || !notice.text) {
    noticeEl.classList.add('hidden');
    return;
  }
  noticeEl.classList.remove('hidden');
  noticeEl.querySelector('.notice-text').textContent = notice.text;
}
