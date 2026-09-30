const { PrismaClient } = require("@prisma/client");
const fs = require("fs");

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.integration.findMany({
    orderBy: { id: "asc" }
  });

  fs.writeFileSync(
    "./integration-sync.json",
    JSON.stringify(rows, null, 2),
    "utf8"
  );

  console.log("Integration records exported:", rows.length);
  console.log("File: integration-sync.json");

  for (const row of rows) {
    console.log(
      row.id,
      "| enabled:", row.enabled,
      "| connected:", row.connected,
      "| state:", row.state
    );
  }
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
