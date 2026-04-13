/* ══════════════════════════════════════════════════════════════════════════
   Electron — main process (ESM)
   ══════════════════════════════════════════════════════════════════════════ */
import electron from 'electron';
const { app, BrowserWindow, ipcMain, dialog, shell } = electron;
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      sandbox: false,          // needed so preload can use require
    },
    show: false,               // show after ready-to-show to avoid flash
  });

  // Remove menu bar in production; keep in dev for DevTools
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
    title: 'Select SQLite database',
    properties: ['openFile'],
    filters: [
      { name: 'SQLite Database', extensions: ['sqlite', 'db', 'sqlite3'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return canceled ? null : (filePaths[0] ?? null);
});

/* ── Save file dialog + write ────────────────────────────────────────────── */
ipcMain.handle('save-file', async (_e, { content, filename }) => {
  const { filePath, canceled } = await dialog.showSaveDialog({
    title: 'Save SQL file',
    defaultPath: filename,
    filters: [{ name: 'SQL File', extensions: ['sql'] }],
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, content, 'utf8');
  return { saved: true, filePath };
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

    const sql  = fs.readFileSync(tmpOut, 'utf8');
    const size = Buffer.byteLength(sql, 'utf8');
    fs.unlinkSync(tmpOut);

    return {
      success: true,
      sql,
      lines:   (sql.match(/\n/g) ?? []).length,
      size,
      sizeFmt: fmtBytes(size),
    };
  } catch (err) {
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
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
