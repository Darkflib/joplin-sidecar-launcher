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
          // esbuild only strips types; TypeScript 7 (native) has no JS API for
          // ts-loader to drive.  Run `npm run typecheck` for a proper pass.
          loader: 'esbuild-loader',
          options: {
            loader: 'ts',
            target: 'es2020',
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
  };
};
