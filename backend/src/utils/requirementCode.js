// REQ-0001, REQ-0002 ... the human-facing Requirement ID. ONE place: Add Requirement (routes/requirements.js) and the Excel import
// (routes/dataImport.js: a sheet with no Requirement Code column gets a code per NEW requirement) both use it.
const prisma = require('../db');

async function nextRequirementCode() {
  const used = await prisma.requirement.count();
  for (let n = used + 1; n < used + 500; n += 1) {
    const code = `REQ-${String(n).padStart(4, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const clash = await prisma.requirement.findFirst({ where: { reqCode: code }, select: { id: true } });
    if (!clash) return code;
  }
  return `REQ-${Date.now()}`;
}

module.exports = { nextRequirementCode };
