const fs = require("fs");

const env = fs.readFileSync("/opt/teamlink-enterprise/backend/.env", "utf8");

const line = env
  .split(/\r?\n/)
  .find(x => x.startsWith("INTEGRATION_SECRET_KEY="));

if (!line) {
  console.log("VPS key NOT FOUND");
  process.exit(1);
}

let key = line.substring("INTEGRATION_SECRET_KEY=".length).trim();

if (key.startsWith('"') && key.endsWith('"')) {
  key = key.slice(1, -1);
}

console.log("VPS key length:", key.length);
