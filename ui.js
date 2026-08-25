(() => {
  const toneStyles = document.createElement('link');
  toneStyles.rel = 'stylesheet';
  toneStyles.href = './tone-copy.css';
  document.head.append(toneStyles);

  window.oscilloscopeLoadBlob = async (blob, label = 'Tone Copy') => {
    const input = document.getElementById('audioFile');
    if (!input) throw new Error('Analyzer audio input was not found.');
    const safe = label.replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '') || 'tone-copy';
    const file = new File([blob], `${safe}.wav`, { type: blob.type || 'audio/wav' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const body = document.body;
  const stage = document.querySelector('.analyzer-stage');
  const frame = document.getElementById('analyzerFrame');
  const floatButton = document.getElementById('floatAnalyzerBtn');
  const controlsButton = document.getElementById('analyzerControlsToggle');
  const controls = document.getElementById('instrument-controls');
  const actions = frame?.querySelector('.instrument-head-actions');

  if (!stage || !frame || !floatButton || !controlsButton || !controls || !actions) return;

  const minimizeButton = document.createElement('button');
  minimizeButton.className = 'mini-tool-btn analyzer-minimize-btn';
  minimizeButton.id = 'minimizeAnalyzerBtn';
  minimizeButton.type = 'button';
  minimizeButton.textContent = 'Minimize';
  minimizeButton.setAttribute('aria-pressed', 'false');
  minimizeButton.setAttribute('aria-label', 'Minimize floating analyzer');
  actions.append(minimizeButton);

  let floatEnabled = sessionStorage.getItem('oscilloscope-float') !== 'off';
  let minimized = sessionStorage.getItem('oscilloscope-minimized') === 'on';
  let ticking = false;

  function setFloatButton() {
    floatButton.textContent = `Float: ${floatEnabled ? 'on' : 'off'}`;
    floatButton.setAttribute('aria-pressed', String(floatEnabled));
  }

  function setMinimizeButton() {
    minimizeButton.textContent = minimized ? 'Expand' : 'Minimize';
    minimizeButton.setAttribute('aria-pressed', String(minimized));
    minimizeButton.setAttribute('aria-label', minimized ? 'Expand floating analyzer' : 'Minimize floating analyzer');
  }

  function updateFloatingState() {
    ticking = false;
    const rect = stage.getBoundingClientRect();
    const hasPassedAnalyzer = rect.bottom < 76;
    const shouldFloat = floatEnabled && hasPassedAnalyzer;

    body.classList.toggle('analyzer-floating', shouldFloat);
    body.classList.toggle('analyzer-minimized', shouldFloat && minimized);

    if (!shouldFloat) {
      body.classList.remove('analyzer-controls-open');
      controlsButton.setAttribute('aria-expanded', 'false');
      controlsButton.textContent = 'Controls';
    }
  }

  function requestFloatingUpdate() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateFloatingState);
  }

  floatButton.addEventListener('click', () => {
    floatEnabled = !floatEnabled;
    sessionStorage.setItem('oscilloscope-float', floatEnabled ? 'on' : 'off');
    setFloatButton();
    updateFloatingState();
  });

  minimizeButton.addEventListener('click', () => {
    minimized = !minimized;
    sessionStorage.setItem('oscilloscope-minimized', minimized ? 'on' : 'off');
    if (minimized) {
      body.classList.remove('analyzer-controls-open');
      controlsButton.setAttribute('aria-expanded', 'false');
      controlsButton.textContent = 'Controls';
    }
    setMinimizeButton();
    updateFloatingState();
  });

  controlsButton.addEventListener('click', () => {
    if (body.classList.contains('analyzer-floating')) {
      if (body.classList.contains('analyzer-minimized')) {
        minimized = false;
        sessionStorage.setItem('oscilloscope-minimized', 'off');
        setMinimizeButton();
        updateFloatingState();
      }
      const open = !body.classList.contains('analyzer-controls-open');
      body.classList.toggle('analyzer-controls-open', open);
      controlsButton.setAttribute('aria-expanded', String(open));
      controlsButton.textContent = open ? 'Close controls' : 'Controls';
      return;
    }

    controls.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  window.addEventListener('scroll', requestFloatingUpdate, { passive: true });
  window.addEventListener('resize', requestFloatingUpdate);

  setFloatButton();
  setMinimizeButton();
  updateFloatingState();
})();