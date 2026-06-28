import path from "node:path";
import { fileURLToPath } from "node:url";
import HtmlWebpackPlugin from "html-webpack-plugin";
import CopyWebpackPlugin from "copy-webpack-plugin";
import devCerts from "office-addin-dev-certs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async (env, argv) => {
  const dev = argv.mode !== "production";

  // Office requires the add-in to be served over HTTPS, even in development.
  let https;
  try {
    https = await devCerts.getHttpsServerOptions();
  } catch {
    https = undefined; // certs not installed yet — run `npm run dev-certs`
  }

  return {
    mode: dev ? "development" : "production",
    devtool: dev ? "source-map" : false,
    entry: {
      taskpane: "./src/taskpane/taskpane.js",
      commands: "./src/commands/commands.js",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      filename: "[name].js",
      clean: true,
    },
    resolve: { extensions: [".js"] },
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: {
            loader: "babel-loader",
            options: { presets: ["@babel/preset-env"] },
          },
        },
        { test: /\.css$/, use: ["style-loader", "css-loader"] },
      ],
    },
    plugins: [
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        template: "./src/taskpane/taskpane.html",
        chunks: ["taskpane"],
      }),
      new HtmlWebpackPlugin({
        filename: "commands.html",
        template: "./src/commands/commands.html",
        chunks: ["commands"],
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: "assets", to: "assets" },
          { from: "manifest.xml", to: "manifest.xml" },
        ],
      }),
    ],
    devServer: {
      static: { directory: path.resolve(__dirname, "dist") },
      server: https ? { type: "https", options: https } : "http",
      port: 3000,
      hot: true,
      headers: { "Access-Control-Allow-Origin": "*" },
      // Proxy API calls to the Simba backend so the task pane can use a
      // same-origin "/api/..." URL.
      proxy: [
        {
          context: ["/api"],
          target: "http://localhost:3001",
          secure: false,
          changeOrigin: true,
        },
      ],
    },
  };
};
