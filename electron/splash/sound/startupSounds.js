const landingChord = [155.56, 196.0, 233.08, 293.66, 349.23];
const bassNote = 77.78;
const readyNotes = [466.16, 587.33, 698.46];
const strumGap = 0.045;

function createStartupSounds(audio) {
  const engine = createLofiEngine(audio);
  let crackleLevel = null;

  function playIntro(startTime, landTime) {
    crackleLevel = startCrackle(engine, startTime);

    playThump(engine, startTime + landTime, 0.75);
    playKey(engine, bassNote, startTime + landTime, 1.6, 0.3);

    landingChord.forEach((frequency, index) => {
      playKey(engine, frequency, startTime + landTime + index * strumGap, 2.2, 0.2);
    });
  }

  function playReady(startTime) {
    readyNotes.forEach((frequency, index) => {
      playKey(engine, frequency, startTime + index * 0.085, 1.1, 0.17);
    });

    if (crackleLevel) {
      fadeCrackle(engine, crackleLevel, startTime, 1.2);
    }
  }

  return { playIntro, playReady };
}
