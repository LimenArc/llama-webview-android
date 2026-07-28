(function () {
  'use strict';

  const state = {
    port: 8080,
    nCtx: null,
    modelName: null,
    totalTokensUsed: 0,
    messages: [],
    streaming: false,
    abortController: null,
  };

  const el = {
    messages: document.getElementById('messages'),
    composerForm: document.getElementById('composer'),
    composerInput: document.getElementById('composer-input'),
    sendBtn: document.getElementById('send-btn'),
    stopBtn: document.getElementById('stop-btn'),
    contextBar: document.getElementById('context-bar'),
    togglePanel: document.getElementById('toggle-panel'),
    hidePanelBtn: document.getElementById('btn-hide-panel'),
    showPanelBtn: document.getElementById('btn-show-panel'),
    sidePanel: document.getElementById('side-panel'),
    modelPath: document.getElementById('model-path'),
    port: document.getElementById('port'),
    ctxSize: document.getElementById('ctx-size'),
    ngl: document.getElementById('ngl'),
    startBtn: document.getElementById('btn-start-server'),
    stopServerBtn: document.getElementById('btn-stop-server'),
    status: document.getElementById('status'),
    log: document.getElementById('log'),
    pickDirBtn: document.getElementById('btn-pick-dir'),
    refreshModelsBtn: document.getElementById('btn-refresh-models'),
    modelList: document.getElementById('model-list'),
    modelsDirLabel: document.getElementById('models-dir-label'),
  };

  function callBridge(name, ...args) {
    try {
      if (!window.Native || typeof window.Native[name] !== 'function') {
        console.warn('Native.' + name + ' is not available');
        return undefined;
      }
      return window.Native[name](...args);
    } catch (err) {
      console.warn('error calling Native.' + name + ': ' + err);
      return undefined;
    }
  }

  function baseUrl() {
    return `http://127.0.0.1:${state.port}`;
  }

  // ---------------------------------------------------------------------
  // Streaming <think>/</think> tag parser - used only when the server never
  // sends a native reasoning_content field. Tags can be split across chunk
  // boundaries, so partial matches at the end of a chunk are held back
  // until enough of the next chunk arrives to resolve them.
  // ---------------------------------------------------------------------
  function createThinkTagParser(onReasoning, onAnswer) {
    const OPEN = '<think>';
    const CLOSE = '</think>';
    let buffer = '';
    let mode = 'normal';

    function longestSafeSuffix(str, tag) {
      const maxLen = Math.min(str.length, tag.length - 1);
      for (let len = maxLen; len > 0; len--) {
        if (str.slice(str.length - len) === tag.slice(0, len)) return len;
      }
      return 0;
    }

    function feed(chunk) {
      buffer += chunk;
      for (;;) {
        const tag = mode === 'normal' ? OPEN : CLOSE;
        const emit = mode === 'normal' ? onAnswer : onReasoning;
        const idx = buffer.indexOf(tag);
        if (idx === -1) {
          const safe = longestSafeSuffix(buffer, tag);
          if (safe < buffer.length) emit(buffer.slice(0, buffer.length - safe));
          buffer = buffer.slice(buffer.length - safe);
          return;
        }
        if (idx > 0) emit(buffer.slice(0, idx));
        buffer = buffer.slice(idx + tag.length);
        mode = mode === 'normal' ? 'reasoning' : 'normal';
      }
    }

    function flush() {
      if (!buffer) return;
      (mode === 'reasoning' ? onReasoning : onAnswer)(buffer);
      buffer = '';
    }

    return { feed, flush };
  }

  // ---------------------------------------------------------------------
  // Context bar / model props
  // ---------------------------------------------------------------------
  async function refreshProps() {
    try {
      const res = await fetch(`${baseUrl()}/props`);
      if (!res.ok) return;
      const props = await res.json();
      state.nCtx = (props.default_generation_settings && props.default_generation_settings.n_ctx) || null;
      state.modelName = (props.model_path || '').split('/').pop() || null;
    } catch (err) {
      // /props not available on this build - context bar just degrades to token count only.
    }
    renderContextBar();
  }

  function renderContextBar() {
    if (state.nCtx) {
      el.contextBar.textContent = `${state.modelName ? state.modelName + ' · ' : ''}${state.totalTokensUsed} / ${state.nCtx} tokens`;
    } else if (state.modelName) {
      el.contextBar.textContent = `${state.modelName} · ${state.totalTokensUsed} tokens used`;
    } else {
      el.contextBar.textContent = state.totalTokensUsed ? `${state.totalTokensUsed} tokens used` : 'not connected';
    }
  }

  // ---------------------------------------------------------------------
  // Message rendering
  // ---------------------------------------------------------------------
  function appendMessage(role, initialContent) {
    const wrapper = document.createElement('div');
    wrapper.className = `msg msg-${role}`;
    if (role === 'assistant') {
      wrapper.innerHTML =
        '<details class="reasoning" hidden><summary>Reasoning</summary><div class="reasoning-body"></div></details>' +
        '<div class="answer-body"></div>' +
        '<div class="timings"></div>';
    } else {
      wrapper.innerHTML = '<div class="answer-body"></div>';
    }
    wrapper.querySelector('.answer-body').textContent = initialContent || '';
    el.messages.appendChild(wrapper);
    scrollToBottom();
    return wrapper;
  }

  function scrollToBottom() {
    el.messages.scrollTop = el.messages.scrollHeight;
  }

  function formatTimings(ttftMs, usage, timings) {
    const parts = [];
    if (ttftMs !== null) parts.push(`TTFT ${Math.round(ttftMs)}ms`);
    if (usage) {
      parts.push(`${usage.prompt_tokens}→${usage.completion_tokens} tok (${usage.total_tokens} total)`);
    }
    if (timings) {
      if (typeof timings.prompt_per_second === 'number') {
        parts.push(`prompt ${timings.prompt_per_second.toFixed(1)} tok/s`);
      }
      if (typeof timings.predicted_per_second === 'number') {
        parts.push(`eval ${timings.predicted_per_second.toFixed(1)} tok/s`);
      }
    }
    return parts.join(' · ');
  }

  // ---------------------------------------------------------------------
  // Chat send / SSE stream
  // ---------------------------------------------------------------------
  function setStreaming(streaming) {
    state.streaming = streaming;
    el.sendBtn.hidden = streaming;
    el.stopBtn.hidden = !streaming;
  }

  async function sendMessage(text) {
    if (!text.trim() || state.streaming) return;

    state.messages.push({ role: 'user', content: text });
    appendMessage('user', text);

    const assistantEl = appendMessage('assistant', '');
    const reasoningDetails = assistantEl.querySelector('.reasoning');
    const reasoningBody = assistantEl.querySelector('.reasoning-body');
    const answerBody = assistantEl.querySelector('.answer-body');
    const timingsEl = assistantEl.querySelector('.timings');

    let answerText = '';
    let usedNativeReasoning = false;
    let ttftMs = null;
    const t0 = performance.now();

    function noteFirstToken() {
      if (ttftMs === null) ttftMs = performance.now() - t0;
    }
    function handleAnswer(chunk) {
      answerText += chunk;
      answerBody.textContent = answerText;
      scrollToBottom();
    }
    function handleReasoning(chunk) {
      reasoningDetails.hidden = false;
      reasoningBody.textContent += chunk;
      scrollToBottom();
    }

    const thinkParser = createThinkTagParser(handleReasoning, handleAnswer);

    setStreaming(true);
    let usage = null;
    let timings = null;
    try {
      state.abortController = new AbortController();
      const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'local',
          messages: state.messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: state.abortController.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`server responded ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      readLoop:
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') break readLoop;
          let obj;
          try {
            obj = JSON.parse(data);
          } catch (e) {
            continue;
          }
          const choice = obj.choices && obj.choices[0];
          const delta = choice && choice.delta;
          if (delta && delta.reasoning_content) {
            usedNativeReasoning = true;
            noteFirstToken();
            handleReasoning(delta.reasoning_content);
          }
          if (delta && delta.content) {
            noteFirstToken();
            if (usedNativeReasoning) {
              handleAnswer(delta.content);
            } else {
              thinkParser.feed(delta.content);
            }
          }
          if (obj.usage) usage = obj.usage;
          if (obj.timings) timings = obj.timings;
        }
      }
      thinkParser.flush();

      if (usage) {
        state.totalTokensUsed = usage.total_tokens;
        renderContextBar();
      }
      timingsEl.textContent = formatTimings(ttftMs, usage, timings);
      state.messages.push({ role: 'assistant', content: answerText });
    } catch (err) {
      if (err.name === 'AbortError') {
        timingsEl.textContent = 'stopped';
        // Whatever text streamed in before the abort is still a legitimate partial
        // turn - keep it in history so the next request has correct context.
        if (answerText) state.messages.push({ role: 'assistant', content: answerText });
      } else {
        timingsEl.textContent = `error: ${err.message}`;
        timingsEl.classList.add('error');
        // No assistant turn recorded on a hard error: nothing coherent was produced,
        // so don't pollute history with an empty/broken assistant message.
      }
    } finally {
      setStreaming(false);
      state.abortController = null;
    }
  }

  el.stopBtn.addEventListener('click', () => {
    if (state.abortController) state.abortController.abort();
  });

  el.composerForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.composerInput.value;
    el.composerInput.value = '';
    autoResize();
    sendMessage(text);
  });

  el.composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el.composerForm.requestSubmit();
    }
  });

  function autoResize() {
    el.composerInput.style.height = 'auto';
    el.composerInput.style.height = Math.min(el.composerInput.scrollHeight, 200) + 'px';
  }
  el.composerInput.addEventListener('input', autoResize);

  el.togglePanel.addEventListener('click', () => {
    el.sidePanel.classList.toggle('collapsed');
  });

  // Extra, more reachable panel controls: one next to Start/Stop (to get back to a
  // full-width chat), one in the composer (to get back to the panel from there). Both just
  // drive the same "collapsed" class the topbar button already uses.
  el.hidePanelBtn.addEventListener('click', () => {
    el.sidePanel.classList.add('collapsed');
  });
  el.showPanelBtn.addEventListener('click', () => {
    el.sidePanel.classList.remove('collapsed');
  });

  // ---------------------------------------------------------------------
  // Server panel (models directory picking, model list, start/stop, status)
  // ---------------------------------------------------------------------
  function renderModelList() {
    const raw = callBridge('listModels');
    let models = [];
    try {
      models = JSON.parse(raw || '[]');
    } catch (e) {
      // ignore
    }
    el.modelList.innerHTML = '';
    if (models.length === 0) {
      el.modelList.innerHTML = '<li style="cursor:default;color:var(--dim);">no .gguf files found</li>';
      return;
    }
    for (const m of models) {
      const li = document.createElement('li');
      const mb = (m.sizeBytes / (1024 * 1024)).toFixed(1);
      li.textContent = `${m.name} (${mb} MB)`;
      li.title = m.path;
      li.addEventListener('click', () => {
        el.modelPath.value = m.path;
      });
      el.modelList.appendChild(li);
    }
  }

  window.onModelsDirPicked = function (result) {
    if (result && result.path) {
      el.modelsDirLabel.textContent = result.path;
      el.modelsDirLabel.classList.remove('fail');
      renderModelList();
    } else {
      el.modelsDirLabel.textContent = 'error: ' + (result && result.error ? result.error : 'unknown');
      el.modelsDirLabel.classList.add('fail');
    }
  };

  el.pickDirBtn.addEventListener('click', () => callBridge('pickModelsDir'));
  el.refreshModelsBtn.addEventListener('click', renderModelList);

  let pollHandle = null;
  let lastState = null;

  function pollStatus() {
    const raw = callBridge('serverStatus');
    let status;
    try {
      status = JSON.parse(raw);
    } catch (e) {
      return;
    }

    el.status.textContent = JSON.stringify(status, null, 2);
    el.status.className = 'state-' + status.state;
    el.log.textContent = callBridge('getLog') || '';

    if (status.port) state.port = status.port;

    if (status.state === 'running' && lastState !== 'running') {
      refreshProps();
    }
    if (status.state !== 'running') {
      state.nCtx = null;
      state.modelName = null;
      renderContextBar();
    }
    lastState = status.state;

    if (status.state === 'starting') {
      if (!pollHandle) pollHandle = setInterval(pollStatus, 700);
    } else if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  el.startBtn.addEventListener('click', () => {
    const config = {
      modelPath: el.modelPath.value.trim(),
      port: parseInt(el.port.value, 10) || 8080,
      contextSize: parseInt(el.ctxSize.value, 10) || 4096,
      ngl: parseInt(el.ngl.value, 10) || 99,
    };
    callBridge('startServer', JSON.stringify(config));
    pollStatus();
  });

  el.stopServerBtn.addEventListener('click', () => {
    callBridge('stopServer');
    setTimeout(pollStatus, 300);
  });

  pollStatus();
})();
