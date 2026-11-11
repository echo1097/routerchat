const popDelay = 160;
const sparkCount = 10;

function addSparks(stage) {
  for (let i = 0; i < sparkCount; i += 1) {
    const spark = document.createElement("span");
    const angle = (i / sparkCount) * Math.PI * 2 + Math.random() * 0.4;
    const distance = 62 + Math.random() * 34;

    spark.className = "spark";
    spark.style.setProperty("--sparkX", `${Math.cos(angle) * distance}px`);
    spark.style.setProperty("--sparkY", `${Math.sin(angle) * distance * 0.7}px`);
    spark.style.setProperty("--sparkSize", `${3 + Math.random() * 4}px`);

    stage.appendChild(spark);
  }
}

function playIntro(splash, onStart) {
  addSparks(splash.querySelector(".stage"));
  splash.style.setProperty("--popDelay", `${popDelay}ms`);

  requestAnimationFrame(() => {
    splash.classList.add("playing");
    onStart(popDelay);
  });
}
