const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.integration.findMany({
    where: { provider: "ai-claude" },
    select: {
      id: true,
      provider: true,
      enabled: true,
      connected: true,
      state: true,
      config: true
    }
  });

  for (const row of rows) {
    let config = row.config;

    if (typeof config === "string") {
      try { config = JSON.parse(config); } catch {}
    }

    if (config && typeof config === "object") {
      for (const key of Object.keys(config)) {
        const k = key.toLowerCase();
        if (k.includes("key") || k.includes("token") || k.includes("secret")) {
          config[key] = "[HIDDEN]";
        }
      }
    }

    console.log({
      id: row.id,
      provider: row.provider,
      enabled: row.enabled,
      connected: row.connected,
      state: row.state,
      config
    });
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
