const { createInterface } = require("node:readline");
const { spawn } = require("node-pty");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let terminal;
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
lines.on("line", line => {
  try {
    const request = JSON.parse(line);
    if (request.kind === "open" && !terminal) {
      terminal = spawn(request.file, request.args, request.options);
      terminal.onData(data => send({ kind: "data", data }));
      terminal.onExit(({ exitCode }) => { send({ kind: "exit", exitCode }); lines.close(); process.stdin.destroy(); });
      send({ kind: "ready" });
    } else if (request.kind === "write") terminal?.write(request.text);
    else if (request.kind === "resize") terminal?.resize(request.cols, request.rows);
    else if (request.kind === "close") terminal?.kill();
  } catch (error) { send({ kind: "error", message: error.message }); terminal?.kill(); process.exitCode = 1; lines.close(); process.stdin.destroy(); }
});
lines.on("close", () => { terminal?.kill(); });
process.on("exit", () => { terminal?.kill(); });
