function waitForAudioClock(audio, longestWait) {
  return new Promise((done) => {
    const giveUpAt = performance.now() + longestWait;

    function check() {
      if (audio.currentTime > 0 || performance.now() > giveUpAt) {
        done();
        return;
      }

      setTimeout(check, 8);
    }

    audio.resume().catch(() => {});
    check();
  });
}

function readOutputDelay(audio) {
  return audio.outputLatency || audio.baseLatency || 0;
}
