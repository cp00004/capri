const fs = require("fs");
const log = (m) => { try { fs.appendFileSync(process.env.TMP_ERR || "tmp-err.txt", m + "\n"); } catch {} };
process.on("uncaughtException", (e) => { log("UNCAUGHT " + (e && e.stack || e)); process.exit(1); });
process.on("unhandledRejection", (e) => { log("REJECT " + (e && e.stack || e)); });
try { require("./electron/main.cjs"); } catch (e) { log("LOAD " + (e && e.stack || e)); }
