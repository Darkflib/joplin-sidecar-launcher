const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = (env) => {
  return {
    mode: env && env.production ? 'production' : 'development',
    entry: './src/index.ts',
    target: 'node',
    devtool: env && env.production ? false : 'cheap-module-source-map',
    output: {
      filename: 'index.js',
      path: path.resolve(__dirname, 'publish'),
    },
    resolve: {
      extensions: ['.ts', '.js'],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: 'ts-loader',
            options: {
              // transpileOnly skips full type-checking during webpack build.
              // Run `tsc --noEmit` separately for a proper type-check pass.
              // This avoids cascading errors from @joplin/lib internal .ts files
              // being transitively resolved by the type checker.
              transpileOnly: true,
            },
          },
          exclude: /node_modules/,
        },
      ],
    },
    plugins: [
      new CopyPlugin({
        patterns: [
          {
            from: 'src/manifest.json',
            to: 'manifest.json',
          },
        ],
      }),
    ],
    // 'api' and 'api/*' are virtual modules injected by the Joplin plugin runtime.
    // @joplin/lib is the Joplin internal library — not bundled.
    // Using a function to catch 'api', 'api/types', and any other api/* sub-paths.
    externals: [
      ({ request }, callback) => {
        if (request === 'api' || (request && request.startsWith('api/'))) {
          return callback(null, `commonjs ${request}`);
        }
        if (request && request.startsWith('@joplin/lib')) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      },
    ],
  };
};
