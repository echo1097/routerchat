function playPitchDrop(engine, startTime, fromPitch, toPitch, length, level) {
  const tone = engine.audio.createOscillator();
  const envelope = engine.audio.createGain();

  tone.type = "sine";
  tone.frequency.setValueAtTime(fromPitch, startTime);
  tone.frequency.exponentialRampToValueAtTime(toPitch, startTime + length * 0.7);

  envelope.gain.setValueAtTime(0.0001, startTime);
  envelope.gain.exponentialRampToValueAtTime(level, startTime + 0.006);
  envelope.gain.exponentialRampToValueAtTime(0.0001, startTime + length);

  tone.connect(envelope);
  envelope.connect(engine.input);

  tone.start(startTime);
  tone.stop(startTime + length + 0.05);
}

function playThump(engine, startTime, level) {
  playPitchDrop(engine, startTime, 150, 46, 0.34, level);
}
