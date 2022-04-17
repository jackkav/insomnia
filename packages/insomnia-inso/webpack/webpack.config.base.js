const path = require('path');
const nodeExternals = require('webpack-node-externals');

/** @type { import('webpack').Configuration } */
module.exports = {
  entry: './src/index.ts',
  target: 'node',
  stats: 'minimal',
  output: {
    path: path.resolve(__dirname, '..', 'dist'),
    filename: 'index.js',
    library: 'insomniacli',
    libraryTarget: 'commonjs2',
  },
  module: {
    rules: [
      {
        test: /\.tsx?$|\.jsx?$/,
        loader: 'babel-loader',
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: ['.js', '.ts'],
  },
  externals: [
    '@getinsomnia/node-libcurl',
    'mocha',
    '@stoplight/spectral',
    '@hapi/teamwork',
    nodeExternals(),
  ],
};
