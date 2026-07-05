module.exports = {
  apps: [{
    name: "ms-core-one",
    script: "./dist/main.js",

    // 🔧 Escala fija pero con múltiples workers
    instances: 1,  // ← max para una instancia por cpu
    exec_mode: "cluster",  // ← Cambia a cluster para múltiples instancias
    watch: false,
    max_memory_restart: "500M", //Reinicia al llegar a los 500Mb
    // Logs
    // error_file: "./logs/err.log",
    // out_file: "./logs/out.log",
    log_date_format: "",
    merge_logs: true,

    //Reintentos y estabilidad
    autorestart: true,
    max_restarts: 10,
    min_uptime: "10s",
    restart_delay: 4000,

    // Graceful shutdown
    kill_timeout: 10000,
    wait_ready: true,
    listen_timeout: 10000,

    // Monitoreo
    pmx: true
  }]
}