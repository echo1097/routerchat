const splash = document.querySelector(".splash");
const progressFill = document.getElementById("progressFill");
const statusLine = document.getElementById("statusLine");

const longestAudioWait = 600;
const soundLead = 25;
const soundMuted = new URLSearchParams(window.location.search).get("sound") === "off";

const audio = soundMuted ? null : new AudioContext();
const sounds = audio ? createStartupSounds(audio) : null;

function startIntroSound(popDelay) {
  if (!sounds) {
    return;
  }

  const soundDelay = Math.max(0, (popDelay - soundLead) / 1000 - readOutputDelay(audio));

  sounds.playIntro(audio.currentTime, soundDelay);
}

window.setStatus = (text, progress) => {
  if (text !== statusLine.textContent) {
    statusLine.textContent = text;
    statusLine.classList.remove("changed");
    void statusLine.offsetWidth;
    statusLine.classList.add("changed");
  }

  if (typeof progress === "number") {
    progressFill.style.transform = `scaleX(${progress / 100})`;
  }
};

window.leaveSplash = () => {
  splash.classList.add("leaving");

  if (sounds) {
    sounds.playReady(audio.currentTime);
  }
};

const audioReady = audio ? waitForAudioClock(audio, longestAudioWait) : Promise.resolve();

audioReady.then(() => playIntro(splash, startIntroSound));
