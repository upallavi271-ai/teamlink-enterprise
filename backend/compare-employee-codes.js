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

  const lines = fs.readFileSync('./vps-codes.txt', 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim());

  const countLine = lines.find(line =>
    line.startsWith('VPS EMPLOYEE COUNT:')
  );

  const reportedVpsCount = countLine
    ? Number(countLine.split(':')[1].trim())
    : 0;

  const vpsCodes = new Set(
    lines.filter(line =>
      line &&
      !line.startsWith('VPS EMPLOYEE COUNT:')
    )
  );

  console.log('');
  console.log('========================================');
  console.log(' LOCAL vs VPS EMPLOYEE CODES');
  console.log('========================================');
  console.log('');
  console.log('LOCAL DATABASE COUNT:', localEmployees.length);
  console.log('VPS REPORTED COUNT:', reportedVpsCount);
  console.log('VPS CODES IN FILE:', vpsCodes.size);
  console.log('');

  console.log('LOCAL EMPLOYEES NOT ON VPS:');
  console.log('----------------------------------------');

  let localOnly = 0;

  for (const employee of localEmployees) {
    const code = employee.employeeCode;

    if (!code || !vpsCodes.has(code)) {
      localOnly++;

      console.log(
        `${code || '(NO CODE)'} | ${employee.name || ''} | ${employee.phone || ''} | ${employee.department || ''} | ${employee.designation || ''} | ${employee.employmentStatus || ''}`
      );
    }
  }

  console.log('');
  console.log('TOTAL LOCAL-ONLY:', localOnly);
  console.log('');

  const localCodes = new Set(
    localEmployees
      .map(employee => employee.employeeCode)
      .filter(Boolean)
  );

  console.log('VPS EMPLOYEES NOT ON LOCAL:');
  console.log('----------------------------------------');

  let vpsOnly = 0;

  for (const code of vpsCodes) {
    if (!localCodes.has(code)) {
      vpsOnly++;
      console.log(code);
    }
  }

  console.log('');
  console.log('TOTAL VPS-ONLY:', vpsOnly);
  console.log('');
}

main()
  .catch(error => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());