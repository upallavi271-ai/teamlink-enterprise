const { PrismaClient } = require('@prisma/client');

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

  console.log('LOCAL EMPLOYEE COUNT:', employees.length);

  for (const employee of employees) {
    console.log(
      `${employee.employeeCode || '(NO CODE)'} | ${employee.name || ''} | ${employee.phone || ''} | ${employee.department || ''} | ${employee.designation || ''} | ${employee.employmentStatus || ''}`
    );
  }
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());