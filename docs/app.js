/* Amplifier — free sound amplifier PWA for iPhone.
 * Signal chain:
 *   source (mic | file) → downmix → low-cut → noise gate → 10-band EQ → clarity
 *   → boost → compressor → balance → limiter → mute → analyser → speakers/headphones
 *                                                              ↘ recorder
 */
(() => {
  'use strict';

  // ---------- constants ----------
  const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const FLAT = EQ_FREQS.map(() => 0);
  const DEFAULTS = {
    boost: 12, balance: 0, clarity: 0, eq: FLAT, lowcut: 80, gate: -55,
    noiseReduction: false, compressor: true, limit: -3,
    echo: false, ns: false, agc: false, wake: true, mono: false, preset: 'Normal',
  };
  const BUILTIN_PRESETS = {
    'Normal':        { boost: 12, eq: FLAT, clarity: 0, lowcut: 80, noiseReduction: false },
    'Hearing boost': { boost: 22, eq: [-2,-2,-1,0,1,3,5,6,5,2], clarity: 4, lowcut: 120, noiseReduction: true },
    'Speech':        { boost: 16, eq: [-6,-5,-3,-1,1,4,6,5,2,-2], clarity: 6, lowcut: 200, noiseReduction: true },
    'TV':            { boost: 18, eq: [-2,-1,0,0,1,3,4,3,1,0], clarity: 3, lowcut: 100, noiseReduction: false },
    'Whisper':       { boost: 32, eq: [-4,-3,-2,0,2,4,6,6,4,0], clarity: 6, lowcut: 150, noiseReduction: true, gate: -50 },
    'Music':         { boost: 10, eq: [4,3,1,0,-1,0,1,2,3,3], clarity: 0, lowcut: 20, noiseReduction: false },
    'Bass boost':    { boost: 10, eq: [8,7,5,2,0,0,0,0,0,0], clarity: 0, lowcut: 20, noiseReduction: false },
    'Night':         { boost: 8, eq: [-3,-2,-1,0,0,1,2,1,0,-2], clarity: 2, lowcut: 100, noiseReduction: true },
  };

  // ---------- storage ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } },
  };
  const S = Object.assign({}, DEFAULTS, store.get('amp.settings', {}));
  if (!Array.isArray(S.eq) || S.eq.length !== EQ_FREQS.length) S.eq = FLAT.slice();
  let customPresets = store.get('amp.presets', {});
  const save = () => store.set('amp.settings', S);

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {
    status: $('status'), power: $('power'), powerLabel: $('power-label'),
    volume: $('volume'), volumeVal: $('volume-val'),
    balance: $('balance'), balanceVal: $('balance-val'),
    clarity: $('clarity'), clarityVal: $('clarity-val'),
    nr: $('noise-reduction'), comp: $('compressor-on'), mute: $('mute'),
    record: $('record'), viz: $('viz'), meterFill: $('meter-fill'), meterDb: $('meter-db'),
    presets: $('presets'), eq: $('eq'), eqReset: $('eq-reset'),
    lowcut: $('lowcut'), lowcutVal: $('lowcut-val'), gate: $('gate'), gateVal: $('gate-val'),
    presetName: $('preset-name'), presetSave: $('preset-save'),
    recList: $('rec-list'),
    optEcho: $('opt-echo'), optNs: $('opt-ns'), optAgc: $('opt-agc'), optWake: $('opt-wake'), optMono: $('opt-stereo'),
    limit: $('limit'), limitVal: $('limit-val'), resetAll: $('reset-all'),
    fileRow: $('file-row'), fileInput: $('file-input'), fileName: $('file-name'), fileAudio: $('file-audio'),
    toast: $('toast'),
  };

  let toastTimer;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
  }

  function paintRange(input) {
    const min = +input.min, max = +input.max;
    input.style.setProperty('--p', ((+input.value - min) / (max - min)) * 100 + '%');
  }

  // ---------- audio engine ----------
  let ctx = null;
  const N = {};          // nodes
  let source = 'mic';    // 'mic' | 'file'
  let running = false;
  let micStream = null, micNode = null, fileNode = null;
  let wakeLock = null;

  const dbToGain = (db) => Math.pow(10, db / 20);

  async function ensureContext() {
    if (ctx) return;
    if (building) return building;
    building = buildGraph().finally(() => { building = null; });
    return building;
  }
  let building = null;

  async function buildGraph() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('This browser does not support Web Audio.');
    const ctx = new AC({ latencyHint: 'interactive' });

    N.input = ctx.createGain();
    N.lowcut = ctx.createBiquadFilter(); N.lowcut.type = 'highpass'; N.lowcut.Q.value = 0.707;

    try {
      await ctx.audioWorklet.addModule('gate-worklet.js');
      N.gate = new AudioWorkletNode(ctx, 'noise-gate', { outputChannelCount: [2] });
    } catch (e) {
      console.warn('Noise gate unavailable, bypassing', e);
      N.gate = ctx.createGain();
    }

    N.eq = EQ_FREQS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = 1.1;
      return b;
    });
    N.clarity = ctx.createBiquadFilter(); N.clarity.type = 'peaking'; N.clarity.frequency.value = 3000; N.clarity.Q.value = 0.8;
    N.boost = ctx.createGain();
    N.comp = ctx.createDynamicsCompressor();
    N.comp.knee.value = 12; N.comp.attack.value = 0.005; N.comp.release.value = 0.2;
    N.pan = ctx.createStereoPanner();
    N.limiter = ctx.createDynamicsCompressor();
    N.limiter.knee.value = 0; N.limiter.ratio.value = 20; N.limiter.attack.value = 0.001; N.limiter.release.value = 0.08;
    N.master = ctx.createGain();
    N.analyser = ctx.createAnalyser(); N.analyser.fftSize = 2048; N.analyser.smoothingTimeConstant = 0.75;
    N.recDest = ctx.createMediaStreamDestination();

    const chain = [N.input, N.lowcut, N.gate, ...N.eq, N.clarity, N.boost, N.comp, N.pan, N.limiter, N.master, N.analyser];
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    N.analyser.connect(ctx.destination);
    N.analyser.connect(N.recDest);

    publishContext(ctx);
    applyAll();
  }

  function publishContext(c) { ctx = c; }

  function setParam(param, value) {
    if (!ctx) return;
    param.setTargetAtTime(value, ctx.currentTime, 0.02);
  }

  function applyAll() {
    if (!ctx) return;
    setParam(N.boost.gain, dbToGain(S.boost));
    setParam(N.pan.pan, S.balance);
    setParam(N.clarity.gain, S.clarity);
    N.eq.forEach((b, i) => setParam(b.gain, S.eq[i]));
    setParam(N.lowcut.frequency, S.lowcut);
    if (N.gate.parameters) {
      setParam(N.gate.parameters.get('enabled'), S.noiseReduction ? 1 : 0);
      setParam(N.gate.parameters.get('threshold'), S.gate);
    }
    // "Loud sound protection" = gentle compressor; when off, make it transparent.
    setParam(N.comp.threshold, S.compressor ? -24 : 0);
    setParam(N.comp.ratio, S.compressor ? 4 : 1);
    setParam(N.limiter.threshold, S.limit);
    setParam(N.master.gain, el.mute.checked ? 0 : 1);
    N.input.channelCount = S.mono ? 1 : 2;
    N.input.channelCountMode = S.mono ? 'explicit' : 'max';
  }

  async function startMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone needs HTTPS. Open the app from its https:// link.');
    }
    // iOS 16.4+: route as a call-style session so headphones/AirPods work for in+out.
    try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch { /* ignore */ }
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: S.echo, noiseSuppression: S.ns, autoGainControl: S.agc, channelCount: 1 },
    });
    micNode = ctx.createMediaStreamSource(micStream);
    micNode.connect(N.input);
  }

  function stopMic() {
    if (micNode) { try { micNode.disconnect(); } catch { /* */ } micNode = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch { /* ignore */ }
  }

  function startFile() {
    if (!el.fileAudio.src) throw new Error('Choose an audio file first.');
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* ignore */ }
    if (!fileNode) fileNode = ctx.createMediaElementSource(el.fileAudio);
    fileNode.connect(N.input);
    el.fileAudio.play().catch(() => {});
  }

  function stopFile() {
    el.fileAudio.pause();
    if (fileNode) { try { fileNode.disconnect(); } catch { /* */ } }
  }

  async function start() {
    try {
      await ensureContext();
      if (ctx.state !== 'running') await ctx.resume();
      if (source === 'mic') await startMic(); else startFile();
      running = true;
      updatePowerUI();
      requestWake();
      if (source === 'mic') toast('Listening — use headphones 🎧');
    } catch (err) {
      console.error(err);
      stopSource();
      running = false;
      updatePowerUI();
      const msg = err && err.name === 'NotAllowedError'
        ? 'Microphone blocked. Allow it in Settings › Safari › Microphone.'
        : (err && err.message) || 'Could not start audio.';
      toast(msg);
    }
  }

  function stopSource() {
    stopMic();
    stopFile();
  }

  async function stop() {
    if (recorder && recorder.state === 'recording') recorder.stop();
    stopSource();
    running = false;
    updatePowerUI();
    releaseWake();
    if (ctx && source === 'mic') { try { await ctx.suspend(); } catch { /* */ } }
  }

  function updatePowerUI() {
    el.power.setAttribute('aria-pressed', String(running));
    el.powerLabel.textContent = running ? 'Stop' : 'Start';
    el.record.disabled = !running;
    const recording = recorder && recorder.state === 'recording';
    el.status.textContent = recording ? '● REC' : running ? (source === 'mic' ? 'Live' : 'Playing') : 'Off';
    el.status.className = 'pill' + (recording ? ' rec' : running ? ' on' : '');
  }

  // ---------- wake lock ----------
  async function requestWake() {
    if (!S.wake || !('wakeLock' in navigator)) return;
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
  }
  function releaseWake() { if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && running) {
      requestWake();
      if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
    }
  });

  // ---------- visualiser & meter ----------
  const vctx = el.viz.getContext('2d');
  let freqData, timeData;
  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    el.viz.width = el.viz.clientWidth * dpr;
    el.viz.height = el.viz.clientHeight * dpr;
  }
  window.addEventListener('resize', resizeCanvas);

  function draw() {
    requestAnimationFrame(draw);
    const w = el.viz.width, h = el.viz.height;
    vctx.clearRect(0, 0, w, h);
    const bars = 48;
    const gap = w * 0.006;
    const bw = (w - gap * (bars - 1)) / bars;

    let levels = null;
    if (ctx && running && N.analyser) {
      if (!freqData) {
        freqData = new Uint8Array(N.analyser.frequencyBinCount);
        timeData = new Float32Array(N.analyser.fftSize);
      }
      N.analyser.getByteFrequencyData(freqData);
      N.analyser.getFloatTimeDomainData(timeData);
      levels = [];
      const nyq = ctx.sampleRate / 2, binHz = nyq / freqData.length;
      for (let i = 0; i < bars; i++) {
        const f0 = 30 * Math.pow(16000 / 30, i / bars), f1 = 30 * Math.pow(16000 / 30, (i + 1) / bars);
        const b0 = Math.max(1, Math.floor(f0 / binHz)), b1 = Math.max(b0 + 1, Math.ceil(f1 / binHz));
        let m = 0;
        for (let b = b0; b < b1 && b < freqData.length; b++) m = Math.max(m, freqData[b]);
        levels.push(m / 255);
      }
      let sum = 0;
      for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
      const db = 20 * Math.log10(Math.sqrt(sum / timeData.length) || 1e-8);
      const pct = Math.max(0, Math.min(1, (db + 60) / 60));
      el.meterFill.style.width = pct * 100 + '%';
      el.meterDb.textContent = db < -90 ? '-∞ dB' : db.toFixed(0) + ' dB';
    } else {
      el.meterFill.style.width = '0%';
      el.meterDb.textContent = '-∞ dB';
    }

    const grad = vctx.createLinearGradient(0, h, 0, 0);
    grad.addColorStop(0, '#2ee6c5'); grad.addColorStop(1, '#3fa8ff');
    vctx.fillStyle = grad;
    for (let i = 0; i < bars; i++) {
      const v = levels ? levels[i] : 0;
      const bh = Math.max(h * 0.02, v * h * 0.92);
      const x = i * (bw + gap);
      vctx.globalAlpha = levels ? 0.95 : 0.25;
      vctx.fillRect(x, h - bh, bw, bh);
    }
    vctx.globalAlpha = 1;
  }

  // ---------- recording (stored in IndexedDB) ----------
  let recorder = null, recChunks = [], recStart = 0;
  const DB_NAME = 'amplifier', DB_STORE = 'recordings';
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: 'id', autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function dbOp(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const result = fn(tx.objectStore(DB_STORE));
      tx.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  }

  function pickMime() {
    if (!window.MediaRecorder) return null;
    const types = ['audio/mp4', 'audio/aac', 'audio/webm;codecs=opus', 'audio/webm'];
    return types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  }

  function toggleRecord() {
    if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
    const mime = pickMime();
    if (mime === null) { toast('Recording is not supported on this device.'); return; }
    recChunks = [];
    recorder = new MediaRecorder(N.recDest.stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = async () => {
      el.record.classList.remove('active');
      el.record.textContent = '● Record';
      updatePowerUI();
      const type = recorder.mimeType || mime || 'audio/mp4';
      const blob = new Blob(recChunks, { type });
      const duration = Math.round((Date.now() - recStart) / 1000);
      if (!blob.size) return;
      const d = new Date();
      const name = 'Amplifier ' + d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      try {
        await dbOp('readwrite', (s) => s.add({ name, date: d.getTime(), duration, type, blob }));
        toast('Recording saved');
        renderRecordings();
      } catch (e) { console.error(e); toast('Could not save recording'); }
    };
    recorder.start(1000);
    recStart = Date.now();
    el.record.classList.add('active');
    el.record.textContent = '■ Stop recording';
    updatePowerUI();
  }

  const fmtDur = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const extFor = (type) => (type.includes('webm') ? 'webm' : type.includes('aac') ? 'aac' : 'm4a');
  const objectUrls = [];

  async function renderRecordings() {
    let items = [];
    try { items = (await dbOp('readonly', (s) => s.getAll())) || []; } catch { /* no IDB */ }
    objectUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
    el.recList.textContent = '';
    if (!items.length) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No recordings yet. Tap ● Record on the Amplify tab.';
      el.recList.appendChild(li);
      return;
    }
    items.sort((a, b) => b.date - a.date).forEach((r) => {
      const url = URL.createObjectURL(r.blob); objectUrls.push(url);
      const li = document.createElement('li');
      const title = document.createElement('div');
      title.innerHTML = '<b></b> <span class="muted small"></span>';
      title.querySelector('b').textContent = r.name;
      title.querySelector('span').textContent = fmtDur(r.duration || 0);
      const audio = document.createElement('audio');
      audio.controls = true; audio.src = url; audio.setAttribute('playsinline', '');
      const actions = document.createElement('div'); actions.className = 'rec-actions';
      const filename = r.name.replace(/[^\w\- ]+/g, '-') + '.' + extFor(r.type);

      const share = document.createElement('button'); share.className = 'link'; share.textContent = 'Share / Save';
      share.onclick = async () => {
        const file = new File([r.blob], filename, { type: r.type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          try { await navigator.share({ files: [file], title: r.name }); } catch { /* cancelled */ }
        } else {
          const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
        }
      };
      const del = document.createElement('button'); del.className = 'link'; del.style.color = 'var(--danger)'; del.textContent = 'Delete';
      del.onclick = async () => {
        if (!confirm('Delete this recording?')) return;
        await dbOp('readwrite', (s) => s.delete(r.id));
        renderRecordings();
      };
      actions.append(share, del);
      li.append(title, audio, actions);
      el.recList.appendChild(li);
    });
  }

  // ---------- presets ----------
  function applyPreset(name) {
    const p = BUILTIN_PRESETS[name] || customPresets[name];
    if (!p) return;
    Object.assign(S, { gate: DEFAULTS.gate }, JSON.parse(JSON.stringify(p)), { preset: name });
    save(); syncUI(); applyAll();
    toast('Preset: ' + name);
  }

  function renderPresets() {
    el.presets.textContent = '';
    const make = (name, custom) => {
      const b = document.createElement('button');
      b.className = 'chip' + (S.preset === name ? ' active' : '');
      b.textContent = name;
      b.onclick = () => applyPreset(name);
      if (custom) {
        const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕';
        x.onclick = (e) => {
          e.stopPropagation();
          if (!confirm('Delete preset "' + name + '"?')) return;
          delete customPresets[name]; store.set('amp.presets', customPresets);
          if (S.preset === name) { S.preset = ''; save(); }
          renderPresets();
        };
        b.appendChild(x);
      }
      el.presets.appendChild(b);
    };
    Object.keys(BUILTIN_PRESETS).forEach((n) => make(n, false));
    Object.keys(customPresets).forEach((n) => make(n, true));
  }

  function markCustom() {
    if (S.preset) { S.preset = ''; renderPresets(); }
  }

  // ---------- EQ UI ----------
  const eqInputs = [], eqVals = [];
  function buildEq() {
    EQ_FREQS.forEach((f, i) => {
      const band = document.createElement('div'); band.className = 'band';
      const val = document.createElement('div'); val.className = 'val';
      const input = document.createElement('input');
      input.type = 'range'; input.min = -12; input.max = 12; input.step = 1;
      input.setAttribute('aria-label', (f >= 1000 ? f / 1000 + 'k' : f) + ' Hz');
      input.addEventListener('input', () => {
        S.eq[i] = +input.value; val.textContent = (S.eq[i] > 0 ? '+' : '') + S.eq[i];
        markCustom(); save(); applyAll();
      });
      const lbl = document.createElement('div'); lbl.className = 'freq';
      lbl.textContent = f >= 1000 ? f / 1000 + 'k' : String(f);
      band.append(val, input, lbl);
      el.eq.appendChild(band);
      eqInputs.push(input); eqVals.push(val);
    });
  }

  // ---------- sync UI from state ----------
  function syncUI() {
    el.volume.value = S.boost; el.volumeVal.textContent = '+' + S.boost + ' dB';
    el.balance.value = S.balance;
    el.balanceVal.textContent = Math.abs(S.balance) < 0.03 ? 'C' : (S.balance < 0 ? 'L ' : 'R ') + Math.round(Math.abs(S.balance) * 100);
    el.clarity.value = S.clarity; el.clarityVal.textContent = S.clarity ? '+' + S.clarity : '0';
    el.nr.checked = S.noiseReduction; el.comp.checked = S.compressor;
    el.lowcut.value = S.lowcut; el.lowcutVal.textContent = S.lowcut + ' Hz';
    el.gate.value = S.gate; el.gateVal.textContent = S.gate + ' dB';
    el.limit.value = S.limit; el.limitVal.textContent = S.limit + ' dB';
    el.optEcho.checked = S.echo; el.optNs.checked = S.ns; el.optAgc.checked = S.agc;
    el.optWake.checked = S.wake; el.optMono.checked = S.mono;
    eqInputs.forEach((inp, i) => {
      inp.value = S.eq[i];
      eqVals[i].textContent = (S.eq[i] > 0 ? '+' : '') + S.eq[i];
    });
    document.querySelectorAll('input[type=range]').forEach(paintRange);
    renderPresets();
  }

  // ---------- event wiring ----------
  function bindRange(input, key, opts = {}) {
    input.addEventListener('input', () => {
      S[key] = +input.value;
      if (opts.custom) markCustom();
      save(); syncUI(); applyAll();
    });
  }
  bindRange(el.volume, 'boost', { custom: true });
  bindRange(el.balance, 'balance');
  bindRange(el.clarity, 'clarity', { custom: true });
  bindRange(el.lowcut, 'lowcut', { custom: true });
  bindRange(el.gate, 'gate', { custom: true });
  bindRange(el.limit, 'limit');
  // Double-tap balance to centre.
  el.balance.addEventListener('dblclick', () => { S.balance = 0; save(); syncUI(); applyAll(); });

  const bindToggle = (input, key, onChange) => input.addEventListener('change', () => {
    S[key] = input.checked; save(); applyAll(); if (onChange) onChange();
  });
  bindToggle(el.nr, 'noiseReduction', markCustom);
  bindToggle(el.comp, 'compressor');
  const restartMic = async () => { if (running && source === 'mic') { await stop(); await start(); } };
  bindToggle(el.optEcho, 'echo', restartMic);
  bindToggle(el.optNs, 'ns', restartMic);
  bindToggle(el.optAgc, 'agc', restartMic);
  bindToggle(el.optMono, 'mono');
  bindToggle(el.optWake, 'wake', () => (S.wake && running ? requestWake() : releaseWake()));
  el.mute.addEventListener('change', applyAll);

  el.power.addEventListener('click', () => (running ? stop() : start()));
  el.record.addEventListener('click', toggleRecord);

  el.eqReset.addEventListener('click', () => { S.eq = FLAT.slice(); markCustom(); save(); syncUI(); applyAll(); });

  el.presetSave.addEventListener('click', () => {
    const name = el.presetName.value.trim();
    if (!name) { toast('Type a preset name'); return; }
    if (BUILTIN_PRESETS[name]) { toast('That name is taken by a built-in preset'); return; }
    customPresets[name] = {
      boost: S.boost, eq: S.eq.slice(), clarity: S.clarity, lowcut: S.lowcut,
      noiseReduction: S.noiseReduction, gate: S.gate,
    };
    store.set('amp.presets', customPresets);
    S.preset = name; save();
    el.presetName.value = '';
    renderPresets();
    toast('Saved preset "' + name + '"');
  });

  el.resetAll.addEventListener('click', () => {
    if (!confirm('Reset all settings and delete custom presets? (Recordings are kept.)')) return;
    Object.assign(S, JSON.parse(JSON.stringify(DEFAULTS)));
    customPresets = {}; store.set('amp.presets', customPresets);
    save(); syncUI(); applyAll();
    toast('Settings reset');
  });

  // Source switch
  document.querySelectorAll('.seg').forEach((btn) => btn.addEventListener('click', async () => {
    const next = btn.dataset.source;
    if (next === source) return;
    const wasRunning = running;
    if (running) await stop();
    source = next;
    document.querySelectorAll('.seg').forEach((b) => b.classList.toggle('active', b === btn));
    el.fileRow.classList.toggle('hidden', source !== 'file');
    updatePowerUI();
    if (wasRunning && (source === 'mic' || el.fileAudio.src)) start();
  }));

  let fileUrl = null;
  el.fileInput.addEventListener('change', async () => {
    const f = el.fileInput.files && el.fileInput.files[0];
    if (!f) return;
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(f);
    el.fileAudio.src = fileUrl;
    el.fileName.textContent = f.name;
    if (running) { stopFile(); startFile(); } else { await start(); }
  });
  el.fileAudio.addEventListener('play', () => { if (!running && source === 'file') start(); });

  // Tabs
  document.querySelectorAll('.tabbtn').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.tabbtn').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + btn.dataset.tab));
    if (btn.dataset.tab === 'rec') renderRecordings();
    if (btn.dataset.tab === 'amp') resizeCanvas();
  }));

  // ---------- boot ----------
  buildEq();
  syncUI();
  resizeCanvas();
  draw();
  renderRecordings();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
