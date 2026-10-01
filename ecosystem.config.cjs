module.exports = {
  apps: [
    {
      name: "tally-backend",
      cwd: __dirname,
      script: "src/server.js",
      exec_mode: "fork",      // keep 1 instance: crons + BullMQ workers live in this process
      instances: 1,
      env: { NODE_ENV: "production" },
      max_memory_restart: "1500M",
      kill_timeout: 15000,
      time: true,
    },
  ],
};