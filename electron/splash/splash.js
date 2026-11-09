const splash = document.querySelector(".splash");
const progressFill = document.getElementById("progressFill");
const statusLine = document.getElementById("statusLine");

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
};
