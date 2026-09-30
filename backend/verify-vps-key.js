const fs = require("fs");
const crypto = require("crypto");

const env = fs.readFileSync("/opt/teamlink-enterprise/backend/.env", "utf8");
const line = env.split(/\r?\n/).find(x => x.startsWith("INTEGRATION_SECRET_KEY="));

if (!line) {
  console.error("KEY NOT FOUND");
  process.exit(1);
}

let key = line.substring("INTEGRATION_SECRET_KEY=".length).trim();

if (key.startsWith('"') && key.endsWith('"')) {
  key = key.slice(1, -1);
}

console.log("VPS fingerprint:");
console.log(
  crypto.createHash("sha256").update(key, "utf8").digest("hex").toUpperCase()
);
