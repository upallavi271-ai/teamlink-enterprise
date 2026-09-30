const fs = require('fs');
const { PrismaClient } = require('/opt/teamlink-enterprise/backend/node_modules/@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const employees = await prisma.employee.findMany({
    select: {
      employeeCode: true,
      name: true,
      phone: true,
      department: true,
      designation: true,
      employmentStatus: true
    },
    orderBy: {
      employeeCode: 'asc'
    }
  });

  fs.writeFileSync(
    '/root/vps-employees.json',
    JSON.stringify(employees, null, 2),
    'utf8'
  );

  console.log(`VPS JSON EXPORT SUCCESS: ${employees.length} employees`);
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());