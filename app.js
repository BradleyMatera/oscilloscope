const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const ui = {
  canvas: $('#scope'),
  scopeEmpty: $('#scopeEmpty'),
  audioStatus: $('#audioStatus'),
  sourceLabel: $('#sourceLabel'),
  rms: $('#rmsReadout'),
  peak: $('#peakReadout'),
  fft: $('#fftReadout'),
  fps: $('#fpsReadout'),
  modeHud: $('#modeHud'),
  trackTitle: $('#trackTitle'),
  trackDetail: $('#trackDetail'),
  play: $('#playBtn'),
  startDemo: $('#startDemoBtn'),
  synth: $('#synthBtn'),
  mic: $('#micBtn'),
  captureTab: $('#captureTabBtn'),
  audioFile: $('#audioFile'),
  audioElement: $('#audioElement'),
  gain: $('#gainControl'),
  youtubeForm: $('#youtubeForm'),
  youtubeUrl: $('#youtubeUrl'),
  youtubeStage: $('#youtubeStage'),
  youtubeFrame: $('#youtubeFrame'),
  notice: $('#notice'),
  freqA: $('#freqA'),
  freqB: $('#freqB'),
  phase: $('#phase'),
  trail: $('#trail'),
  freqAValue: $('#freqAValue'),
  freqBValue: $('#freqBValue'),
  phaseValue: $('#phaseValue'),
  trailValue: $('#trailValue'),
  eqFreqA: $('#eqFreqA'),
  eqFreqB: $('#eqFreqB'),
  eqPhaseA: $('#eqPhaseA'),
  eqPhaseB: $('#eqPhaseB'),
  ratio: $('#ratioReadout'),
  sendToScope: $('#sendToScopeBtn'),
};

const state = {
  mode: 'time',
  sourceType: null,
  playing: false,
  desiredGain: Number(ui.gain.value),
  trail: Number(ui.trail.value),
  youtubeId: null,
  frameCount: 0,
  lastFpsAt: performance.now(),
  lastFpsFrame: 0,
};

class SignalEngine {
  constructor(audioElement) {
    this.audioElement = audioElement;
    this.ctx = null;
    this.bus = null;
    this.monitor = null;
    this.analyser = null;
    this.leftAnalyser = null;
    this.rightAnalyser = null;
    this.splitter = null;
    this.currentInput = null;
    this.mediaElementSource = null;
    this.stream = null;
    this.synth = null;
    this.monitorEnabled = true;
  }

  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('Web Audio is not supported in this browser.');

    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.bus = this.ctx.createGain();
    this.monitor = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.leftAnalyser = this.ctx.createAnalyser();
    this.rightAnalyser = this.ctx.createAnalyser();
    this.splitter = this.ctx.createChannelSplitter(2);

    for (const analyser of [this.analyser, this.leftAnalyser, this.rightAnalyser]) {
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.72;
      analyser.minDecibels = -96;
      analyser.maxDecibels = -12;
    }

    this.bus.gain.value = state.desiredGain;
    this.monitor.gain.value = 1;

    this.bus.connect(this.analyser);
    this.bus.connect(this.splitter);
    this.splitter.connect(this.leftAnalyser, 0);
    this.splitter.connect(this.rightAnalyser, 1);
    this.bus.connect(this.monitor);
    this.monitor.connect(this.ctx.destination);
  }

  setGain(value) {
    state.desiredGain = value;
    if (!this.bus || !this.ctx) return;
    const target = state.playing ? value : 0;
    this.bus.gain.setTargetAtTime(target, this.ctx.currentTime, 0.012);
  }

  setMonitor(enabled) {
    this.monitorEnabled = enabled;
    if (this.monitor && this.ctx) {
      this.monitor.gain.setTargetAtTime(enabled ? 1 : 0, this.ctx.currentTime, 0.01);
    }
  }

  async disconnectCurrent() {
    if (this.currentInput) {
      try { this.currentInput.disconnect(); } catch (_) {}
      this.currentInput = null;
    }

    if (this.synth) {
      for (const osc of this.synth.oscillators) {
        try { osc.stop(); } catch (_) {}
        try { osc.disconnect(); } catch (_) {}
      }
      try { this.synth.merger.disconnect(); } catch (_) {}
      this.synth = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.audioElement && !this.audioElement.paused) this.audioElement.pause();
  }

  async routeSynth(freqA, freqB, phase) {
    await this.init();
    await this.disconnectCurrent();

    const oscA = this.ctx.createOscillator();
    const oscB = this.ctx.createOscillator();
    const gainA = this.ctx.createGain();
    const gainB = this.ctx.createGain();
    const delayB = this.ctx.createDelay(1);
    const merger = this.ctx.createChannelMerger(2);

    oscA.type = 'sine';
    oscB.type = 'sine';
    oscA.frequency.value = freqA;
    oscB.frequency.value = freqB;
    gainA.gain.value = 0.68;
    gainB.gain.value = 0.68;

    // Delay is the physical time equivalent of phase: Δt = φ / (2πf).
    delayB.delayTime.value = Math.max(0, phase / (2 * Math.PI * Math.max(freqB, 1)));

    oscA.connect(gainA).connect(merger, 0, 0);
    oscB.connect(gainB).connect(delayB).connect(merger, 0, 1);
    merger.connect(this.bus);
    oscA.start();
    oscB.start();

    this.currentInput = merger;
    this.synth = { oscillators: [oscA, oscB], gainA, gainB, delayB, merger };
    this.setMonitor(true);
    state.sourceType = 'synth';
    state.playing = true;
    this.setGain(state.desiredGain);
  }

  updateSynth(freqA, freqB, phase) {
    if (!this.synth || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.synth.oscillators[0].frequency.setTargetAtTime(freqA, now, 0.012);
    this.synth.oscillators[1].frequency.setTargetAtTime(freqB, now, 0.012);
    const delay = Math.max(0, phase / (2 * Math.PI * Math.max(freqB, 1)));
    this.synth.delayB.delayTime.setTargetAtTime(delay, now, 0.012);
  }

  async routeAudioElement() {
    await this.init();
    await this.disconnectCurrent();
    if (!this.mediaElementSource) {
      this.mediaElementSource = this.ctx.createMediaElementSource(this.audioElement);
    }
    this.mediaElementSource.connect(this.bus);
    this.currentInput = this.mediaElementSource;
    this.setMonitor(true);
    state.sourceType = 'file';
    state.playing = false;
    this.setGain(state.desiredGain);
  }

  async routeStream(stream, type) {
    await this.init();
    await this.disconnectCurrent();
    this.stream = stream;
    const source = this.ctx.createMediaStreamSource(stream);
    source.connect(this.bus);
    this.currentInput = source;
    this.setMonitor(false);
    state.sourceType = type;
    state.playing = true;
    this.setGain(state.desiredGain);

    stream.getTracks().forEach((track) => {
      track.addEventListener('ended', () => {
        if (this.stream === stream) {
          state.playing = false;
          updateTransport();
          setStatus('audio idle', false);
          tell('Capture ended. Choose another source whenever you are ready.');
        }
      });
    });
  }

  async toggle() {
    await this.init();
    if (!state.sourceType) return false;

    if (state.sourceType === 'file') {
      if (this.audioElement.paused) {
        await this.audioElement.play();
        state.playing = true;
      } else {
        this.audioElement.pause();
        state.playing = false;
      }
      this.setGain(state.desiredGain);
      return state.playing;
    }

    state.playing = !state.playing;
    this.setGain(state.desiredGain);
    return state.playing;
  }
}

const engine = new SignalEngine(ui.audioElement);
const ctx2d = ui.canvas.getContext('2d', { alpha: true });
let timeData = new Float32Array(2048);
let leftData = new Float32Array(2048);
let rightData = new Float32Array(2048);
let freqData = new Uint8Array(1024);
let cssWidth = 0;
let cssHeight = 0;
let dpr = 1;

function resizeCanvas() {
  const rect = ui.canvas.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  cssWidth = Math.max(1, rect.width);
  cssHeight = Math.max(1, rect.height);
  ui.canvas.width = Math.round(cssWidth * dpr);
  ui.canvas.height = Math.round(cssHeight * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.lineCap = 'round';
  ctx2d.lineJoin = 'round';
}

new ResizeObserver(resizeCanvas).observe(ui.canvas);

function ensureBuffers() {
  if (!engine.analyser) return;
  const n = engine.analyser.fftSize;
  if (timeData.length !== n) {
    timeData = new Float32Array(n);
    leftData = new Float32Array(n);
    rightData = new Float32Array(n);
    freqData = new Uint8Array(engine.analyser.frequencyBinCount);
  }
}

function fadeCanvas(strength = state.trail) {
  const alpha = Math.max(0.035, 1 - strength);
  ctx2d.fillStyle = `rgba(4, 7, 6, ${alpha})`;
  ctx2d.fillRect(0, 0, cssWidth, cssHeight);
}

function configureTrace(width = 1.35, alpha = 0.95) {
  ctx2d.strokeStyle = `rgba(184,255,59,${alpha})`;
  ctx2d.lineWidth = width;
  ctx2d.shadowColor = 'rgba(184,255,59,.65)';
  ctx2d.shadowBlur = 8;
}

function drawTimeDomain() {
  engine.analyser.getFloatTimeDomainData(timeData);
  fadeCanvas(state.trail);
  configureTrace(1.45, .96);
  ctx2d.beginPath();
  const step = cssWidth / (timeData.length - 1);
  const amp = cssHeight * 0.39;
  for (let i = 0; i < timeData.length; i++) {
    const x = i * step;
    const y = cssHeight * 0.5 - timeData[i] * amp;
    if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
}

function drawSpectrum() {
  engine.analyser.getByteFrequencyData(freqData);
  fadeCanvas(.45);
  ctx2d.shadowBlur = 0;
  const nyquist = engine.ctx.sampleRate / 2;
  const minFreq = 30;
  const maxFreq = Math.min(18000, nyquist);
  const bars = Math.min(110, Math.floor(cssWidth / 6));
  const gap = 2;
  const barWidth = cssWidth / bars;

  for (let i = 0; i < bars; i++) {
    const t0 = i / bars;
    const t1 = (i + 1) / bars;
    const f0 = minFreq * Math.pow(maxFreq / minFreq, t0);
    const f1 = minFreq * Math.pow(maxFreq / minFreq, t1);
    const b0 = Math.floor((f0 / nyquist) * freqData.length);
    const b1 = Math.max(b0 + 1, Math.ceil((f1 / nyquist) * freqData.length));
    let sum = 0;
    let count = 0;
    for (let b = b0; b < Math.min(b1, freqData.length); b++) {
      sum += freqData[b];
      count++;
    }
    const magnitude = count ? sum / count / 255 : 0;
    const h = magnitude * cssHeight * .88;
    const x = i * barWidth;
    const y = cssHeight - h;
    ctx2d.fillStyle = `rgba(184,255,59,${0.3 + magnitude * .7})`;
    ctx2d.fillRect(x, y, Math.max(1, barWidth - gap), h);
  }
}

function drawLissajous() {
  engine.leftAnalyser.getFloatTimeDomainData(leftData);
  engine.rightAnalyser.getFloatTimeDomainData(rightData);
  fadeCanvas(state.trail);
  configureTrace(1.15, .9);
  ctx2d.beginPath();
  const radiusX = cssWidth * .39;
  const radiusY = cssHeight * .4;
  const centerX = cssWidth / 2;
  const centerY = cssHeight / 2;
  const stride = Math.max(1, Math.floor(leftData.length / 1100));

  for (let i = 0, point = 0; i < leftData.length; i += stride, point++) {
    const x = centerX + leftData[i] * radiusX;
    const y = centerY - rightData[i] * radiusY;
    if (point === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
  }
  ctx2d.stroke();
}

function drawVectorField(now) {
  engine.analyser.getByteFrequencyData(freqData);
  engine.analyser.getFloatTimeDomainData(timeData);
  fadeCanvas(.86);
  ctx2d.shadowBlur = 0;
  const cx = cssWidth / 2;
  const cy = cssHeight / 2;
  const maxR = Math.min(cssWidth, cssHeight) * .43;
  const count = Math.min(180, freqData.length);
  const stride = Math.floor(freqData.length / count);
  const time = now * .00028;

  for (let i = 0; i < count; i++) {
    const bin = freqData[i * stride] / 255;
    const sample = timeData[(i * 11) % timeData.length] || 0;
    const a = (i / count) * Math.PI * 2 + time + sample * .4;
    const r = maxR * (.12 + (i / count) * .78) * (0.5 + bin * .65);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a * 1.07) * r;
    const size = 1 + bin * 4.5;
    ctx2d.fillStyle = `rgba(184,255,59,${.15 + bin * .82})`;
    ctx2d.fillRect(x, y, size, size);
  }
}

function updateMetrics() {
  if (!engine.analyser) return;
  engine.analyser.getFloatTimeDomainData(timeData);
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = timeData[i];
    sumSq += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  const rms = Math.sqrt(sumSq / timeData.length);
  const db = rms > 0.000001 ? 20 * Math.log10(rms) : -Infinity;
  ui.rms.textContent = Number.isFinite(db) ? `${db.toFixed(1)}dB` : '-∞';
  ui.peak.textContent = peak.toFixed(2);
}

function render(now) {
  requestAnimationFrame(render);
  state.frameCount++;

  if (now - state.lastFpsAt > 600) {
    const elapsed = (now - state.lastFpsAt) / 1000;
    const fps = Math.round((state.frameCount - state.lastFpsFrame) / elapsed);
    ui.fps.textContent = String(fps);
    state.lastFpsAt = now;
    state.lastFpsFrame = state.frameCount;
  }

  if (!engine.analyser || !state.playing || !cssWidth || !cssHeight) {
    if (cssWidth && cssHeight) {
      ctx2d.clearRect(0, 0, cssWidth, cssHeight);
    }
    return;
  }

  ensureBuffers();
  if (state.mode === 'time') drawTimeDomain();
  if (state.mode === 'spectrum') drawSpectrum();
  if (state.mode === 'lissajous') drawLissajous();
  if (state.mode === 'particles') drawVectorField(now);
  if (state.frameCount % 6 === 0) updateMetrics();
}
requestAnimationFrame(render);

function tell(message, type = 'info') {
  ui.notice.textContent = message;
  ui.notice.classList.toggle('error', type === 'error');
}

function setStatus(text, live) {
  ui.audioStatus.lastChild.textContent = ` ${text}`;
  ui.audioStatus.classList.toggle('live', live);
}

function updateTransport() {
  ui.play.textContent = state.playing ? '❚❚' : '▶';
  ui.play.setAttribute('aria-label', state.playing ? 'Pause signal' : 'Play signal');
  ui.scopeEmpty.classList.toggle('hidden', state.playing);
  setStatus(state.playing ? 'signal live' : 'audio idle', state.playing);
}

function setMode(mode) {
  state.mode = mode;
  $$('.mode-btn').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  const labels = {
    time: 'TIME / Y(t)',
    spectrum: 'FFT / |X(f)|',
    lissajous: 'XY / L:R',
    particles: 'VECTOR / FIELD',
  };
  ui.modeHud.textContent = labels[mode];
  ctx2d.clearRect(0, 0, cssWidth, cssHeight);
}

function gcd(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function phaseLabel(rad) {
  const pi = Math.PI;
  const candidates = [
    [0, '0'], [pi / 4, 'π/4'], [pi / 2, 'π/2'], [3 * pi / 4, '3π/4'],
    [pi, 'π'], [5 * pi / 4, '5π/4'], [3 * pi / 2, '3π/2'], [2 * pi, '2π'],
  ];
  const match = candidates.find(([value]) => Math.abs(rad - value) < .025);
  return match ? match[1] : `${rad.toFixed(2)} rad`;
}

function updateMathUi() {
  const a = Number(ui.freqA.value);
  const b = Number(ui.freqB.value);
  const phase = Number(ui.phase.value);
  const trail = Number(ui.trail.value);
  const d = gcd(a, b);

  ui.freqAValue.textContent = `${a} Hz`;
  ui.freqBValue.textContent = `${b} Hz`;
  ui.phaseValue.textContent = `${phase.toFixed(2)} rad`;
  ui.trailValue.textContent = `${Math.round(trail * 100)}%`;
  ui.eqFreqA.textContent = String(a);
  ui.eqFreqB.textContent = String(b);
  ui.eqPhaseB.textContent = phaseLabel(phase);
  ui.ratio.textContent = `${a / d}:${b / d}`;
  state.trail = trail;
  engine.updateSynth(a, b, phase);

  if (state.sourceType === 'synth') {
    ui.trackDetail.textContent = `A ${a} Hz · B ${b} Hz · phase ${phaseLabel(phase)}`;
  }
}

async function startSynth({ jumpToScope = false } = {}) {
  try {
    const a = Number(ui.freqA.value);
    const b = Number(ui.freqB.value);
    const phase = Number(ui.phase.value);
    await engine.routeSynth(a, b, phase);
    ui.sourceLabel.textContent = 'SYNTH / DUAL SINE';
    ui.trackTitle.textContent = 'Dual oscillator';
    ui.trackDetail.textContent = `A ${a} Hz · B ${b} Hz · phase ${phaseLabel(phase)}`;
    tell('Synth routed through the Web Audio graph. Change the math controls while it plays.');
    updateTransport();
    if (jumpToScope) $('#instrument').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    tell(error.message || 'Could not start the synthesizer.', 'error');
  }
}

function parseYouTubeId(raw) {
  try {
    const url = new URL(raw.trim());
    const host = url.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return url.pathname.split('/').filter(Boolean)[0] || null;
    if (host.endsWith('youtube.com')) {
      if (url.pathname === '/watch') return url.searchParams.get('v');
      const parts = url.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live'].includes(parts[0])) return parts[1] || null;
    }
    return null;
  } catch (_) {
    return null;
  }
}

ui.youtubeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const id = parseYouTubeId(ui.youtubeUrl.value);
  if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) {
    tell('That does not look like a supported YouTube video URL.', 'error');
    return;
  }
  state.youtubeId = id;
  ui.youtubeFrame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&playsinline=1&rel=0`;
  ui.youtubeStage.hidden = false;
  ui.sourceLabel.textContent = 'YOUTUBE / PLAYER';
  ui.trackTitle.textContent = `YouTube · ${id}`;
  ui.trackDetail.textContent = 'Playback embedded · analysis waits for tab audio capture';
  tell('Video loaded. For a real waveform, click “Analyze tab audio” and share the tab with audio enabled.');
});

ui.captureTab.addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    tell('This browser does not expose tab/system capture through getDisplayMedia.', 'error');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      selfBrowserSurface: 'include',
      systemAudio: 'include',
      surfaceSwitching: 'include',
    });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error('The shared surface did not include audio. Retry and enable “Share tab audio”.');
    }
    await engine.routeStream(stream, 'tab');
    ui.sourceLabel.textContent = state.youtubeId ? 'YOUTUBE / TAB CAPTURE' : 'SYSTEM / TAB CAPTURE';
    ui.trackTitle.textContent = state.youtubeId ? `YouTube · ${state.youtubeId}` : 'Captured tab audio';
    ui.trackDetail.textContent = 'MediaStream → Web Audio → AnalyserNode';
    tell('Tab audio is live. The scope is now reading real samples from the captured stream.');
    updateTransport();
  } catch (error) {
    if (error.name === 'NotAllowedError') tell('Capture was cancelled or blocked. Nothing was shared.', 'error');
    else tell(error.message || 'Could not capture tab audio.', 'error');
  }
});

ui.audioFile.addEventListener('change', async () => {
  const file = ui.audioFile.files?.[0];
  if (!file) return;
  try {
    if (ui.audioElement.dataset.objectUrl) URL.revokeObjectURL(ui.audioElement.dataset.objectUrl);
    const objectUrl = URL.createObjectURL(file);
    ui.audioElement.dataset.objectUrl = objectUrl;
    ui.audioElement.src = objectUrl;
    await engine.routeAudioElement();
    ui.sourceLabel.textContent = 'FILE / LOCAL AUDIO';
    ui.trackTitle.textContent = file.name.replace(/\.[^.]+$/, '');
    ui.trackDetail.textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · stays on this device`;
    await ui.audioElement.play();
    state.playing = true;
    engine.setGain(state.desiredGain);
    tell('Local audio routed. The file never leaves your browser.');
    updateTransport();
  } catch (error) {
    tell(error.message || 'This audio file could not be played.', 'error');
  }
});

ui.audioElement.addEventListener('ended', () => {
  state.playing = false;
  updateTransport();
});

ui.mic.addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    tell('Microphone capture is not available in this browser.', 'error');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    await engine.routeStream(stream, 'mic');
    ui.sourceLabel.textContent = 'LIVE / MICROPHONE';
    ui.trackTitle.textContent = 'Microphone input';
    ui.trackDetail.textContent = 'Unmonitored to prevent acoustic feedback';
    tell('Microphone is routed to analysis only; it is intentionally not played back through the speakers.');
    updateTransport();
  } catch (error) {
    if (error.name === 'NotAllowedError') tell('Microphone permission was not granted.', 'error');
    else tell(error.message || 'Could not open the microphone.', 'error');
  }
});

ui.play.addEventListener('click', async () => {
  try {
    if (!state.sourceType) {
      await startSynth();
      return;
    }
    await engine.toggle();
    updateTransport();
  } catch (error) {
    tell(error.message || 'Playback could not be changed.', 'error');
  }
});

ui.startDemo.addEventListener('click', () => startSynth());
ui.synth.addEventListener('click', () => startSynth());
ui.sendToScope.addEventListener('click', async () => {
  setMode('lissajous');
  await startSynth({ jumpToScope: true });
});

ui.gain.addEventListener('input', () => engine.setGain(Number(ui.gain.value)));
[ui.freqA, ui.freqB, ui.phase, ui.trail].forEach((input) => input.addEventListener('input', updateMathUi));

$$('.preset-row button').forEach((button) => {
  button.addEventListener('click', () => {
    const [a, b] = button.dataset.ratio.split(':').map(Number);
    const base = 110;
    ui.freqA.value = String(a * base);
    ui.freqB.value = String(b * base);
    updateMathUi();
  });
});

$$('.mode-btn').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));

document.addEventListener('keydown', async (event) => {
  const tag = document.activeElement?.tagName;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
  if (typing) return;

  if (event.code === 'Space') {
    event.preventDefault();
    if (!state.sourceType) await startSynth(); else { await engine.toggle(); updateTransport(); }
  }
  if (event.key >= '1' && event.key <= '4') {
    const modes = ['time', 'spectrum', 'lissajous', 'particles'];
    setMode(modes[Number(event.key) - 1]);
  }
  if (event.key.toLowerCase() === 's') await startSynth();
});

const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) entry.target.dataset.visible = 'true';
  });
}, { threshold: .12 });

$$('.source-card, .concept-grid article, .project-row, .profile-columns > div').forEach((element) => {
  element.style.opacity = '0';
  element.style.transform = 'translateY(14px)';
  element.style.transition = 'opacity .55s ease, transform .55s ease';
  revealObserver.observe(element);
});

const style = document.createElement('style');
style.textContent = `[data-visible="true"]{opacity:1!important;transform:translateY(0)!important}`;
document.head.append(style);

updateMathUi();
updateTransport();
resizeCanvas();
ui.fft.textContent = '2048';
tell('Ready. Start the synth, choose a local file, use a microphone, or load YouTube and capture tab audio.');
