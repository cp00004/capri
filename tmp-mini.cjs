const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => { const w = new BrowserWindow({ width: 400, height: 300 }); w.loadURL("data:text/html,<h1>hello</h1>"); });
