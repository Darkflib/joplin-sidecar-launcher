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
      alias: {
        // 'api' is not an npm package — it is a thin type shim bundled with
        // every Joplin plugin.  At runtime, 'joplin' is injected into the
        // plugin sandbox as a context global; api/index.ts declares it ambient
        // so webpack can bundle the reference without needing a require().
        // This is exactly what the official generator-joplin template does.
        'api': path.resolve(__dirname, 'api'),

        // Bundle the enum values locally; api/types.ts provides the real
        // declarations from the generator template.
        'api/types': path.resolve(__dirname, 'api', 'types.ts'),
      },
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: 'ts-loader',
            options: {
              // transpileOnly avoids type-checking @joplin/lib's own .ts files
              // transitively.  Run `tsc --noEmit` separately for a proper pass.
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
    // No 'api' external — it is aliased to a local directory above.
    // @joplin/lib is only a dev-time type source; nothing from it is used
    // at runtime, so marking it external is safe (it will never be required).
    externals: [
      ({ request }, callback) => {
        if (request && request.startsWith('@joplin/lib')) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      },
    ],
  };
};
