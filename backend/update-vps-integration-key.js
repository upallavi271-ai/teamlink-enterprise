const fs = require("fs");

const envPath = "/opt/teamlink-enterprise/backend/.env";
const keyPath = "/tmp/integration-key.tmp";

let env = fs.readFileSync(envPath, "utf8");
let key = fs.readFileSync(keyPath, "utf8").trim();

if (key.length !== 64) {
  console.error("ERROR: temporary key is not 64 characters");
  process.exit(1);
}

if (!/^INTEGRATION_SECRET_KEY=/m.test(env)) {
  console.error("ERROR: INTEGRATION_SECRET_KEY not found in VPS .env");
  process.exit(1);
}

env = env.replace(
  /^INTEGRATION_SECRET_KEY=.*$/m,
  "INTEGRATION_SECRET_KEY=\"" + key + "\""
);

fs.writeFileSync(envPath, env);

console.log("VPS .env updated: INTEGRATION_SECRET_KEY only");
