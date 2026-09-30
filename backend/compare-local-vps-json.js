const fs = require('fs');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const localEmployees = await prisma.employee.findMany({
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

  const vpsEmployees = JSON.parse(
    fs.readFileSync('./vps-employees.json', 'utf8')
  );

  const vpsByCode = new Map(
    vpsEmployees
      .filter(e => e.employeeCode)
      .map(e => [e.employeeCode, e])
  );

  const localByCode = new Map(
    localEmployees
      .filter(e => e.employeeCode)
      .map(e => [e.employeeCode, e])
  );

  console.log('');
  console.log('========================================');
  console.log(' LOCAL vs VPS DATABASE COMPARISON');
  console.log('========================================');
  console.log('');
  console.log(`LOCAL EMPLOYEES: ${localEmployees.length}`);
  console.log(`VPS EMPLOYEES:   ${vpsEmployees.length}`);
  console.log('');

  console.log('LOCAL-ONLY EMPLOYEES');
  console.log('----------------------------------------');

  let localOnly = 0;

  for (const employee of localEmployees) {
    if (!employee.employeeCode || !vpsByCode.has(employee.employeeCode)) {
      localOnly++;

      console.log(
        `${employee.employeeCode || '(NO CODE)'} | ${employee.name || ''} | ${employee.phone || ''} | ${employee.department || ''} | ${employee.designation || ''} | ${employee.employmentStatus || ''}`
      );
    }
  }

  console.log('');
  console.log(`TOTAL LOCAL-ONLY: ${localOnly}`);
  console.log('');

  console.log('VPS-ONLY EMPLOYEES');
  console.log('----------------------------------------');

  let vpsOnly = 0;

  for (const employee of vpsEmployees) {
    if (!employee.employeeCode || !localByCode.has(employee.employeeCode)) {
      vpsOnly++;

      console.log(
        `${employee.employeeCode || '(NO CODE)'} | ${employee.name || ''} | ${employee.phone || ''} | ${employee.department || ''} | ${employee.designation || ''} | ${employee.employmentStatus || ''}`
      );
    }
  }

  console.log('');
  console.log(`TOTAL VPS-ONLY: ${vpsOnly}`);
  console.log('');
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());