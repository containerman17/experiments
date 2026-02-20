module.exports = {
  apps: [{
    name: "teleclaude",
    script: "index.ts",
    interpreter: "bun",
    cwd: __dirname,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
  }],
};
