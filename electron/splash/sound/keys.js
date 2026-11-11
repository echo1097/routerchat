function addKeyLayer(engine, envelope, type, frequency, level, detune, startTime, stopTime) {
  const layer = engine.audio.createOscillator();
  const layerLevel = engine.audio.createGain();

  layer.type = type;
  layer.frequency.value = frequency;
  layer.detune.value = detune;
  layerLevel.gain.value = level;

  engine.wobble.connect(layer.detune);
  layer.connect(layerLevel);
  layerLevel.connect(envelope);

  layer.start(startTime);
  layer.stop(stopTime);
}

function playKey(engine, frequency, startTime, length, level) {
  const envelope = engine.audio.createGain();
  const stopTime = startTime + length + 0.05;

  envelope.gain.setValueAtTime(0.0001, startTime);
  envelope.gain.exponentialRampToValueAtTime(level, startTime + 0.012);
  envelope.gain.exponentialRampToValueAtTime(level * 0.45, startTime + 0.18);
  envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + length);
  envelope.connect(engine.input);

  addKeyLayer(engine, envelope, "sine", frequency, 1, 0, startTime, stopTime);
  addKeyLayer(engine, envelope, "triangle", frequency, 0.3, 7, startTime, stopTime);
  addKeyLayer(engine, envelope, "sine", frequency * 2, 0.14, -5, startTime, stopTime);
}
