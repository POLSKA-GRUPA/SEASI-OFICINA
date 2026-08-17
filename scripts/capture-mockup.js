// Captura del mockup con Electron (misma técnica que la app real)
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1680,
    height: 1020,
    show: false,
    webPreferences: { offscreen: true },
  });
  win.loadFile(path.join(__dirname, "mockup.html")).then(() => {
    setTimeout(() => {
      win.webContents.capturePage().then((img) => {
        writeFileSync(process.argv[2] ?? "/tmp/seasi-mockup/mockup.png", img.toPNG());
        console.log("saved");
        app.quit();
      });
    }, 600);
  });
});
