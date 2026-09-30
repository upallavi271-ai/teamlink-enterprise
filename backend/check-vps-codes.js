const { PrismaClient } = require('/opt/teamlink-enterprise/backend/node_modules/@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const employees = await prisma.employee.findMany({
    select: {
      employeeCode: true
    },
    orderBy: {
      employeeCode: 'asc'
    }
  });

  console.log('VPS EMPLOYEE COUNT:', employees.length);

  for (const employee of employees) {
    console.log(employee.employeeCode || '(NO CODE)');
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());