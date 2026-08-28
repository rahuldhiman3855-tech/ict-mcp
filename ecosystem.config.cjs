// PM2 process definition. Named .cjs (not .js) because package.json has
// "type": "module" — pm2's own config loader expects CommonJS, and a plain
// .js here would be parsed as ESM and fail on `module.exports`.
const path = require("path");

module.exports = {
  apps: [
    {
      name: "ict-mcp-charts",
      script: "charts.js",
      cwd: __dirname,
      interpreter: "node",
      env: {
        MCP_TRANSPORT: "http",
        PORT: "3000",
      },
      autorestart: true,
      restart_delay: 5000,
      max_restarts: 20,
      out_file: path.join(__dirname, "logs", "pm2-ict-mcp-charts.out.log"),
      error_file: path.join(__dirname, "logs", "pm2-ict-mcp-charts.err.log"),
      time: true,
    },
  ],
};
