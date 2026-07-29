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
    lora: {
      adapters: [], // [{id, path, scale}], mirrors GET /lora-adapters
    },
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
    modelDetails: document.getElementById('model-details'),
    chatTemplateDetails: document.getElementById('chat-template-details'),
    chatTemplate: document.getElementById('chat-template'),
    systemPrompt: document.getElementById('system-prompt'),
    sTemperature: document.getElementById('s-temperature'),
    sTopP: document.getElementById('s-top-p'),
    sTopK: document.getElementById('s-top-k'),
    sMinP: document.getElementById('s-min-p'),
    sRepeatPenalty: document.getElementById('s-repeat-penalty'),
    sPresencePenalty: document.getElementById('s-presence-penalty'),
    sFrequencyPenalty: document.getElementById('s-frequency-penalty'),
    sMaxTokens: document.getElementById('s-max-tokens'),
    sSeed: document.getElementById('s-seed'),
    sStop: document.getElementById('s-stop'),
    sGrammar: document.getElementById('s-grammar'),
    sJsonSchema: document.getElementById('s-json-schema'),
    loraMode: document.getElementById('lora-mode'),
    loraBypass: document.getElementById('lora-bypass'),
    loraList: document.getElementById('lora-list'),
    loraLoadPaths: document.getElementById('lora-load-paths'),
    restartLoraBtn: document.getElementById('btn-restart-lora'),
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

  function formatParamCount(n) {
    if (typeof n !== 'number') return null;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    return String(n);
  }

  // The REST API doesn't expose GGUF-level architecture/quant-type/BOS-EOS metadata, so
  // quant type is a best-effort guess from the filename's own naming convention (e.g.
  // "...-Q4_K_M.gguf") - not authoritative, just better than nothing.
  function guessQuantFromFilename(name) {
    const m = name.match(/\b(Q\d[_A-Z0-9]*|F16|F32|BF16)\b/i);
    return m ? m[1].toUpperCase() : null;
  }

  async function fetchModelDetails() {
    let props = null;
    let modelsResp = null;
    try {
      const res = await fetch(`${baseUrl()}/props`);
      if (res.ok) props = await res.json();
    } catch (err) {
      // degrade below
    }
    try {
      const res = await fetch(`${baseUrl()}/v1/models`);
      if (res.ok) modelsResp = await res.json();
    } catch (err) {
      // degrade below
    }

    const meta = modelsResp && modelsResp.data && modelsResp.data[0] && modelsResp.data[0].meta;
    const modelPath = props && props.model_path;
    const name = (modelPath || '').split('/').pop() || '(unknown)';
    const quant = guessQuantFromFilename(name);
    const nParams = meta && formatParamCount(meta.n_params);

    const lines = [`name: ${name}`];
    if (props && props.default_generation_settings) {
      lines.push(`n_ctx: ${props.default_generation_settings.n_ctx}`);
    }
    lines.push(`n_params: ${nParams || 'n/a'}`);
    lines.push(`n_vocab: ${meta && typeof meta.n_vocab === 'number' ? meta.n_vocab : 'n/a'}`);
    lines.push(`quant: ${quant || 'n/a (not exposed by server; guessed from filename)'}`);
    lines.push('arch: n/a (not exposed by server)');
    lines.push('BOS/EOS: n/a (not exposed by server)');
    el.modelDetails.textContent = lines.join('\n');

    if (props && props.chat_template) {
      el.chatTemplate.textContent = props.chat_template;
      el.chatTemplateDetails.hidden = false;
    } else {
      el.chatTemplateDetails.hidden = true;
    }
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
  // Sampler params
  // ---------------------------------------------------------------------
  function buildSamplerParams() {
    const params = {};
    const num = (input, key, parser) => {
      const v = parser(input.value);
      if (!Number.isNaN(v)) params[key] = v;
    };
    num(el.sTemperature, 'temperature', parseFloat);
    num(el.sTopP, 'top_p', parseFloat);
    num(el.sTopK, 'top_k', (v) => parseInt(v, 10));
    num(el.sMinP, 'min_p', parseFloat);
    num(el.sRepeatPenalty, 'repeat_penalty', parseFloat);
    num(el.sPresencePenalty, 'presence_penalty', parseFloat);
    num(el.sFrequencyPenalty, 'frequency_penalty', parseFloat);
    num(el.sMaxTokens, 'max_tokens', (v) => parseInt(v, 10));
    num(el.sSeed, 'seed', (v) => parseInt(v, 10));

    const stopText = el.sStop.value.trim();
    if (stopText) {
      params.stop = stopText.split(',').map((s) => s.trim()).filter(Boolean);
    }

    // Mutually exclusive: grammar wins if both are somehow non-empty (the input handlers
    // below keep them from both having content in practice).
    const grammar = el.sGrammar.value.trim();
    const jsonSchemaText = el.sJsonSchema.value.trim();
    if (grammar) {
      params.grammar = grammar;
    } else if (jsonSchemaText) {
      try {
        params.json_schema = JSON.parse(jsonSchemaText);
      } catch (err) {
        // Invalid JSON - drop rather than send a request the server will just reject.
      }
    }

    if (el.loraMode.value === 'per-request' && state.lora.adapters.length > 0) {
      params.lora = effectiveLoraArray();
    }

    return params;
  }

  el.sGrammar.addEventListener('input', () => {
    if (el.sGrammar.value.trim()) el.sJsonSchema.value = '';
  });
  el.sJsonSchema.addEventListener('input', () => {
    if (el.sJsonSchema.value.trim()) el.sGrammar.value = '';
  });

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
      const systemPrompt = el.systemPrompt.value.trim();
      const requestMessages = systemPrompt
        ? [{ role: 'system', content: systemPrompt }, ...state.messages]
        : state.messages;
      const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'local',
          messages: requestMessages,
          stream: true,
          stream_options: { include_usage: true },
          ...buildSamplerParams(),
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
      fetchModelDetails();
      fetchLoraAdapters();
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

  function parseLoraLoadPaths(text) {
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        // "path:scale" - guard against paths that happen to contain ':' by only treating
        // it as a separator when what follows actually parses as a number.
        const idx = line.lastIndexOf(':');
        if (idx > 0) {
          const maybeScale = parseFloat(line.slice(idx + 1));
          if (!Number.isNaN(maybeScale)) {
            return { path: line.slice(0, idx), scale: maybeScale };
          }
        }
        return { path: line, scale: null };
      });
  }

  function buildStartConfig() {
    return {
      modelPath: el.modelPath.value.trim(),
      port: parseInt(el.port.value, 10) || 8080,
      contextSize: parseInt(el.ctxSize.value, 10) || 4096,
      ngl: parseInt(el.ngl.value, 10) || 99,
      lora: parseLoraLoadPaths(el.loraLoadPaths.value),
    };
  }

  el.startBtn.addEventListener('click', () => {
    callBridge('startServer', JSON.stringify(buildStartConfig()));
    pollStatus();
  });

  el.stopServerBtn.addEventListener('click', () => {
    callBridge('stopServer');
    setTimeout(pollStatus, 300);
  });

  el.restartLoraBtn.addEventListener('click', () => {
    callBridge('startServer', JSON.stringify(buildStartConfig()));
    pollStatus();
  });

  // ---------------------------------------------------------------------
  // LoRA adapters
  // ---------------------------------------------------------------------
  function effectiveLoraArray() {
    if (el.loraBypass.checked) {
      return state.lora.adapters.map((a) => ({ id: a.id, scale: 0 }));
    }
    return state.lora.adapters.map((a) => ({ id: a.id, scale: a.scale }));
  }

  async function applyGlobalLoraScales() {
    if (state.lora.adapters.length === 0) return;
    try {
      await fetch(`${baseUrl()}/lora-adapters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(effectiveLoraArray()),
      });
    } catch (err) {
      // Best-effort - if this fails the scales just stay whatever they were server-side.
    }
  }

  function renderLoraRows() {
    el.loraList.innerHTML = '';
    if (state.lora.adapters.length === 0) {
      el.loraList.textContent = '(no adapters loaded - list paths below and restart)';
      return;
    }
    for (const adapter of state.lora.adapters) {
      const row = document.createElement('div');
      row.className = 'lora-row';
      const name = adapter.path.split('/').pop();
      row.innerHTML =
        `<span class="lora-name" title="${adapter.path}">${name}</span>` +
        `<input type="range" min="0" max="1.5" step="0.05" value="${adapter.scale}" />` +
        `<span class="lora-value">${adapter.scale.toFixed(2)}</span>`;
      const slider = row.querySelector('input[type="range"]');
      const valueLabel = row.querySelector('.lora-value');
      slider.addEventListener('input', () => {
        valueLabel.textContent = parseFloat(slider.value).toFixed(2);
      });
      slider.addEventListener('change', () => {
        adapter.scale = parseFloat(slider.value);
        saveSettings();
        if (el.loraMode.value === 'global') applyGlobalLoraScales();
      });
      el.loraList.appendChild(row);
    }
  }

  async function fetchLoraAdapters() {
    try {
      const res = await fetch(`${baseUrl()}/lora-adapters`);
      if (!res.ok) {
        state.lora.adapters = [];
        renderLoraRows();
        return;
      }
      const adapters = await res.json();
      const persisted = state.persistedLoraScales || [];
      state.lora.adapters = adapters.map((a) => {
        const saved = persisted.find((p) => p.path === a.path);
        return { id: a.id, path: a.path, scale: saved ? saved.scale : a.scale };
      });
    } catch (err) {
      state.lora.adapters = [];
    }
    renderLoraRows();
  }

  el.loraMode.addEventListener('change', () => {
    saveSettings();
    if (el.loraMode.value === 'global') applyGlobalLoraScales();
  });
  el.loraBypass.addEventListener('change', () => {
    saveSettings();
    if (el.loraMode.value === 'global') applyGlobalLoraScales();
  });

  // ---------------------------------------------------------------------
  // Persistence (localStorage)
  // ---------------------------------------------------------------------
  const SETTINGS_KEY = 'llama_webview_settings_v1';

  function saveSettings() {
    const settings = {
      systemPrompt: el.systemPrompt.value,
      modelPath: el.modelPath.value,
      port: el.port.value,
      ctxSize: el.ctxSize.value,
      ngl: el.ngl.value,
      temperature: el.sTemperature.value,
      topP: el.sTopP.value,
      topK: el.sTopK.value,
      minP: el.sMinP.value,
      repeatPenalty: el.sRepeatPenalty.value,
      presencePenalty: el.sPresencePenalty.value,
      frequencyPenalty: el.sFrequencyPenalty.value,
      maxTokens: el.sMaxTokens.value,
      seed: el.sSeed.value,
      stop: el.sStop.value,
      grammar: el.sGrammar.value,
      jsonSchema: el.sJsonSchema.value,
      loraMode: el.loraMode.value,
      loraBypass: el.loraBypass.checked,
      loraLoadPaths: el.loraLoadPaths.value,
      loraScales: state.lora.adapters.map((a) => ({ path: a.path, scale: a.scale })),
    };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (err) {
      // localStorage unavailable - settings just won't survive a restart.
    }
  }

  function loadAndApplySettings() {
    let settings = {};
    try {
      settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    } catch (err) {
      settings = {};
    }
    if (settings.systemPrompt !== undefined) el.systemPrompt.value = settings.systemPrompt;
    if (settings.modelPath) el.modelPath.value = settings.modelPath;
    if (settings.port) el.port.value = settings.port;
    if (settings.ctxSize) el.ctxSize.value = settings.ctxSize;
    if (settings.ngl) el.ngl.value = settings.ngl;
    if (settings.temperature !== undefined) el.sTemperature.value = settings.temperature;
    if (settings.topP !== undefined) el.sTopP.value = settings.topP;
    if (settings.topK !== undefined) el.sTopK.value = settings.topK;
    if (settings.minP !== undefined) el.sMinP.value = settings.minP;
    if (settings.repeatPenalty !== undefined) el.sRepeatPenalty.value = settings.repeatPenalty;
    if (settings.presencePenalty !== undefined) el.sPresencePenalty.value = settings.presencePenalty;
    if (settings.frequencyPenalty !== undefined) el.sFrequencyPenalty.value = settings.frequencyPenalty;
    if (settings.maxTokens !== undefined) el.sMaxTokens.value = settings.maxTokens;
    if (settings.seed !== undefined) el.sSeed.value = settings.seed;
    if (settings.stop !== undefined) el.sStop.value = settings.stop;
    if (settings.grammar !== undefined) el.sGrammar.value = settings.grammar;
    if (settings.jsonSchema !== undefined) el.sJsonSchema.value = settings.jsonSchema;
    if (settings.loraMode) el.loraMode.value = settings.loraMode;
    if (settings.loraBypass) el.loraBypass.checked = settings.loraBypass;
    if (settings.loraLoadPaths !== undefined) el.loraLoadPaths.value = settings.loraLoadPaths;
    state.persistedLoraScales = settings.loraScales || [];
  }

  // Save on blur/commit (not every keystroke) for text-ish fields, and immediately for
  // discrete controls (select/checkbox) that don't have a separate "input" event.
  [
    el.systemPrompt, el.modelPath, el.port, el.ctxSize, el.ngl,
    el.sTemperature, el.sTopP, el.sTopK, el.sMinP, el.sRepeatPenalty,
    el.sPresencePenalty, el.sFrequencyPenalty, el.sMaxTokens, el.sSeed,
    el.sStop, el.sGrammar, el.sJsonSchema, el.loraLoadPaths,
  ].forEach((input) => input.addEventListener('change', saveSettings));

  loadAndApplySettings();

  // Restore the models directory picked in a previous session (persisted natively) instead
  // of requiring the user to re-pick it every launch.
  const savedModelsDir = callBridge('getModelsDir');
  if (savedModelsDir) {
    el.modelsDirLabel.textContent = savedModelsDir;
    renderModelList();
  }

  pollStatus();
})();
