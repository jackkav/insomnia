/** @type { import('@jest/types').Config.InitialOptions } */
module.exports = {
  collectCoverage: false,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  resetMocks: true,
  resetModules: true,
  testEnvironment: 'node',
  testRegex: ['.+\\.test\\.tsx?$'],
  verbose: false,
};
