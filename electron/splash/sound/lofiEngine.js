function makeSoftClipCurve() {
  const curve = new Float32Array(1024);
  const driveAmount = 1.6;

  for (let i = 0; i < curve.length; i += 1) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * driveAmount) / Math.tanh(driveAmount);
  }

  return curve;
}

function createTapeWobble(audio) {
  const wobble = audio.createOscillator();
  const wobbleDepth = audio.createGain();

  wobble.frequency.value = 0.8;
  wobbleDepth.gain.value = 9;
  wobble.connect(wobbleDepth);
  wobble.start();

  return wobbleDepth;
}

function createEcho(audio) {
  const echo = audio.createDelay(1);
  const echoTone = audio.createBiquadFilter();
  const echoFeedback = audio.createGain();
  const echoLevel = audio.createGain();

  echo.delayTime.value = 0.21;
  echoTone.type = "lowpass";
  echoTone.frequency.value = 1400;
  echoFeedback.gain.value = 0.3;
  echoLevel.gain.value = 0.24;

  echo.connect(echoTone);
  echoTone.connect(echoFeedback);
  echoFeedback.connect(echo);
  echoTone.connect(echoLevel);

  return { echo, echoLevel };
}

function createLofiEngine(audio) {
  const input = audio.createGain();
  const drive = audio.createWaveShaper();
  const warmth = audio.createBiquadFilter();
  const rumbleCut = audio.createBiquadFilter();
  const limiter = audio.createDynamicsCompressor();
  const volume = audio.createGain();
  const { echo, echoLevel } = createEcho(audio);

  drive.curve = makeSoftClipCurve();

  warmth.type = "lowpass";
  warmth.frequency.value = 2600;
  warmth.Q.value = 0.6;

  rumbleCut.type = "highpass";
  rumbleCut.frequency.value = 45;

  limiter.threshold.value = -14;
  limiter.ratio.value = 4;
  limiter.attack.value = 0.004;
  limiter.release.value = 0.2;

  volume.gain.value = 0.42;

  input.connect(drive);
  drive.connect(warmth);
  warmth.connect(rumbleCut);
  rumbleCut.connect(limiter);
  rumbleCut.connect(echo);
  echoLevel.connect(limiter);
  limiter.connect(volume);
  volume.connect(audio.destination);

  return { audio, input, volume, wobble: createTapeWobble(audio) };
}
