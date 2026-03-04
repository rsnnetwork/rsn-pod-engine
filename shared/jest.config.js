/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  displayName: 'shared',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.json',
    }],
  },
  clearMocks: true,
  restoreMocks: true,
};