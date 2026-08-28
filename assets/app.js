const API = 'https://api.cailox.com';

let token = localStorage.getItem('cailox_token') || '';
let sessionId = '';
let turn = 0;
let lastMessageId = null;
let history = [];
let sending = false;
let recognition = null;
let listening = false;
let voiceBase = '';
let voiceFinal = '';
let voiceFailed = false;

const $ = id => document.getElementById(id);
const savedUser = localStorage.getItem('cailox_user') || '';
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (savedUser && $('username')) $('username').value = savedUser;
$('autoVoiceSend').checked = localStorage.getItem('cailox_voice_autosend') !== 'false';

async function call(path, opts = {}) {
  const headers = {'Content-Type': 'application/json', ...(opts.headers || {})};
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(API + path, {...opts, headers});
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(data.detail || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function bubble(text, role, extra = '') {
  const el = document.createElement('div');
  el.className = `bubble ${role} ${extra}`.trim();
  el.textContent = text;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
  return el;
}

function context() {
  return history
    .slice(-10)
    .map(x => `${x.role === 'user' ? 'Kullanıcı' : 'TURAN'}: ${x.text}`)
    .join('\n')
    .slice(-8000);
}

function resizeComposer() {
  const input = $('message');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
}

function setSending(value) {
  sending = value;
  $('sendButton').disabled = value;
  if ($('micButton')) $('micButton').disabled = value || !SpeechRecognition;
}

function setVoiceUi(active, status) {
  listening = active;
  $('micButton').classList.toggle('listening', active);
  $('micButton').setAttribute('aria-pressed', String(active));
  $('micLabel').textContent = active ? 'Dinlemeyi bitir' : 'Sesli giriş';
  $('voiceStatus').textContent = status || (active ? 'Dinleniyor…' : 'Hazır');
}

async function enterChat(tester) {
  $('tester').textContent = tester || localStorage.getItem('cailox_user') || 'test';
  const session = await call('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({client_version: 'cailox-web-v5-voice'})
  });
  sessionId = session.session_id;
  turn = 0;
  history = [];
  lastMessageId = null;
  $('loginView').classList.add('hidden');
  $('chatView').classList.remove('hidden');
  $('message').focus();
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  $('loginError').textContent = '';
  const username = $('username').value.trim();
  localStorage.setItem('cailox_user', username);
  try {
    const data = await call('/v1/login', {
      method: 'POST',
      body: JSON.stringify({
        username,
        password: $('password').value,
        consent: $('consent').checked
      })
    });
    token = data.token;
    localStorage.setItem('cailox_token', token);
    localStorage.setItem('cailox_user', data.tester_id);
    $('password').value = '';
    await enterChat(data.tester_id);
  } catch (error) {
    token = '';
    localStorage.removeItem('cailox_token');
    $('loginError').textContent = error.message;
  }
});

async function submitMessage(rawText) {
  const text = String(rawText || '').trim();
  if (!text || sending || !sessionId) return;

  if (recognition && listening) {
    try { recognition.stop(); } catch {}
  }

  setSending(true);
  $('message').value = '';
  resizeComposer();
  turn += 1;
  bubble(text, 'user');
  history.push({role: 'user', text});
  const pending = bubble('TURAN düşünüyor…', 'assistant', 'pending');

  try {
    const data = await call('/v1/chat', {
      method: 'POST',
      headers: {
        'X-Idempotency-Key': crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
      },
      body: JSON.stringify({
        session_id: sessionId,
        message: text,
        turn_index: turn,
        context: context()
      })
    });
    pending.remove();
    bubble(data.answer, 'assistant');
    history.push({role: 'assistant', text: data.answer});
    lastMessageId = data.message_id;
    $('latency').textContent = `${data.latency_ms} ms`;
    $('feedback').classList.remove('hidden');
    renderScores();
  } catch (error) {
    pending.textContent = `Hata: ${error.message}`;
    pending.classList.remove('pending');
    if (error.status === 401) {
      token = '';
      localStorage.removeItem('cailox_token');
    }
  } finally {
    setSending(false);
    $('message').focus();
  }
}

$('chatForm').addEventListener('submit', event => {
  event.preventDefault();
  submitMessage($('message').value);
});

$('message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submitMessage($('message').value);
  }
});

$('message').addEventListener('input', resizeComposer);

function renderScores() {
  $('scores').innerHTML = '';
  for (let score = 1; score <= 5; score += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = score;
    button.setAttribute('aria-label', `${score} puan`);
    button.onclick = async () => {
      try {
        await call('/v1/feedback', {
          method: 'POST',
          body: JSON.stringify({
            session_id: sessionId,
            message_id: lastMessageId,
            score,
            tags: [],
            comment: ''
          })
        });
        $('feedback').classList.add('hidden');
      } catch {}
    };
    $('scores').appendChild(button);
  }
}

function setupVoiceInput() {
  if (!SpeechRecognition) {
    $('micButton').disabled = true;
    $('voiceStatus').textContent = 'Sesli giriş bu tarayıcıda desteklenmiyor';
    $('autoVoiceSend').disabled = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'tr-TR';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => setVoiceUi(true, 'Dinleniyor…');

  recognition.onresult = event => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const transcript = event.results[i][0].transcript.trim();
      if (!transcript) continue;
      if (event.results[i].isFinal) {
        voiceFinal = [voiceFinal, transcript].filter(Boolean).join(' ').trim();
      } else {
        interim = [interim, transcript].filter(Boolean).join(' ').trim();
      }
    }

    const spoken = [voiceFinal, interim].filter(Boolean).join(' ').trim();
    $('message').value = [voiceBase, spoken].filter(Boolean).join(' ').trim();
    resizeComposer();
  };

  recognition.onerror = event => {
    voiceFailed = true;
    const messages = {
      'not-allowed': 'Mikrofon izni verilmedi',
      'service-not-allowed': 'Ses tanıma izni verilmedi',
      'audio-capture': 'Mikrofona erişilemiyor',
      'no-speech': 'Ses algılanmadı',
      'network': 'Ses tanıma bağlantı hatası',
      'aborted': 'Dinleme durduruldu'
    };
    $('voiceStatus').textContent = messages[event.error] || 'Sesli giriş tamamlanamadı';
  };

  recognition.onend = () => {
    const shouldSend = !voiceFailed && Boolean(voiceFinal.trim()) && $('autoVoiceSend').checked;
    const completedText = $('message').value.trim();
    setVoiceUi(false, voiceFailed ? $('voiceStatus').textContent : 'Hazır');
    voiceBase = '';
    voiceFinal = '';
    const failed = voiceFailed;
    voiceFailed = false;
    if (!failed && shouldSend && completedText && !sending) submitMessage(completedText);
  };

  $('micButton').addEventListener('click', () => {
    if (listening) {
      try { recognition.stop(); } catch {}
      return;
    }
    voiceBase = $('message').value.trim();
    voiceFinal = '';
    voiceFailed = false;
    $('voiceStatus').textContent = 'Mikrofon açılıyor…';
    try {
      recognition.start();
    } catch {
      $('voiceStatus').textContent = 'Mikrofon başlatılamadı';
    }
  });
}

$('autoVoiceSend').addEventListener('change', () => {
  localStorage.setItem('cailox_voice_autosend', String($('autoVoiceSend').checked));
});

$('logout').addEventListener('click', async () => {
  try {
    if (recognition && listening) recognition.abort();
    if (sessionId) await call(`/v1/sessions/${sessionId}/end`, {method: 'POST'});
  } catch {}
  token = '';
  sessionId = '';
  localStorage.removeItem('cailox_token');
  location.reload();
});

setupVoiceInput();
setSending(false);
resizeComposer();

(async () => {
  if (!token) return;
  try {
    await enterChat(savedUser);
  } catch (error) {
    if (error.status === 401) {
      token = '';
      localStorage.removeItem('cailox_token');
    }
    if (savedUser && $('username')) $('username').value = savedUser;
  }
})();
