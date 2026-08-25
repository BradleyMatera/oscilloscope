(() => {
  const body = document.body;
  const stage = document.querySelector('.analyzer-stage');
  const frame = document.getElementById('analyzerFrame');
  const floatButton = document.getElementById('floatAnalyzerBtn');
  const controlsButton = document.getElementById('analyzerControlsToggle');
  const controls = document.getElementById('instrument-controls');

  if (!stage || !frame || !floatButton || !controlsButton || !controls) return;

  let floatEnabled = sessionStorage.getItem('oscilloscope-float') !== 'off';
  let ticking = false;

  function setFloatButton() {
    floatButton.textContent = `Float: ${floatEnabled ? 'on' : 'off'}`;
    floatButton.setAttribute('aria-pressed', String(floatEnabled));
  }

  function updateFloatingState() {
    ticking = false;
    const rect = stage.getBoundingClientRect();
    const hasPassedAnalyzer = rect.bottom < 76;
    const shouldFloat = floatEnabled && hasPassedAnalyzer;

    body.classList.toggle('analyzer-floating', shouldFloat);

    if (!shouldFloat) {
      body.classList.remove('analyzer-controls-open');
      controlsButton.setAttribute('aria-expanded', 'false');
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

  controlsButton.addEventListener('click', () => {
    if (body.classList.contains('analyzer-floating')) {
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
  updateFloatingState();
})();
