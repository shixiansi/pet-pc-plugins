// The sample chat plugin's front end.
//
// It is a plain module loaded in a sandboxed iframe: it can address exactly one
// thing in the outside world, its parent, and only with the four message types
// of the bridge protocol (ready / init / request / response / event). There is
// deliberately no fetch, no storage and no file access - the network half of
// llm.chat happens in the host, which is also where the model key lives.

const els = {
  reply: document.getElementById('reply'),
  prompt: document.getElementById('prompt'),
  status: document.getElementById('status'),
  send: document.getElementById('send'),
  stop: document.getElementById('stop'),
  bubble: document.getElementById('bubble'),
  surface: document.getElementById('surface'),
};

// Permission names, spelled once. A typo here would silently disable a control
// the user did grant.
const PERM_CHAT = 'llm.chat';
const PERM_BUBBLE = 'pet.bubble';
const PERM_SURFACE = 'pet.surface';

let initialised = false;
const granted = new Set();

// The reply currently being streamed. `node` is the single text node that the
// whole answer is appended into - it must outlive every delta, because
// rebuilding it per frame would discard and re-layout the text on each chunk.
let current = null;
// The text of the last finished reply, used as the bubble's line.
let lastReplyText = '';
let surfaceShown = false;
let seq = 0;

/** A message id unique within this plugin instance. */
function nextId() {
  seq += 1;
  return `p${seq}-${Date.now().toString(36)}`;
}

/** The one channel to the host. Nothing happens before `init` arrives. */
function postToHost(msg) {
  try {
    window.parent.postMessage(msg, '*');
  } catch {
    // The host tore the iframe down; there is nothing sensible to do.
  }
}

/**
 * Sends a host capability request.
 *
 * Refuses before the handshake completes: the granted set is unknown until
 * `init`, and guessing it would both spam the host and let the UI imply
 * permissions the user may not have given.
 */
function request(method, payload) {
  if (!initialised) return null;
  const id = nextId();
  postToHost({ v: 1, type: 'request', id, method, payload });
  return id;
}

/** Appends a rendered line to the reply area and scrolls it into view. */
function appendLine(kind, text) {
  const line = document.createElement('div');
  line.className = `msg ${kind}`;
  line.appendChild(document.createTextNode(text || ''));
  els.reply.appendChild(line);
  scrollToEnd();
  return line;
}

function scrollToEnd() {
  els.reply.scrollTop = els.reply.scrollHeight;
}

function setStatus(text) {
  els.status.textContent = text;
}

/**
 * Applies the granted set to the controls.
 *
 * Missing permissions are stated rather than hidden: a greyed-out control with
 * the reason visible is how the user learns that the plugin wants more than
 * they allowed.
 */
function applyGrants() {
  const canChat = granted.has(PERM_CHAT);
  const canBubble = granted.has(PERM_BUBBLE);
  const canSurface = granted.has(PERM_SURFACE);

  els.prompt.disabled = !canChat;
  els.send.disabled = !canChat;
  els.bubble.disabled = !canBubble;
  els.surface.disabled = !canSurface;
  els.stop.disabled = !canChat;

  if (!canChat) {
    setStatus('未获授权：llm.chat');
  } else {
    setStatus('已就绪');
  }
}

/** Handles the host's single init frame, which is what unlocks the UI. */
function onInit(data) {
  initialised = true;
  granted.clear();
  for (const p of data.granted || []) granted.add(p);
  applyGrants();
}

/** Renders a host response to a request we sent. */
function onResponse(data) {
  if (data.ok) return;
  if (data.error) appendLine('system', data.error);
}

/** Starts a new streamed reply and returns its holder. */
function beginReply(requestId) {
  const line = document.createElement('div');
  line.className = 'msg assistant streaming';
  const node = document.createTextNode('');
  line.appendChild(node);
  els.reply.appendChild(line);
  scrollToEnd();

  current = { requestId, node, line };
  return current;
}

/** Finalises the reply in flight and returns its text. */
function endReply() {
  if (!current) return '';
  current.line.classList.remove('streaming');
  const text = current.node.data;
  current = null;
  return text;
}

function onDelta(payload) {
  const requestId = payload && payload.requestId;
  const text = payload && payload.text;
  if (!text) return;
  if (!current) return;
  // A delta for a superseded request is dropped, never appended: with two
  // overlapping replies it would otherwise interleave into one paragraph.
  if (requestId && current.requestId && requestId !== current.requestId) return;

  current.node.data += text;
  scrollToEnd();
}

function onDone(payload) {
  const requestId = payload && payload.requestId;
  if (!current) return;
  if (requestId && current.requestId && requestId !== current.requestId) return;

  // The done frame carries the authoritative full text; using it repairs any
  // chunk that was dropped in flight.
  if (typeof payload.text === 'string' && payload.text) {
    current.node.data = payload.text;
  }
  lastReplyText = endReply();
}

function onError(payload) {
  const requestId = payload && payload.requestId;
  if (current && requestId && current.requestId && requestId !== current.requestId) return;
  endReply();
  appendLine('system', (payload && payload.message) || '对话失败');
}

function onEvent(data) {
  const payload = data.payload || {};
  switch (data.name) {
    case 'llm.delta':
      onDelta(payload);
      break;
    case 'llm.done':
      onDone(payload);
      break;
    case 'llm.error':
      onError(payload);
      break;
    default:
      // Unknown event names are ignored on purpose: the host may add names
      // before this plugin knows about them.
      break;
  }
}

function onMessage(event) {
  // Only the host may drive this iframe.
  if (event.source !== window.parent) return;
  const data = event.data;
  if (!data || data.v !== 1) return;

  switch (data.type) {
    case 'init':
      onInit(data);
      break;
    case 'response':
      onResponse(data);
      break;
    case 'event':
      onEvent(data);
      break;
    default:
      break;
  }
}

function sendPrompt() {
  const text = els.prompt.value.trim();
  if (!text) return;
  if (!granted.has(PERM_CHAT)) return;

  appendLine('user', text);
  els.prompt.value = '';
  lastReplyText = '';

  const requestId = nextId();
  beginReply(requestId);
  setStatus('正在回复…');
  request('llm.chat', { text, requestId });
}

function stopReply() {
  if (!current) return;
  endReply();
  setStatus('已停止');
}

function sayInBubble() {
  const line = (lastReplyText || '').split('\n')[0].trim();
  request('bubble.say', { text: line || '你好，我是对话插件。' });
}

function toggleSurface() {
  if (surfaceShown) {
    request('surface.hide', {});
    surfaceShown = false;
  } else {
    request('surface.show', {});
    surfaceShown = true;
  }
}

els.send.addEventListener('click', sendPrompt);
els.stop.addEventListener('click', stopReply);
els.bubble.addEventListener('click', sayInBubble);
els.surface.addEventListener('click', toggleSurface);
window.addEventListener('message', onMessage);

// Handshake step one. The host answers with exactly one `init`, and until it
// lands every control stays disabled.
applyGrants();
postToHost({ v: 1, type: 'ready' });
