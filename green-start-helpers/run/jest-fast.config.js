// TeamLink helper (NOT part of the Green Start zip): the product's own unit-test settings (gs-api/jest.config.js), only with ts-jest's type-check switched off
// so the 235 test files run in minutes on this busy computer (the compile step "nest build" already type-checked the code).
module.exports = {
  rootDir: '../gs-api/src',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/../tsconfig.json', isolatedModules: true, diagnostics: false }] },
  testEnvironment: 'node',
};
