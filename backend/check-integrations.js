const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.integration.findMany({
    select: {
      id: true,
      enabled: true,
      connected: true,
      state: true,
      values: true,
      connectedAt: true,
      lastTest: true,
      lastTestResult: true,
      error: true
    }
  });

  for (const row of rows) {
    let values = row.values;

    if (typeof values === "string") {
      try {
        values = JSON.parse(values);
      } catch {}
    }

    if (values && typeof values === "object") {
      for (const key of Object.keys(values)) {
        const k = key.toLowerCase();

        if (
          k.includes("key") ||
          k.includes("token") ||
          k.includes("secret") ||
          k.includes("password")
        ) {
          values[key] = "[HIDDEN]";
        }
      }
    }

    console.log(JSON.stringify({
      id: row.id,
      enabled: row.enabled,
      connected: row.connected,
      state: row.state,
      values,
      connectedAt: row.connectedAt,
      lastTest: row.lastTest,
      lastTestResult: row.lastTestResult,
      error: row.error
    }, null, 2));
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
