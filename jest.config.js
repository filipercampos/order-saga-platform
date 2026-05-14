/** @type {import('jest').Config} */
const transform = { '^.+\\.ts$': 'ts-jest' };
const common = {
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform,
  moduleNameMapper: { '^@saga/(.*)$': '<rootDir>/libs/$1/src' },
};

module.exports = {
  projects: [
    {
      ...common,
      displayName: 'unit',
      testMatch: ['<rootDir>/apps/**/*.spec.ts', '<rootDir>/libs/**/*.spec.ts'],
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
    },
  ],
  collectCoverageFrom: ['{apps,libs}/**/src/**/*.ts', '!**/main.ts', '!**/*.module.ts'],
};
