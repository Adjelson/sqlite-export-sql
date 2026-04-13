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

  /** Saves content to disk via save dialog — returns { saved, filePath } */
  saveFile:     (opts)   => ipcRenderer.invoke('save-file', opts),

  /** Converts a SQLite file — returns { success, sql, lines, size, sizeFmt } | { success:false, error } */
  convert:      (opts)   => ipcRenderer.invoke('convert', opts),

  /** Reveals a file in the OS file explorer */
  showInFolder: (p)      => ipcRenderer.invoke('show-in-folder', p),
});
