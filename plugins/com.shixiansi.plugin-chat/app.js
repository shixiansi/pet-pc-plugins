// The conversation plugin's front end (1.1.0).
//
// It is a plain module loaded in a sandboxed iframe: it can address exactly one
// thing in the outside world, its parent, and only with the message types of
// the bridge protocol (ready / init / request / response / event). There is
// deliberately no fetch, no storage API and no file access - every capability
// goes through the host, which is also where the model key lives.
//
// ONE document serves FOUR appearances, and `applySurface` is the single place
// that decides which one:
//
//   surface.kind === 'panel'    the conversation slot (message list + composer)
//   surface.kind === 'surface'  a floating block, by surface.rectIndex:
//                                 0  the card      (.view-card)
//                                 1  the input bar (.view-bar)
//                                 2+ a bubble      (.view-bubble)
//
// The frame's geometry is NOT decided here: the host cropped the window to the
// rectangle it declared, so this file only fills the box it was given.

const els = {
  // The document's own <body> is the root appearance in a real frame; the
  // lookup is a NamedElement fallback so the same file also works in a harness
  // that mounts only the body's markup.
  root: document.getElementById('root') || document.body,
  reply: document.getElementById('reply'),
  prompt: document.getElementById('prompt'),
  status: document.getElementById('status'),
  send: document.getElementById('send'),
  stop: document.getElementById('stop'),
  bubble: document.getElementById('bubble'),
  surface: document.getElementById('surface'),
  hint: document.getElementById('hint'),
  dots: document.getElementById('dots'),
};

// Permission names, spelled once. A typo here would silently disable a control
// the user did grant.
const PERM_CHAT = 'llm.chat';
const PERM_BUBBLE = 'pet.bubble';
const PERM_SURFACE = 'pet.surface';

// The three appearances a floating block can take, in the order the manifest
// declares them. The first two are the rounded rectangles; everything after
// them is one of the thinking bubbles, which are ellipses.
const SHAPE_CARD = 'view-card';
const SHAPE_BAR = 'view-bar';
const SHAPE_BUBBLE = 'view-bubble';

// The storage key the transcript lives under. The host's storage.set/get take
// a key, not a path, so the plugin names its own file and the host keeps it in
// the plugin's private directory.
const HISTORY_KEY = 'llm-history';

let initialised = false;
const granted = new Set();

// What the host told us about this frame in `init`.
let surfaceKind = 'panel';
let surfaceRectIndex = 0;

// The reply currently being streamed. `node` is the single text node that the
// whole answer is appended into - it must outlive every delta, because
// rebuilding it per frame would discard and re-layout the text on each chunk.
let current = null;
// The text of the last finished reply, used as the bubble's line.
let lastReplyText = '';
// Whether this plugin believes its floating surface is on screen, so the
// button can toggle it rather than only ever ask for it.
let surfaceShown = false;
// The transcript, in the plugin's own private storage.
let history = [];
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

/** Appends a rendered line to the message list and scrolls it into view. */
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

/**
 * Chooses which of the four appearances this frame draws.
 *
 * The root class is the switch, and it is set on BOTH the <body> and the
 * document root so a stylesheet can key off it without depending on which
 * element it inherited from. `data-surface` carries the kind itself, which is
 * what keeps the three floating shapes distinguishable in a DOM dump.
 */
function applySurface(surface) {
  const kind = surface && surface.kind ? surface.kind : 'panel';
  surfaceKind = kind;
  let shape = 'view-panel';

  if (kind === 'surface') {
    surfaceRectIndex = Number(surface.rectIndex) || 0;
    if (surfaceRectIndex === 0) shape = SHAPE_CARD;
    else if (surfaceRectIndex === 1) shape = SHAPE_BAR;
    else shape = SHAPE_BUBBLE;
  } else {
    surfaceRectIndex = 0;
  }

  els.root.className = shape;
  els.root.dataset.surface = kind;
  els.root.dataset.shape = shape;
  document.documentElement.dataset.surface = kind;

  // Each floating block is one piece of the same document: the card carries the
  // transcript, the input bar carries only the composer, and a bubble carries
  // only its dot. The other pieces are hidden rather than removed, so switching
  // blocks never has to rebuild the markup.
  els.reply.hidden = shape === SHAPE_BAR || shape === SHAPE_BUBBLE;
  els.dots.hidden = shape !== SHAPE_BUBBLE;
  if (els.hint) els.hint.hidden = shape !== SHAPE_CARD;
  if (shape === SHAPE_BUBBLE) {
    // The bubble trail is three blocks; the current frame's index says which
    // dot it is. Keeping all three in the markup and lighting up one keeps the
    // document identical across the three frames.
    const dots = els.dots.querySelectorAll('i');
    const index = Math.max(0, surfaceRectIndex - 2);
    dots.forEach((dot, i) => {
      dot.className = i === index ? 'on' : '';
    });
  }
  if (shape === SHAPE_CARD) {
    renderHistory();
  }
  if (shape === SHAPE_BAR && els.prompt) {
    els.prompt.focus();
  }
}

/** Renders the stored transcript into the message list. */
function renderHistory() {
  const lines = Array.isArray(history) ? history : [];
  els.reply.replaceChildren();
  for (const item of lines) {
    if (!item || typeof item.text !== 'string') continue;
    appendLine(item.role === 'user' ? 'user' : 'assistant', item.text);
    if (item.role !== 'user') lastReplyText = item.text;
  }
}

/** Persists the transcript to the plugin's own storage. */
function saveHistory() {
  if (!granted.has('storage')) return;
  request('storage.set', { key: HISTORY_KEY, value: JSON.stringify(history) });
}

/** Replaces the transcript with a new turn pair. */
function remember(role, text) {
  history.push({ role, text });
  saveHistory();
}

/** Handles the host's single init frame, which is what unlocks the UI. */
function onInit(data) {
  initialised = true;
  granted.clear();
  for (const p of data.granted || []) granted.add(p);
  applySurface(data.surface || {});
  applyGrants();
  if (granted.has('storage')) loadHistory();
}

// The request id whose response carries the stored transcript, so its response
// can be told apart from any other reply.
let pendingHistory = null;

/** Reads the transcript out of the plugin's own storage. */
function loadHistory() {
  const id = request('storage.get', { key: HISTORY_KEY });
  if (id) pendingHistory = id;
}

/** Renders a host response to a request we sent. */
function onResponse(data) {
  if (data.id && data.id === pendingHistory) {
    pendingHistory = null;
    const value = data.ok ? (data.result && data.result.value) : '';
    try {
      const parsed = JSON.parse(value || '[]');
      if (Array.isArray(parsed)) {
        history = parsed;
        if (surfaceKind !== 'surface' || surfaceRectIndex === 0) renderHistory();
      }
    } catch {
      // A transcript the plugin itself cannot parse is treated as empty rather
      // than fatal: the next turn overwrites it anyway.
    }
    return;
  }
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

  current = { requestId, node, line, text: '' };
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

/** The accumulated text of the reply in flight, or ''. */
function pendingText() {
  return current ? current.node.data : '';
}

/**
 * Appends one streamed chunk.
 *
 * A chunk for a superseded request is dropped, never appended: with two
 * overlapping replies it would otherwise interleave into one paragraph.
 */
function onDelta(payload) {
  const requestId = payload && payload.requestId;
  const text = payload && payload.text;
  if (!text) return;
  if (!current) return;
  if (requestId && current.requestId && requestId !== current.requestId) return;

  current.node.data += text;
  current.text = current.node.data;
  scrollToEnd();
}

/**
 * Ends the reply with the AUTHORITATIVE full text.
 *
 * The done frame carries the whole answer, so when it disagrees with what the
 * deltas accumulated - a chunk dropped in flight, a retry that re-sent the
 * tail - the displayed text is REPLACED rather than appended to. Appending
 * would leave the duplicated fragment the frame exists to repair.
 */
function onDone(payload) {
  const requestId = payload && payload.requestId;
  if (!current) return;
  if (requestId && current.requestId && requestId !== current.requestId) return;

  const shown = current.node.data;
  const full = payload && typeof payload.text === 'string' ? payload.text : '';
  if (full && full !== shown) {
    current.node.data = full;
    current.text = full;
  }
  lastReplyText = endReply();
  if (lastReplyText) remember('assistant', lastReplyText);
}

/** Ends the reply with a visible reason. */
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
  remember('user', text);
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

/**
 * Asks the host to show or hide the floating surface.
 *
 * The plugin never places its own blocks: each one is a window region the host
 * cropped, so this only says whether the surface should be on screen. A plugin
 * whose surface permission was not granted cannot turn it on at all.
 */
function toggleSurface() {
  if (!granted.has(PERM_SURFACE)) return;
  if (surfaceShown) {
    request('surface.hide', {});
    surfaceShown = false;
  } else {
    request('surface.show', {});
    surfaceShown = true;
  }
}

if (els.send) els.send.addEventListener('click', sendPrompt);
if (els.stop) els.stop.addEventListener('click', stopReply);
if (els.bubble) els.bubble.addEventListener('click', sayInBubble);
if (els.surface) els.surface.addEventListener('click', toggleSurface);
if (els.prompt) {
  els.prompt.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendPrompt();
    }
  });
}
window.addEventListener('message', onMessage);

// Handshake step one. The host answers with exactly one `init`, and until it
// lands every control stays disabled.
applySurface({ kind: 'panel' });
applyGrants();
postToHost({ v: 1, type: 'ready' });
