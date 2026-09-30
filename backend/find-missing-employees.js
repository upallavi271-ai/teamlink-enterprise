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

  const vpsText = fs.readFileSync('./vps-employees.txt', 'utf8');

  const vpsCodes = new Set();

  for (const line of vpsText.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+\|/);

    if (match && match[1] !== 'VPS') {
      vpsCodes.add(match[1]);
    }
  }

  console.log('');
  console.log('========================================');
  console.log(' EMPLOYEE DATABASE COMPARISON');
  console.log('========================================');
  console.log('');
  console.log('LOCAL EMPLOYEE COUNT:', localEmployees.length);
  console.log('VPS EMPLOYEE COUNT:', vpsCodes.size);
  console.log('');
  console.log('LOCAL EMPLOYEES NOT FOUND ON VPS:');
  console.log('----------------------------------------');

  let missingCount = 0;

  for (const employee of localEmployees) {
    const code = employee.employeeCode;

    if (!vpsCodes.has(code)) {
      missingCount++;

      console.log(
        `${code || '(NO CODE)'} | ${employee.name || ''} | ${employee.phone || ''} | ${employee.department || ''} | ${employee.designation || ''} | ${employee.employmentStatus || ''}`
      );
    }
  }

  console.log('');
  console.log('MISSING ON VPS:', missingCount);
  console.log('');
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());