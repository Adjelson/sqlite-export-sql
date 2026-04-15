'use strict';
/* ══════════════════════════════════════════════════════════════════════════
   Electron — preload (context bridge)
   Exposes a minimal, safe API to the renderer via window.api
   ══════════════════════════════════════════════════════════════════════════ */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  /** Returns { node, electron, version, platform } */
  getInfo:      ()       => ipcRenderer.invoke('get-info'),

  /** Opens native file picker — returns OS path or null */
  openFile:     ()       => ipcRenderer.invoke('open-file'),

  /** Moves temp file to user-chosen path — returns { saved, filePath } */
  saveFile:     (opts)   => ipcRenderer.invoke('save-file', opts),

  /** Converts a SQLite file — returns { success, tmpPath, lines, size, sizeFmt, preview } | { success:false, error } */
  convert:      (opts)   => ipcRenderer.invoke('convert', opts),

  /** Deletes a temp file that is no longer needed */
  cleanupTmp:   (p)      => ipcRenderer.invoke('cleanup-tmp', p),

  /** Reveals a file in the OS file explorer */
  showInFolder: (p)      => ipcRenderer.invoke('show-in-folder', p),
});
