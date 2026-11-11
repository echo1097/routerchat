function makeCrackleBuffer(audio) {
  const seconds = 2;
  const buffer = audio.createBuffer(1, audio.sampleRate * seconds, audio.sampleRate);
  const samples = buffer.getChannelData(0);
  let popLevel = 0;

  for (let i = 0; i < samples.length; i += 1) {
    if (Math.random() < 0.0007) {
      popLevel = 0.3 + Math.random() * 0.6;
    }

    const hiss = (Math.random() * 2 - 1) * 0.02;
    const pop = (Math.random() * 2 - 1) * popLevel;

    samples[i] = hiss + pop;
    popLevel *= 0.86;
  }

  return buffer;
}

function startCrackle(engine, startTime) {
  const crackle = engine.audio.createBufferSource();
  const tone = engine.audio.createBiquadFilter();
  const level = engine.audio.createGain();

  crackle.buffer = makeCrackleBuffer(engine.audio);
  crackle.loop = true;

  tone.type = "bandpass";
  tone.frequency.value = 1800;
  tone.Q.value = 0.5;

  level.gain.setValueAtTime(0.0001, startTime);
  level.gain.exponentialRampToValueAtTime(0.22, startTime + 0.4);

  crackle.connect(tone);
  tone.connect(level);
  level.connect(engine.input);
  crackle.start(startTime);

  return level;
}

function fadeCrackle(engine, crackleLevel, startTime, length) {
  crackleLevel.gain.cancelScheduledValues(startTime);
  crackleLevel.gain.setValueAtTime(0.22, startTime);
  crackleLevel.gain.exponentialRampToValueAtTime(0.0001, startTime + length);
}
