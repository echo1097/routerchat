const milestones = [
  ["Started server process", 40],
  ["Waiting for application startup", 55],
  ["Application startup complete", 75],
  ["Uvicorn running", 88],
];

export function readLogStatus(line) {
  const text = line.replace(/^[A-Z]+:\s+/, "").trim();

  if (!text || text.includes("/api/health")) {
    return null;
  }

  const milestone = milestones.find(([marker]) => text.includes(marker));

  return { text, progress: milestone ? milestone[1] : null };
}
