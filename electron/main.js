/* ══════════════════════════════════════════════════════════════════════════
   Electron — main process (ESM)
   ══════════════════════════════════════════════════════════════════════════ */
import * as electron from 'electron/main';
const { app, BrowserWindow, ipcMain, dialog, shell } = electron;
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Track active temp files so we can clean them up on quit
const activeTmpFiles = new Set();

// ── Window ────────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width:    1120,
    height:   760,
    minWidth: 640,
    minHeight: 500,
    icon: path.join(__dirname, '..', 'icone.ico'),
    title: 'sqlite-to-sql',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  });

  if (app.isPackaged) win.setMenu(null);

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean up any leftover temp files when the app exits
app.on('before-quit', () => {
  for (const f of activeTmpFiles) {
    try { fs.unlinkSync(f); } catch {}
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// IPC handlers
// ═══════════════════════════════════════════════════════════════════════════

/* ── App / system info ───────────────────────────────────────────────────── */
ipcMain.handle('get-info', () => ({
  node:     process.versions.node,
  electron: process.versions.electron,
  version:  app.getVersion(),
  platform: process.platform,
}));

/* ── Open file dialog ────────────────────────────────────────────────────── */
ipcMain.handle('open-file', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog({
    title: 'Selecionar base de dados SQLite',
    properties: ['openFile'],
    filters: [
      { name: 'SQLite Database', extensions: ['sqlite', 'db', 'sqlite3'] },
      { name: 'Todos os ficheiros', extensions: ['*'] },
    ],
  });
  return canceled ? null : (filePaths[0] ?? null);
});

/* ── Save file (move temp file to user-chosen path) ──────────────────────── */
ipcMain.handle('save-file', async (_e, { tmpPath, filename }) => {
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: 'Guardar ficheiro SQL',
    defaultPath: filename,
    filters: [{ name: 'SQL File', extensions: ['sql'] }],
  });
  if (canceled || !filePath) return { saved: false };

  // Prefer atomic rename; fall back to copy+delete (cross-drive)
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.copyFileSync(tmpPath, filePath);
    try { fs.unlinkSync(tmpPath); } catch {}
  }
  activeTmpFiles.delete(tmpPath);
  return { saved: true, filePath };
});

/* ── Delete a temp file the renderer no longer needs ─────────────────────── */
ipcMain.handle('cleanup-tmp', (_e, tmpPath) => {
  try { fs.unlinkSync(tmpPath); } catch {}
  activeTmpFiles.delete(tmpPath);
});

/* ── Conversion ──────────────────────────────────────────────────────────── */
ipcMain.handle('convert', async (_e, opts) => {
  const tmpOut = path.join(os.tmpdir(), `sq_out_${Date.now()}.sql`);

  try {
    const { exportSqliteToSql } = await import('../src/exporter.js');

    exportSqliteToSql({
      inputPath:      opts.inputPath,
      outputPath:     tmpOut,
      dialect:        opts.dialect        ?? 'sqlite',
      batchSize:      opts.batchSize      ?? 500,
      exportData:     opts.exportData     ?? true,
      exportIndexes:  opts.exportIndexes  ?? true,
      exportViews:    opts.exportViews    ?? true,
      exportTriggers: opts.exportTriggers ?? true,
      onlyTables:     opts.onlyTables     ?? false,
      onlyTableNames: opts.onlyTableNames ?? null,
    });

    const size    = fs.statSync(tmpOut).size;
    const lines   = countLinesInFile(tmpOut);
    const preview = readFirstLines(tmpOut, 200);

    activeTmpFiles.add(tmpOut);

    return { success: true, tmpPath: tmpOut, lines, size, sizeFmt: fmtBytes(size), preview };
  } catch (err) {
    try { fs.unlinkSync(tmpOut); } catch {}
    return { success: false, error: err.message };
  }
});

/* ── Open path in file explorer ──────────────────────────────────────────── */
ipcMain.handle('show-in-folder', (_e, filePath) => {
  shell.showItemInFolder(filePath);
});

// ── Helpers ───────────────────────────────────────────────────────────────

function fmtBytes(b) {
  if (b < 1024)      return b + ' B';
  if (b < 1_048_576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1_048_576).toFixed(2) + ' MB';
}

/** Count newlines in a file without loading it all into memory. */
function countLinesInFile(filePath) {
  const fd  = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(65536);
  let count = 0, n;
  while ((n = fs.readSync(fd, buf, 0, buf.length)) > 0) {
    for (let i = 0; i < n; i++) if (buf[i] === 10) count++;
  }
  fs.closeSync(fd);
  return count;
}

/** Read the first `maxLines` lines of a file without loading all of it. */
function readFirstLines(filePath, maxLines) {
  const fd  = fs.openSync(filePath, 'r');
  const buf = Buffer.allocUnsafe(65536);
  let out = '', lines = 0, partial = '', done = false;
  while (!done) {
    const n = fs.readSync(fd, buf, 0, buf.length);
    if (n === 0) { out += partial; break; }
    const chunk  = partial + buf.subarray(0, n).toString('utf8');
    const parts  = chunk.split('\n');
    partial = parts.pop();
    for (const line of parts) {
      out += line + '\n';
      if (++lines >= maxLines) { done = true; break; }
    }
  }
  fs.closeSync(fd);
  return out;
}
