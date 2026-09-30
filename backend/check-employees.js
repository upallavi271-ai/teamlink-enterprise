const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const employees = await prisma.employee.findMany({
    select: {
      id: true,
      employeeCode: true,
      name: true,
      phone: true,
      department: true,
      designation: true,
      employmentStatus: true
    },
    orderBy: {
      id: 'asc'
    }
  });

  console.log('LOCAL EMPLOYEE COUNT:', employees.length);
  console.table(employees);
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());