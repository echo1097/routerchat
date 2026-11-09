import { createInterface } from "node:readline";

export function forwardLogs(backend, onLog) {
  const logStreams = [
    [backend.stdout, process.stdout],
    [backend.stderr, process.stderr],
  ];

  for (const [source, terminal] of logStreams) {
    const lines = createInterface({ input: source });

    lines.on("line", (line) => {
      terminal.write(`${line}\n`);
      onLog(line);
    });
  }
}
