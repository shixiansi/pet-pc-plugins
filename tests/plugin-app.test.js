import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Behaviour tests for the sample plugin's app.js, driven through the real
// panel.html markup in jsdom.
//
// They run the actual bridge protocol of plugin-system design.md 9.2 against a
// fake host: `parent` in jsdom IS the window, so a spy on window.postMessage is
// the host's inbox, and a dispatched MessageEvent with source=window is a frame
// the host sent. That covers the two things the M4 criteria care about and that
// reading the source cannot: that no request precedes `init`, and that the
// granted set decides which controls come up enabled.

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..', 'plugins', 'com.shixiansi.plugin-chat');
const appPath = path.join(pluginDir, 'app.js');
const panelPath = path.join(pluginDir, 'panel.html');

const html = readFileSync(panelPath, 'utf8');

let windowListeners = [];

function installPanel() {
  // innerHTML deliberately: script elements inserted that way never execute, so
  // this mounts the plugin's real markup without booting a second copy of app.js.
  const parsed = new JSDOM(html);
  document.body.innerHTML = parsed.window.document.body.innerHTML;
}

async function loadApp() {
  vi.resetModules();
  await import(appPath);
}

/** Every message app.js has posted to the host so far. */
function posted() {
  return window.postMessage.mock.calls.map((call) => call[0]);
}

function byType(type) {
  return posted().filter((m) => m && m.type === type);
}

/** Dispatch a frame from the host (source === window === parent in jsdom). */
function hostSends(data, { source = window } = {}) {
  window.dispatchEvent(new MessageEvent('message', { data, source }));
}

function initFrame(granted) {
  return {
    v: 1,
    type: 'init',
    pluginId: 'com.shixiansi.plugin-chat',
    permissions: ['llm.chat', 'pet.bubble', 'pet.surface'],
    granted,
    surface: { kind: 'panel' },
  };
}

/** Drive the plugin through a granted handshake and return the send button. */
async function handshake(granted = ['llm.chat', 'pet.bubble', 'pet.surface']) {
  hostSends(initFrame(granted));
  await Promise.resolve();
}

beforeEach(() => {
  installPanel();
  windowListeners = [];
  const originalAdd = window.addEventListener.bind(window);
  // Capture window-level listeners so each test starts with a clean window: the
  // module registry is reset between tests, but listeners live on the window.
  vi.spyOn(window, 'addEventListener').mockImplementation(function (type, fn, opts) {
    windowListeners.push([type, fn, opts]);
    return originalAdd(type, fn, opts);
  });
  vi.spyOn(window, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  for (const [type, fn, opts] of windowListeners) {
    window.removeEventListener(type, fn, opts);
  }
  windowListeners = [];
  vi.restoreAllMocks();
});

describe('handshake', () => {
  test('sends exactly one ready frame on load and nothing else', async () => {
    await loadApp();

    expect(byType('ready')).toHaveLength(1);
    expect(byType('ready')[0]).toEqual({ v: 1, type: 'ready' });
    expect(byType('request')).toHaveLength(0);
  });

  test('sends no request before init even if send is clicked', async () => {
    await loadApp();

    document.getElementById('send').click();
    document.getElementById('stop').click();

    expect(byType('request')).toHaveLength(0);
  });

  test('ignores frames that are not version 1 and frames from a foreign source', async () => {
    await loadApp();

    hostSends({ v: 2, type: 'init', granted: ['llm.chat'] });
    const foreign = new JSDOM('<!doctype html><html><body></body></html>').window;
    hostSends(initFrame([]), { source: foreign });

    // Neither frame was treated as the host's init: the input stays disabled.
    expect(document.getElementById('prompt').disabled).toBe(true);
    expect(byType('request')).toHaveLength(0);
  });
});

describe('granted-driven UI', () => {
  test('enables the input and send only when llm.chat is granted', async () => {
    await loadApp();
    await handshake([]);

    const prompt = document.getElementById('prompt');
    expect(prompt.disabled).toBe(true);
    expect(document.getElementById('send').disabled).toBe(true);
    expect(document.getElementById('status').textContent).toContain('未获授权：llm.chat');
  });

  test('enables the input and send when llm.chat is granted', async () => {
    await loadApp();
    await handshake(['llm.chat']);

    expect(document.getElementById('prompt').disabled).toBe(false);
    expect(document.getElementById('send').disabled).toBe(false);
    expect(document.getElementById('status').textContent).not.toContain('未获授权：llm.chat');
  });

  test('disables the bubble button without pet.bubble and the surface button without pet.surface', async () => {
    await loadApp();
    await handshake(['llm.chat']);

    expect(document.getElementById('bubble').disabled).toBe(true);
    expect(document.getElementById('surface').disabled).toBe(true);
  });

  test('enables the bubble and surface buttons when granted', async () => {
    await loadApp();
    await handshake();

    expect(document.getElementById('bubble').disabled).toBe(false);
    expect(document.getElementById('surface').disabled).toBe(false);
  });
});

describe('llm.chat', () => {
  async function ask(text = '你好') {
    await loadApp();
    await handshake();
    const prompt = document.getElementById('prompt');
    prompt.value = text;
    document.getElementById('send').click();
    const [request] = byType('request');
    return request;
  }

  test('sends a well-formed request carrying the prompt and a requestId', async () => {
    const request = await ask('你好');

    expect(request.v).toBe(1);
    expect(request.type).toBe('request');
    expect(typeof request.id).toBe('string');
    expect(request.id.length).toBeGreaterThan(0);
    expect(request.method).toBe('llm.chat');
    expect(request.payload.text).toBe('你好');
    expect(typeof request.payload.requestId).toBe('string');
    expect(request.payload.requestId.length).toBeGreaterThan(0);
  });

  test('appends deltas into one text node that survives the whole reply', async () => {
    const request = await ask();
    const { requestId } = request.payload;

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '你' } });
    const container = document.querySelector('#reply .msg.assistant');
    const original = container.childNodes[0];
    expect(original.nodeType).toBe(3);
    expect(original.data).toBe('你');

    for (const chunk of ['好', '，', '世界']) {
      hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: chunk } });
    }

    expect(container.childNodes).toHaveLength(1);
    expect(container.childNodes[0]).toBe(original);
    expect(container.childNodes[0].data).toBe('你好，世界');
  });

  test('drops a late delta whose requestId is not the current one', async () => {
    const request = await ask();
    const { requestId } = request.payload;

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '当前' } });
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId: 'stale-id', text: '过期' } });

    const container = document.querySelector('#reply .msg.assistant');
    expect(container.textContent).toBe('当前');
  });

  test('renders llm.error as a system line', async () => {
    const request = await ask();
    const { requestId } = request.payload;

    hostSends({
      v: 1,
      type: 'event',
      name: 'llm.error',
      payload: { requestId, message: '宿主未配置大模型' },
    });

    const system = document.querySelector('#reply .msg.system');
    expect(system).not.toBeNull();
    expect(system.textContent).toContain('宿主未配置大模型');
  });

  test('finalises on llm.done using the authoritative full text', async () => {
    const request = await ask();
    const { requestId } = request.payload;

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '半' } });
    hostSends({ v: 1, type: 'event', name: 'llm.done', payload: { requestId, text: '半句话。' } });

    const container = document.querySelector('#reply .msg.assistant');
    expect(container.textContent).toBe('半句话。');

    // The reply is over, so a delta that arrives now is stale and must be dropped.
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '多余' } });
    expect(container.textContent).toBe('半句话。');
  });
});

describe('bubble and surface', () => {
  test('bubble.say carries the first line of the reply', async () => {
    await loadApp();
    await handshake();
    const request = (() => {
      document.getElementById('prompt').value = '写点东西';
      document.getElementById('send').click();
      return byType('request')[0];
    })();
    const { requestId } = request.payload;

    hostSends({
      v: 1,
      type: 'event',
      name: 'llm.done',
      payload: { requestId, text: '第一行\n第二行' },
    });

    document.getElementById('bubble').click();

    const bubble = byType('request').find((r) => r.method === 'bubble.say');
    expect(bubble).toBeDefined();
    expect(bubble.payload.text).toBe('第一行');
  });

  test('the surface button toggles surface.show and surface.hide', async () => {
    await loadApp();
    await handshake();
    const button = document.getElementById('surface');

    button.click();
    expect(byType('request').map((r) => r.method)).toContain('surface.show');

    button.click();
    expect(byType('request').map((r) => r.method)).toContain('surface.hide');
  });

  test('stop abandons the reply, so its later deltas are dropped', async () => {
    await loadApp();
    await handshake();
    document.getElementById('prompt').value = '你好';
    document.getElementById('send').click();
    const { requestId } = byType('request')[0].payload;

    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '之一' } });
    document.getElementById('stop').click();
    hostSends({ v: 1, type: 'event', name: 'llm.delta', payload: { requestId, text: '之二' } });

    expect(document.querySelector('#reply .msg.assistant').textContent).toBe('之一');
  });
});

describe('capability hygiene', () => {
  test('app.js uses no fetch, no localStorage and no file APIs', () => {
    const src = readFileSync(appPath, 'utf8');
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/\blocalStorage\b/);
    expect(src).not.toMatch(/\bsessionStorage\b/);
    expect(src).not.toMatch(/\bXMLHttpRequest\b/);
  });
});
