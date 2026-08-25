const $ = (selector) => document.querySelector(selector);

const ui = {
  file: $('#toneCopyFile'),
  capture: $('#toneCaptureBtn'),
  stopCapture: $('#toneStopCaptureBtn'),
  sourceName: $('#toneSourceName'),
  fftSize: $('#toneFftSize'),
  overlap: $('#toneOverlap'),
  build: $('#toneBuildBtn'),
  progressBar: $('#toneProgressBar'),
  progressText: $('#toneProgressText'),
  results: $('#toneResults'),
  duration: $('#toneDuration'),
  sampleRate: $('#toneSampleRate'),
  channels: $('#toneChannels'),
  fftReadout: $('#toneFftReadout'),
  frames: $('#toneFrames'),
  bins: $('#toneBins'),
  originalPlayer: $('#toneOriginalPlayer'),
  copyPlayer: $('#toneCopyPlayer'),
  sendAnalyzer: $('#toneSendAnalyzerBtn'),
  download: $('#toneDownloadBtn'),
};

if (Object.values(ui).every(Boolean)) {
  const state = {
    sourceArrayBuffer: null,
    sourceBlob: null,
    sourceName: '',
    sourceUrl: null,
    outputBlob: null,
    outputUrl: null,
    mediaRecorder: null,
    captureStream: null,
    captureChunks: [],
    processing: false,
  };

  class FFT {
    constructor(size) {
      if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two.');
      this.size = size;
      this.reverse = new Uint32Array(size);
      const bits = Math.log2(size);
      for (let i = 0; i < size; i++) {
        let x = i;
        let y = 0;
        for (let b = 0; b < bits; b++) {
          y = (y << 1) | (x & 1);
          x >>>= 1;
        }
        this.reverse[i] = y;
      }
    }

    transform(real, imag, inverse = false) {
      const n = this.size;
      for (let i = 0; i < n; i++) {
        const j = this.reverse[i];
        if (j <= i) continue;
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }

      for (let len = 2; len <= n; len <<= 1) {
        const angle = (inverse ? 2 : -2) * Math.PI / len;
        const stepCos = Math.cos(angle);
        const stepSin = Math.sin(angle);
        const half = len >> 1;

        for (let start = 0; start < n; start += len) {
          let wReal = 1;
          let wImag = 0;
          for (let j = 0; j < half; j++) {
            const even = start + j;
            const odd = even + half;
            const oddReal = real[odd] * wReal - imag[odd] * wImag;
            const oddImag = real[odd] * wImag + imag[odd] * wReal;
            const evenReal = real[even];
            const evenImag = imag[even];

            real[even] = evenReal + oddReal;
            imag[even] = evenImag + oddImag;
            real[odd] = evenReal - oddReal;
            imag[odd] = evenImag - oddImag;

            const nextReal = wReal * stepCos - wImag * stepSin;
            wImag = wReal * stepSin + wImag * stepCos;
            wReal = nextReal;
          }
        }
      }

      if (inverse) {
        for (let i = 0; i < n; i++) {
          real[i] /= n;
          imag[i] /= n;
        }
      }
    }
  }

  function hann(size) {
    const window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    }
    return window;
  }

  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function setProgress(value, text) {
    const pct = Math.max(0, Math.min(1, value));
    ui.progressBar.style.width = `${(pct * 100).toFixed(1)}%`;
    ui.progressText.textContent = text;
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(seconds));
    const minutes = Math.floor(total / 60);
    const secs = String(total % 60).padStart(2, '0');
    return `${minutes}:${secs}`;
  }

  async function decodeSource(arrayBuffer) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('Web Audio is not available in this browser.');
    const ctx = new AudioContext();
    try {
      return await ctx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      await ctx.close();
    }
  }

  async function resynthesizeChannel(input, fftSize, hopSize, fft, window, onProgress) {
    const output = new Float32Array(input.length);
    const normalization = new Float32Array(input.length);
    const real = new Float64Array(fftSize);
    const imag = new Float64Array(fftSize);
    const firstStart = -fftSize;
    const lastStart = input.length + fftSize;
    const frameCount = Math.ceil((lastStart - firstStart) / hopSize);
    let frameIndex = 0;

    for (let start = firstStart; start < lastStart; start += hopSize) {
      for (let i = 0; i < fftSize; i++) {
        const sourceIndex = start + i;
        const sample = sourceIndex >= 0 && sourceIndex < input.length ? input[sourceIndex] : 0;
        real[i] = sample * window[i];
        imag[i] = 0;
      }

      // Forward FFT produces the complete complex spectrum X[k] = Re + iIm.
      fft.transform(real, imag, false);

      // No bins are thrown away. The inverse transform is fed the same measured
      // complex coefficients, preserving both magnitude and phase information.
      fft.transform(real, imag, true);

      for (let i = 0; i < fftSize; i++) {
        const outputIndex = start + i;
        if (outputIndex < 0 || outputIndex >= output.length) continue;
        const weight = window[i];
        output[outputIndex] += real[i] * weight;
        normalization[outputIndex] += weight * weight;
      }

      frameIndex++;
      if ((frameIndex & 15) === 0) {
        onProgress(frameIndex / frameCount);
        await nextFrame();
      }
    }

    for (let i = 0; i < output.length; i++) {
      if (normalization[i] > 1e-9) output[i] /= normalization[i];
    }

    onProgress(1);
    return { output, frameCount };
  }

  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  function encodeWav(channels, sampleRate) {
    const channelCount = channels.length;
    const frames = channels[0].length;
    const bytesPerSample = 2;
    const blockAlign = channelCount * bytesPerSample;
    const dataSize = frames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channelCount, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let frame = 0; frame < frames; frame++) {
      for (let channel = 0; channel < channelCount; channel++) {
        const sample = Math.max(-1, Math.min(1, channels[channel][frame]));
        const pcm = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
        view.setInt16(offset, pcm, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: 'audio/wav' });
  }

  function clearObjectUrl(key) {
    if (state[key]) URL.revokeObjectURL(state[key]);
    state[key] = null;
  }

  async function loadArrayBuffer(arrayBuffer, name, sourceBlob = null) {
    state.sourceArrayBuffer = arrayBuffer;
    state.sourceBlob = sourceBlob;
    state.sourceName = name;
    clearObjectUrl('sourceUrl');

    if (sourceBlob) {
      state.sourceUrl = URL.createObjectURL(sourceBlob);
      ui.originalPlayer.src = state.sourceUrl;
    } else {
      const blob = new Blob([arrayBuffer]);
      state.sourceUrl = URL.createObjectURL(blob);
      ui.originalPlayer.src = state.sourceUrl;
    }

    clearObjectUrl('outputUrl');
    state.outputBlob = null;
    ui.copyPlayer.removeAttribute('src');
    ui.results.hidden = true;
    ui.sourceName.textContent = name;
    ui.build.disabled = false;
    setProgress(0, 'Ready to analyze');
  }

  ui.file.addEventListener('change', async () => {
    const file = ui.file.files?.[0];
    if (!file) return;
    try {
      setProgress(0, 'Reading audio file');
      const arrayBuffer = await file.arrayBuffer();
      await loadArrayBuffer(arrayBuffer, file.name, file);
    } catch (error) {
      setProgress(0, error.message || 'Could not read this audio file');
    }
  });

  ui.capture.addEventListener('click', async () => {
    if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
      setProgress(0, 'Browser-tab recording is not available in this browser');
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

      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error('The selected tab did not provide audio. Enable Share tab audio and try again.');
      }

      const audioStream = new MediaStream(audioTracks);
      const mimeCandidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/ogg;codecs=opus',
      ];
      const mimeType = mimeCandidates.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType ? new MediaRecorder(audioStream, { mimeType }) : new MediaRecorder(audioStream);

      state.captureStream = stream;
      state.captureChunks = [];
      state.mediaRecorder = recorder;

      recorder.addEventListener('dataavailable', (event) => {
        if (event.data?.size) state.captureChunks.push(event.data);
      });

      recorder.addEventListener('stop', async () => {
        try {
          const blob = new Blob(state.captureChunks, { type: recorder.mimeType || 'audio/webm' });
          if (!blob.size) throw new Error('No audio was recorded.');
          const arrayBuffer = await blob.arrayBuffer();
          await loadArrayBuffer(arrayBuffer, 'Recorded browser-tab audio', blob);
        } catch (error) {
          setProgress(0, error.message || 'Could not decode the recorded tab audio');
        } finally {
          state.captureStream?.getTracks().forEach((track) => track.stop());
          state.captureStream = null;
          state.mediaRecorder = null;
          ui.capture.hidden = false;
          ui.stopCapture.hidden = true;
        }
      });

      recorder.start(250);
      ui.capture.hidden = true;
      ui.stopCapture.hidden = false;
      ui.sourceName.textContent = 'Recording browser-tab audio…';
      setProgress(0, 'Recording real tab audio');

      stream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (recorder.state === 'recording') recorder.stop();
        }, { once: true });
      });
    } catch (error) {
      setProgress(0, error.name === 'NotAllowedError' ? 'Tab capture was cancelled' : (error.message || 'Could not start tab recording'));
    }
  });

  ui.stopCapture.addEventListener('click', () => {
    if (state.mediaRecorder?.state === 'recording') state.mediaRecorder.stop();
  });

  ui.build.addEventListener('click', async () => {
    if (!state.sourceArrayBuffer || state.processing) return;
    state.processing = true;
    ui.build.disabled = true;
    ui.results.hidden = true;

    try {
      setProgress(0.01, 'Decoding PCM samples');
      const audioBuffer = await decodeSource(state.sourceArrayBuffer);
      const fftSize = Number(ui.fftSize.value);
      const overlapDivisor = Number(ui.overlap.value);
      const hopSize = Math.max(1, Math.floor(fftSize / overlapDivisor));
      const fft = new FFT(fftSize);
      const window = hann(fftSize);
      const outputs = [];
      let framesPerChannel = 0;

      for (let channel = 0; channel < audioBuffer.numberOfChannels; channel++) {
        const input = audioBuffer.getChannelData(channel);
        const result = await resynthesizeChannel(
          input,
          fftSize,
          hopSize,
          fft,
          window,
          (channelProgress) => {
            const overall = (channel + channelProgress) / audioBuffer.numberOfChannels;
            setProgress(overall * 0.92, `Complex STFT · channel ${channel + 1}/${audioBuffer.numberOfChannels} · ${Math.round(channelProgress * 100)}%`);
          },
        );
        outputs.push(result.output);
        framesPerChannel = result.frameCount;
      }

      setProgress(0.95, 'Encoding Tone Copy WAV');
      await nextFrame();
      const wavBlob = encodeWav(outputs, audioBuffer.sampleRate);
      clearObjectUrl('outputUrl');
      state.outputBlob = wavBlob;
      state.outputUrl = URL.createObjectURL(wavBlob);
      ui.copyPlayer.src = state.outputUrl;
      ui.download.href = state.outputUrl;
      const safeName = (state.sourceName || 'song').replace(/\.[^.]+$/, '').replace(/[^a-z0-9-_]+/gi, '-').replace(/^-|-$/g, '') || 'song';
      ui.download.download = `${safeName}-tone-copy.wav`;

      const complexBins = framesPerChannel * fftSize * audioBuffer.numberOfChannels;
      ui.duration.textContent = formatDuration(audioBuffer.duration);
      ui.sampleRate.textContent = `${audioBuffer.sampleRate.toLocaleString()} Hz`;
      ui.channels.textContent = String(audioBuffer.numberOfChannels);
      ui.fftReadout.textContent = String(fftSize);
      ui.frames.textContent = (framesPerChannel * audioBuffer.numberOfChannels).toLocaleString();
      ui.bins.textContent = complexBins.toLocaleString();
      ui.results.hidden = false;
      setProgress(1, 'Tone Copy built from the full complex spectrum');
    } catch (error) {
      console.error(error);
      setProgress(0, error.message || 'Tone Copy could not process this audio');
    } finally {
      state.processing = false;
      ui.build.disabled = !state.sourceArrayBuffer;
    }
  });

  ui.sendAnalyzer.addEventListener('click', async () => {
    if (!state.outputBlob) return;
    if (typeof window.oscilloscopeLoadBlob === 'function') {
      await window.oscilloscopeLoadBlob(state.outputBlob, `${state.sourceName || 'Tone Copy'} · resynthesized`);
      document.querySelector('#instrument')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  window.addEventListener('beforeunload', () => {
    state.captureStream?.getTracks().forEach((track) => track.stop());
    clearObjectUrl('sourceUrl');
    clearObjectUrl('outputUrl');
  });
}