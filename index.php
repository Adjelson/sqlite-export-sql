<?php
/* ═══════════════════════════════════════════════════════════════════════════
   sqlite-to-sql — Web Interface
   ══════════════════════════════════════════════════════════════════════════ */

/* ── JSON API endpoint ───────────────────────────────────────────────────── */
if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_POST['action'] ?? '') === 'convert') {
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    echo json_encode(handleConvert());
    exit;
}

/* ═══════════════════════════════════════════════════════════════════════════
   Conversion handler — returns assoc array (success|error)
   ══════════════════════════════════════════════════════════════════════════ */
function handleConvert(): array {
    // ── shell_exec available? ─────────────────────────────────────────────
    if (!function_exists('shell_exec') || isDisabled('shell_exec')) {
        return err('shell_exec está desactivado no php.ini.');
    }

    // ── File upload ───────────────────────────────────────────────────────
    $uploadErr = $_FILES['sqlite_file']['error'] ?? UPLOAD_ERR_NO_FILE;
    if ($uploadErr !== UPLOAD_ERR_OK) {
        $msgs = [
            UPLOAD_ERR_INI_SIZE   => 'Ficheiro excede upload_max_filesize do servidor.',
            UPLOAD_ERR_FORM_SIZE  => 'Ficheiro excede MAX_FILE_SIZE do formulário.',
            UPLOAD_ERR_PARTIAL    => 'Upload interrompido.',
            UPLOAD_ERR_NO_FILE    => 'Nenhum ficheiro enviado.',
            UPLOAD_ERR_NO_TMP_DIR => 'Pasta temporária inexistente.',
            UPLOAD_ERR_CANT_WRITE => 'Falha ao gravar ficheiro temporário.',
        ];
        return err($msgs[$uploadErr] ?? 'Erro de upload desconhecido.');
    }

    $file  = $_FILES['sqlite_file'];
    $orig  = basename($file['name']);
    $ext   = strtolower(pathinfo($orig, PATHINFO_EXTENSION));

    if (!in_array($ext, ['sqlite', 'db', 'sqlite3'], true)) {
        return err('Formato inválido. Aceita: .sqlite, .db, .sqlite3');
    }

    // ── Sanitise options ──────────────────────────────────────────────────
    $dialect    = in_array($_POST['dialect'] ?? 'sqlite', ['sqlite', 'mysql'], true)
                  ? $_POST['dialect'] : 'sqlite';
    $batch      = max(1, min(10000, (int)($_POST['batch'] ?? 500)));
    $noData     = !empty($_POST['no_data']);
    $onlyTables = !empty($_POST['only_tables']);
    $noIndexes  = !empty($_POST['no_indexes']);
    $noViews    = !empty($_POST['no_views']);
    $noTriggers = !empty($_POST['no_triggers']);
    $tablesRaw  = trim($_POST['tables'] ?? '');
    $tables     = $tablesRaw !== ''
                  ? implode(',', array_map('trim', explode(',', $tablesRaw)))
                  : '';

    // ── Temp paths ────────────────────────────────────────────────────────
    $tmpDir = sys_get_temp_dir();
    $tmpIn  = tempnam($tmpDir, 'sq_in_')  . '.' . $ext;
    $tmpOut = tempnam($tmpDir, 'sq_out_') . '.sql';

    if (!move_uploaded_file($file['tmp_name'], $tmpIn)) {
        return err('Não foi possível mover o ficheiro enviado.');
    }

    // ── Build command ─────────────────────────────────────────────────────
    $script = __DIR__ . DIRECTORY_SEPARATOR . 'bin' . DIRECTORY_SEPARATOR . 'sqlite-to-sql.js';
    if (!file_exists($script)) {
        @unlink($tmpIn);
        return err('bin/sqlite-to-sql.js não encontrado. Verifica a instalação.');
    }

    $cmd = 'node ' . escapeshellarg($script)
         . ' -i '          . escapeshellarg($tmpIn)
         . ' -o '          . escapeshellarg($tmpOut)
         . ' --dialect '   . escapeshellarg($dialect)
         . ' --batch '     . escapeshellarg((string)$batch);

    if ($noData)     $cmd .= ' --no-data';
    if ($onlyTables) $cmd .= ' --only-tables';
    if ($noIndexes)  $cmd .= ' --no-indexes';
    if ($noViews)    $cmd .= ' --no-views';
    if ($noTriggers) $cmd .= ' --no-triggers';
    if ($tables)     $cmd .= ' --tables ' . escapeshellarg($tables);

    // ── Execute ───────────────────────────────────────────────────────────
    $cmdOut = shell_exec($cmd . ' 2>&1');

    if (!file_exists($tmpOut) || filesize($tmpOut) === 0) {
        @unlink($tmpIn);
        @unlink($tmpOut);
        return err('Conversão falhou. ' . htmlspecialchars(trim($cmdOut ?: 'Sem detalhes.')));
    }

    $sql  = file_get_contents($tmpOut);
    $size = strlen($sql);

    @unlink($tmpIn);
    @unlink($tmpOut);

    // ── Build response ────────────────────────────────────────────────────
    $filename = pathinfo($orig, PATHINFO_FILENAME) . '.' . $dialect . '.sql';
    $lines    = substr_count($sql, "\n");
    $nodeVer  = trim(shell_exec('node --version 2>&1') ?: '');

    // Preview: first 120 lines (avoids huge DOM for large files)
    $allLines  = explode("\n", $sql);
    $preview   = implode("\n", array_slice($allLines, 0, 120));
    $truncated = count($allLines) > 120;

    return [
        'success'   => true,
        'filename'  => $filename,
        'dialect'   => $dialect,
        'lines'     => $lines,
        'size'      => $size,
        'size_fmt'  => fmtBytes($size),
        'node'      => $nodeVer,
        'preview'   => $preview,
        'truncated' => $truncated,
        'sql_b64'   => base64_encode($sql),
    ];
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */
function err(string $msg): array { return ['success' => false, 'error' => $msg]; }

function fmtBytes(int $b): string {
    if ($b < 1024)    return $b . ' B';
    if ($b < 1048576) return round($b / 1024, 1) . ' KB';
    return round($b / 1048576, 2) . ' MB';
}

function isDisabled(string $fn): bool {
    $disabled = array_map('trim', explode(',', (string)ini_get('disable_functions')));
    return in_array($fn, $disabled, true);
}

/* ═══════════════════════════════════════════════════════════════════════════
   System info (rendered once at page load)
   ══════════════════════════════════════════════════════════════════════════ */
$shellOk  = function_exists('shell_exec') && !isDisabled('shell_exec');
$nodeVer  = $shellOk ? trim(@shell_exec('node --version 2>&1') ?: '') : '';
$nodeOk   = (bool)preg_match('/^v(\d+)/', $nodeVer, $nm) && (int)$nm[1] >= 18;
$phpOk    = version_compare(PHP_VERSION, '7.4', '>=');
$upMax    = ini_get('upload_max_filesize');
$postMax  = ini_get('post_max_size');
$allGood  = $shellOk && $nodeOk && $phpOk;
?>
<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>sqlite-to-sql</title>
  <style>
    /* ── Reset ───────────────────────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg:        #f1f5f9;
      --surface:   #ffffff;
      --border:    #e2e8f0;
      --primary:   #2563eb;
      --primary-h: #1d4ed8;
      --text:      #0f172a;
      --muted:     #64748b;
      --ok:        #16a34a;
      --warn:      #d97706;
      --error:     #dc2626;
      --code-bg:   #0f172a;
      --code-fg:   #e2e8f0;
      --radius:    10px;
      --shadow:    0 1px 3px rgba(0,0,0,.07), 0 4px 14px rgba(0,0,0,.06);
    }

    body {
      font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
      font-size: 15px; line-height: 1.6;
      background: var(--bg); color: var(--text);
      min-height: 100vh;
    }

    /* ── Page wrapper ────────────────────────────────────────────────────── */
    .page { max-width: 1080px; margin: 0 auto; padding: 0 20px 64px; }

    /* ── Header ──────────────────────────────────────────────────────────── */
    header {
      padding: 32px 0 22px;
      display: flex; align-items: center; gap: 14px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .logo {
      width: 40px; height: 40px; border-radius: 9px;
      background: var(--primary);
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .logo svg { color: #fff; }
    .header-text h1 { font-size: 1.3rem; font-weight: 700; letter-spacing: -.3px; }
    .header-text p  { font-size: .82rem; color: var(--muted); margin-top: 1px; }
    .badge {
      margin-left: auto;
      background: #dbeafe; color: #1e40af;
      font-size: .72rem; font-weight: 700;
      padding: 3px 10px; border-radius: 99px; letter-spacing: .04em;
    }

    /* ── System check bar ────────────────────────────────────────────────── */
    .sys-bar {
      display: flex; flex-wrap: wrap; gap: 8px;
      margin-bottom: 24px; align-items: center;
    }
    .sys-chip {
      display: flex; align-items: center; gap: 6px;
      padding: 5px 12px; border-radius: 99px;
      font-size: .78rem; font-weight: 600; border: 1.5px solid;
    }
    .sys-chip.ok    { background:#f0fdf4; border-color:#86efac; color:#15803d; }
    .sys-chip.warn  { background:#fffbeb; border-color:#fde68a; color:#92400e; }
    .sys-chip.bad   { background:#fef2f2; border-color:#fca5a5; color:#b91c1c; }
    .sys-chip svg   { flex-shrink:0; }
    .sys-label      { font-size:.75rem; font-weight:600; color:var(--muted); margin-right:2px; }

    /* ── Grid ────────────────────────────────────────────────────────────── */
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 22px; align-items: start;
    }
    @media (max-width: 740px) { .grid { grid-template-columns: 1fr; } }

    /* ── Card ────────────────────────────────────────────────────────────── */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 26px;
    }
    .card-title {
      font-size: .75rem; font-weight: 800;
      text-transform: uppercase; letter-spacing: .09em;
      color: var(--muted); margin-bottom: 20px;
    }

    /* ── Form fields ─────────────────────────────────────────────────────── */
    .field       { margin-bottom: 16px; }
    .field label {
      display: block; font-size: .875rem; font-weight: 600; margin-bottom: 6px;
    }
    .field small { display: block; color: var(--muted); font-size: .78rem; margin-top: 4px; }

    input[type="number"],
    input[type="text"],
    select {
      width: 100%; padding: 9px 12px;
      border: 1.5px solid var(--border); border-radius: 7px;
      font-size: .875rem; font-family: inherit;
      background: #fff; color: var(--text); outline: none;
      transition: border-color .15s;
    }
    input:focus, select:focus { border-color: var(--primary); }

    /* Drop zone */
    .drop-zone {
      border: 2px dashed var(--border); border-radius: 8px;
      padding: 22px 16px; text-align: center; cursor: pointer;
      transition: border-color .2s, background .2s;
      position: relative;
    }
    .drop-zone:hover, .drop-zone.drag-over {
      border-color: var(--primary); background: #eff6ff;
    }
    .drop-zone input[type="file"] {
      position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; height: 100%;
    }
    .drop-zone-icon { color: var(--muted); margin-bottom: 8px; }
    .drop-zone-text { font-size: .875rem; color: var(--muted); }
    .drop-zone-text strong { color: var(--primary); }
    .drop-zone-file {
      display: none; align-items: center; gap: 8px;
      font-size: .875rem; color: var(--text); font-weight: 600;
    }
    .drop-zone-file svg { color: var(--ok); flex-shrink: 0; }

    /* Dialect tabs */
    .dialect-group { display: flex; }
    .dialect-group input[type="radio"] { display: none; }
    .dialect-group label {
      flex: 1; text-align: center; padding: 9px;
      font-size: .875rem; font-weight: 600;
      border: 1.5px solid var(--border); cursor: pointer;
      color: var(--muted); transition: all .15s; margin: 0;
    }
    .dialect-group label:first-of-type { border-radius: 7px 0 0 7px; }
    .dialect-group label:last-of-type  { border-radius: 0 7px 7px 0; border-left: none; }
    .dialect-group input:checked + label {
      background: var(--primary); border-color: var(--primary); color: #fff;
    }

    /* Checkboxes */
    .checks { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
    .check-item {
      display: flex; align-items: center; gap: 8px; cursor: pointer;
      padding: 7px 10px; border: 1.5px solid var(--border); border-radius: 7px;
      font-size: .82rem; transition: border-color .15s, background .15s;
      user-select: none;
    }
    .check-item input { accent-color: var(--primary); width: 14px; height: 14px; flex-shrink:0; }
    .check-item:has(input:checked) { border-color: #bfdbfe; background: #eff6ff; }

    /* Submit */
    .btn-convert {
      width: 100%; padding: 12px;
      background: var(--primary); color: #fff;
      border: none; border-radius: 8px;
      font-size: .95rem; font-weight: 700; cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      transition: background .15s, transform .1s, opacity .15s;
      margin-top: 6px;
    }
    .btn-convert:hover  { background: var(--primary-h); }
    .btn-convert:active { transform: scale(.98); }
    .btn-convert:disabled { opacity: .6; cursor: not-allowed; transform: none; }

    /* Spinner */
    .spinner {
      display: none; width: 18px; height: 18px;
      border: 2.5px solid rgba(255,255,255,.35);
      border-top-color: #fff; border-radius: 50%;
      animation: spin .7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading .spinner        { display: block; }
    .loading .btn-icon        { display: none; }
    .loading .btn-convert-text { display: none; }

    /* ── Toast ───────────────────────────────────────────────────────────── */
    #toast {
      position: fixed; top: 20px; right: 20px; z-index: 9999;
      padding: 12px 18px; border-radius: 9px;
      font-size: .875rem; font-weight: 600; max-width: 380px;
      box-shadow: 0 4px 20px rgba(0,0,0,.18);
      transform: translateY(-8px); opacity: 0;
      transition: opacity .25s, transform .25s;
      pointer-events: none;
    }
    #toast.show { transform: translateY(0); opacity: 1; }
    #toast.toast-ok    { background: #f0fdf4; border: 1px solid #86efac; color: #14532d; }
    #toast.toast-error { background: #fef2f2; border: 1px solid #fca5a5; color: #7f1d1d; }

    /* ── Result card ─────────────────────────────────────────────────────── */
    #resultCard { display: none; margin-top: 22px; }
    #resultCard.visible { display: block; }

    .result-meta {
      display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px;
    }
    .meta-chip {
      background: #f8fafc; border: 1px solid var(--border);
      border-radius: 99px; padding: 3px 12px;
      font-size: .78rem; font-weight: 600; color: var(--muted);
    }
    .meta-chip span { color: var(--text); }

    .result-actions { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
    .btn {
      padding: 8px 18px; border-radius: 7px; font-size: .875rem;
      font-weight: 600; cursor: pointer; border: none;
      display: flex; align-items: center; gap: 7px;
      transition: opacity .15s, transform .1s;
    }
    .btn:hover  { opacity: .86; }
    .btn:active { transform: scale(.97); }
    .btn-dl      { background: var(--primary); color: #fff; }
    .btn-copy    { background: transparent; border: 1.5px solid var(--border); color: var(--text); }

    .sql-output {
      background: var(--code-bg); color: var(--code-fg);
      border-radius: 8px; padding: 16px 18px;
      font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
      font-size: .79rem; line-height: 1.65; overflow: auto; max-height: 440px;
      white-space: pre; tab-size: 2;
    }
    .preview-note {
      text-align: center; padding: 10px 0 0;
      color: #475569; font-size: .78rem;
      border-top: 1px solid #1e293b; margin-top: 6px;
    }

    /* ── Help ────────────────────────────────────────────────────────────── */
    .steps { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; }
    .step  { display: flex; gap: 12px; align-items: flex-start; }
    .step-num {
      width: 26px; height: 26px; border-radius: 50%;
      background: #dbeafe; color: var(--primary);
      font-size: .78rem; font-weight: 800;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-top: 2px;
    }
    .step strong { display: block; font-size: .875rem; }
    .step small  { color: var(--muted); font-size: .8rem; }

    details { border: 1px solid var(--border); border-radius: 8px; }
    details + details { margin-top: 6px; }
    summary {
      padding: 11px 14px; cursor: pointer; list-style: none;
      font-size: .875rem; font-weight: 600;
      display: flex; justify-content: space-between; align-items: center;
    }
    summary::-webkit-details-marker { display: none; }
    summary::after {
      content: '›'; font-size: 1.1rem; color: var(--muted);
      display: inline-block; transition: transform .2s;
    }
    details[open] summary { border-bottom: 1px solid var(--border); }
    details[open] summary::after { transform: rotate(90deg); }
    .details-body { padding: 14px; font-size: .84rem; color: var(--muted); line-height: 1.7; }

    .type-map { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
    .type-row {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 8px; background: #f8fafc; border-radius: 5px; font-size: .79rem;
    }
    .tf { font-family:monospace; color:#dc2626; font-weight:700; }
    .ta { color: var(--muted); }
    .tt { font-family:monospace; color:#16a34a; font-weight:700; }

    .opts-table { width:100%; border-collapse:collapse; font-size:.82rem; }
    .opts-table th { padding:5px 8px; border-bottom:2px solid var(--border); text-align:left; }
    .opts-table td { padding:6px 8px; border-bottom:1px solid var(--border); vertical-align:top; }
    .opts-table tr:last-child td { border:none; }

    code {
      font-family: 'Cascadia Code','Fira Code',monospace;
      background: #f1f5f9; border: 1px solid var(--border);
      padding: 1px 5px; border-radius: 4px; font-size: .8rem;
    }
    .cli-block {
      background: var(--code-bg); color: var(--code-fg);
      border-radius: 7px; padding: 11px 14px; margin-top: 8px;
      font-family: monospace; font-size: .8rem; white-space: pre; overflow-x: auto;
    }
    .limit-list { list-style:none; display:flex; flex-direction:column; gap:5px; }
    .limit-list li {
      display:flex; gap:8px; font-size:.82rem;
      padding:6px 10px; background:#fffbeb; border-radius:6px;
      border-left:3px solid #f59e0b;
    }
    .limit-list li::before { content:'!'; font-weight:800; color:#d97706; }

    hr.divider { border:none; border-top:1px solid var(--border); margin:18px 0; }

    @media (max-width: 500px) {
      .checks { grid-template-columns: 1fr; }
      .result-actions { flex-direction: column; }
      .type-map { grid-template-columns: 1fr; }
      header { flex-wrap: wrap; }
      .badge { margin-left: 0; }
    }
  </style>
</head>
<body>
<div class="page">

  <!-- ── Header ─────────────────────────────────────────────────────────────── -->
  <header>
    <div class="logo">
      <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
        <path stroke-linecap="round" stroke-linejoin="round"
              d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7C5 4 4 5 4 7z"/>
        <path stroke-linecap="round" stroke-linejoin="round" d="M8 12h8M8 16h5M8 8h8"/>
      </svg>
    </div>
    <div class="header-text">
      <h1>sqlite-to-sql</h1>
      <p>Conversor SQLite → MySQL / MariaDB / SQLite dump</p>
    </div>
    <span class="badge">v1.0</span>
  </header>

  <!-- ── System check bar ───────────────────────────────────────────────────── -->
  <div class="sys-bar">
    <span class="sys-label">Sistema:</span>

    <!-- Node.js -->
    <?php if ($nodeOk): ?>
    <span class="sys-chip ok">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
      </svg>
      Node <?= htmlspecialchars($nodeVer) ?>
    </span>
    <?php elseif ($nodeVer): ?>
    <span class="sys-chip warn">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      </svg>
      Node <?= htmlspecialchars($nodeVer) ?> (requer ≥18)
    </span>
    <?php else: ?>
    <span class="sys-chip bad">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
      </svg>
      Node.js não encontrado
    </span>
    <?php endif; ?>

    <!-- PHP -->
    <span class="sys-chip <?= $phpOk ? 'ok' : 'warn' ?>">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
      </svg>
      PHP <?= PHP_VERSION ?>
    </span>

    <!-- shell_exec -->
    <span class="sys-chip <?= $shellOk ? 'ok' : 'bad' ?>">
      <?php if ($shellOk): ?>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
      </svg>
      shell_exec activo
      <?php else: ?>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
      </svg>
      shell_exec desactivado
      <?php endif; ?>
    </span>

    <!-- Upload limit -->
    <span class="sys-chip ok">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/>
      </svg>
      Upload: <?= htmlspecialchars($upMax) ?>
    </span>
  </div>

  <?php if (!$allGood): ?>
  <div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:12px 16px;font-size:.875rem;color:#713f12;margin-bottom:20px">
    <strong>Aviso:</strong> Uma ou mais dependências do sistema não estão configuradas correctamente.
    A conversão pode não funcionar. Verifica Node.js ≥ 18 no PATH e que <code>shell_exec</code> está activo no php.ini.
  </div>
  <?php endif; ?>

  <!-- ── Main grid ──────────────────────────────────────────────────────────── -->
  <div class="grid">

    <!-- ── Converter ─────────────────────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">Conversor</div>

      <form id="convertForm" novalidate>
        <input type="hidden" name="action" value="convert">

        <!-- Drop zone -->
        <div class="field">
          <label>Ficheiro SQLite <span style="color:var(--error)">*</span></label>
          <div class="drop-zone" id="dropZone">
            <input type="file" name="sqlite_file" id="fileInput" accept=".sqlite,.db,.sqlite3" required>
            <div class="drop-zone-icon">
              <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                <path stroke-linecap="round" stroke-linejoin="round"
                      d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/>
              </svg>
            </div>
            <div class="drop-zone-text">
              <strong>Arrasta aqui</strong> ou clica para seleccionar<br>
              <span style="font-size:.78rem">.sqlite · .db · .sqlite3</span>
            </div>
            <div class="drop-zone-file" id="fileLabel">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
              </svg>
              <span id="fileName"></span>
            </div>
          </div>
        </div>

        <!-- Dialect -->
        <div class="field">
          <label>Dialeto de saída</label>
          <div class="dialect-group">
            <input type="radio" name="dialect" id="d-mysql"  value="mysql"  checked>
            <label for="d-mysql">MySQL / MariaDB</label>
            <input type="radio" name="dialect" id="d-sqlite" value="sqlite">
            <label for="d-sqlite">SQLite (dump)</label>
          </div>
          <small>MySQL converte tipos, remove cláusulas incompatíveis e adiciona ENGINE/charset.</small>
        </div>

        <!-- Batch + Tables (inline) -->
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="field" style="margin-bottom:0">
            <label>Batch (linhas/INSERT)</label>
            <input type="number" name="batch" value="500" min="1" max="10000">
          </div>
          <div class="field" style="margin-bottom:0">
            <label>Tabelas <span style="font-weight:400;color:var(--muted)">(opcional)</span></label>
            <input type="text" name="tables" placeholder="users, orders">
          </div>
        </div>
        <div style="margin-bottom:16px"></div>

        <!-- Flags -->
        <div class="field">
          <label>Opções de exportação</label>
          <div class="checks">
            <label class="check-item"><input type="checkbox" name="no_data">Só schema (sem INSERTs)</label>
            <label class="check-item"><input type="checkbox" name="only_tables">Só tabelas</label>
            <label class="check-item"><input type="checkbox" name="no_indexes">Sem índices</label>
            <label class="check-item"><input type="checkbox" name="no_views">Sem views</label>
            <label class="check-item"><input type="checkbox" name="no_triggers">Sem triggers</label>
          </div>
        </div>

        <button type="submit" class="btn-convert" id="convertBtn">
          <svg class="btn-icon" width="17" height="17" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
          </svg>
          <div class="spinner"></div>
          <span class="btn-convert-text">Converter</span>
        </button>
      </form>
    </div>

    <!-- ── Help ───────────────────────────────────────────────────────────────── -->
    <div class="card">
      <div class="card-title">Ajuda</div>

      <div class="steps">
        <div class="step">
          <div class="step-num">1</div>
          <div>
            <strong>Selecciona o ficheiro</strong>
            <small>Arrasta um <code>.sqlite</code> ou <code>.db</code> para a zona de upload.</small>
          </div>
        </div>
        <div class="step">
          <div class="step-num">2</div>
          <div>
            <strong>Escolhe o dialeto</strong>
            <small><strong>MySQL</strong> — converte tipos e gera DDL compatível.<br>
            <strong>SQLite</strong> — dump fiel, ideal para backup ou migração entre SQLites.</small>
          </div>
        </div>
        <div class="step">
          <div class="step-num">3</div>
          <div>
            <strong>Ajusta as opções</strong>
            <small>Filtra tabelas por nome, exclui índices/views, ou exporta só o schema.</small>
          </div>
        </div>
        <div class="step">
          <div class="step-num">4</div>
          <div>
            <strong>Download e importa</strong>
            <small><code>mysql -u root -p db &lt; file.sql</code></small>
          </div>
        </div>
      </div>

      <hr class="divider">

      <details>
        <summary>Conversões de tipo (SQLite → MySQL)</summary>
        <div class="details-body">
          <div class="type-map">
            <div class="type-row"><span class="tf">TEXT/CLOB</span><span class="ta">→</span><span class="tt">LONGTEXT</span></div>
            <div class="type-row"><span class="tf">REAL</span><span class="ta">→</span><span class="tt">DOUBLE</span></div>
            <div class="type-row"><span class="tf">BLOB</span><span class="ta">→</span><span class="tt">LONGBLOB</span></div>
            <div class="type-row"><span class="tf">BOOLEAN</span><span class="ta">→</span><span class="tt">TINYINT(1)</span></div>
            <div class="type-row"><span class="tf">INTEGER</span><span class="ta">→</span><span class="tt">INT</span></div>
            <div class="type-row"><span class="tf">INT2 / INT8</span><span class="ta">→</span><span class="tt">SMALLINT / BIGINT</span></div>
            <div class="type-row"><span class="tf">NVARCHAR(n)</span><span class="ta">→</span><span class="tt">VARCHAR(n)</span></div>
            <div class="type-row"><span class="tf">NUMERIC</span><span class="ta">→</span><span class="tt">DECIMAL</span></div>
            <div class="type-row"><span class="tf">DOUBLE PRECISION</span><span class="ta">→</span><span class="tt">DOUBLE</span></div>
            <div class="type-row"><span class="tf">AUTOINCREMENT</span><span class="ta">→</span><span class="tt">AUTO_INCREMENT</span></div>
          </div>
          <p style="margin-top:10px">CREATE TABLE recebe <code>ENGINE=InnoDB DEFAULT CHARSET=utf8mb4</code>.</p>
          <p style="margin-top:6px">Removido: <code>ON CONFLICT</code>, <code>COLLATE NOCASE</code>, <code>STRICT</code>, <code>WITHOUT ROWID</code>, cláusula <code>WHERE</code> em índices.</p>
        </div>
      </details>

      <details>
        <summary>Referência de opções CLI</summary>
        <div class="details-body">
          <table class="opts-table">
            <tr><th>Opção</th><th>Descrição</th></tr>
            <tr><td><code>--dialect</code></td><td>sqlite ou mysql</td></tr>
            <tr><td><code>--batch</code></td><td>Linhas por INSERT (padrão: 500)</td></tr>
            <tr><td><code>--no-data</code></td><td>Só schema, sem INSERTs</td></tr>
            <tr><td><code>--only-tables</code></td><td>Ignora índices, views, triggers</td></tr>
            <tr><td><code>--no-indexes</code></td><td>Omite CREATE INDEX</td></tr>
            <tr><td><code>--no-views</code></td><td>Omite CREATE VIEW</td></tr>
            <tr><td><code>--no-triggers</code></td><td>Omite CREATE TRIGGER</td></tr>
            <tr><td><code>--tables</code></td><td>Lista de tabelas (vírgula)</td></tr>
          </table>
        </div>
      </details>

      <details>
        <summary>Importar no MySQL / MariaDB</summary>
        <div class="details-body">
          <div class="cli-block">mysql -u root -p nome_da_base &lt; ficheiro.sql

# MariaDB
mariadb -u root -p nome_da_base &lt; ficheiro.sql</div>
          <p style="margin-top:10px">O ficheiro MySQL já inclui <code>SET FOREIGN_KEY_CHECKS=0/1</code> e <code>SET NAMES utf8mb4</code> automaticamente.</p>
        </div>
      </details>

      <details>
        <summary>Limitações conhecidas</summary>
        <div class="details-body">
          <ul class="limit-list">
            <li>VIEWs e TRIGGERs — sintaxe difere do SQLite, pode precisar revisão manual.</li>
            <li>Funções SQLite em DEFAULT (<code>datetime('now')</code>, <code>strftime</code>) não são convertidas.</li>
            <li>Índices parciais: cláusula WHERE removida; o índice fica sem filtro.</li>
          </ul>
        </div>
      </details>
    </div>
  </div>

  <!-- ── Result card ────────────────────────────────────────────────────────── -->
  <div class="card" id="resultCard">
    <div class="card-title">Resultado</div>

    <div class="result-meta" id="resultMeta"></div>

    <div class="result-actions">
      <button class="btn btn-dl" id="btnDownload">
        <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
          <path stroke-linecap="round" stroke-linejoin="round"
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
        </svg>
        <span id="btnDownloadLabel">Download</span>
      </button>
      <button class="btn btn-copy" id="btnCopy">
        <svg width="15" height="15" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2"/>
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
        </svg>
        Copiar SQL
      </button>
    </div>

    <div class="sql-output" id="sqlPreview"></div>
  </div>

</div><!-- /.page -->

<!-- ── Toast ──────────────────────────────────────────────────────────────── -->
<div id="toast"></div>

<script>
/* ══════════════════════════════════════════════════════════════════════════
   App logic
   ══════════════════════════════════════════════════════════════════════════ */

// ── File drag-and-drop ────────────────────────────────────────────────────
const dropZone  = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const fileLabel = document.getElementById('fileLabel');
const fileName  = document.getElementById('fileName');

function showFile(file) {
  if (!file) return;
  fileName.textContent = file.name;
  fileLabel.style.display = 'flex';
  dropZone.querySelector('.drop-zone-icon').style.display = 'none';
  dropZone.querySelector('.drop-zone-text').style.display = 'none';
}

fileInput.addEventListener('change', () => showFile(fileInput.files[0]));

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault(); dropZone.classList.add('drag-over');
});
['dragleave', 'dragend'].forEach((ev) =>
  dropZone.addEventListener(ev, () => dropZone.classList.remove('drag-over'))
);
dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  const file = e.dataTransfer?.files[0];
  if (file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;
    showFile(file);
  }
});

// ── Toast ─────────────────────────────────────────────────────────────────
const toast = document.getElementById('toast');
let toastTimer;
function showToast(msg, type = 'ok') {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = `show toast-${type}`;
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ── Loading state ─────────────────────────────────────────────────────────
const convertBtn  = document.getElementById('convertBtn');
function setLoading(on) {
  convertBtn.disabled = on;
  convertBtn.classList.toggle('loading', on);
}

// ── Form submit ───────────────────────────────────────────────────────────
document.getElementById('convertForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  if (!fileInput.files.length) {
    showToast('Selecciona um ficheiro .sqlite primeiro.', 'error');
    return;
  }

  setLoading(true);

  let data;
  try {
    const res = await fetch('', {
      method: 'POST',
      body: new FormData(e.target),
    });
    data = await res.json();
  } catch (err) {
    setLoading(false);
    showToast('Erro de rede: ' + err.message, 'error');
    return;
  }

  setLoading(false);

  if (!data.success) {
    showToast(data.error ?? 'Erro desconhecido.', 'error');
    return;
  }

  renderResult(data);
  showToast('Conversão concluída — ' + data.filename, 'ok');
});

// ── Render result ─────────────────────────────────────────────────────────
let _currentB64  = null;
let _currentName = null;

function renderResult(d) {
  _currentB64  = d.sql_b64;
  _currentName = d.filename;

  // Meta chips
  const chips = [
    ['Dialeto', d.dialect.toUpperCase()],
    ['Linhas',  d.lines.toLocaleString('pt')],
    ['Tamanho', d.size_fmt],
    ['Node',    d.node],
  ];
  document.getElementById('resultMeta').innerHTML = chips
    .map(([k, v]) => `<span class="meta-chip">${k}: <span>${v}</span></span>`)
    .join('');

  // Download button label
  document.getElementById('btnDownloadLabel').textContent = 'Download ' + d.filename;

  // Preview
  const pre = document.getElementById('sqlPreview');
  pre.textContent = d.preview;
  if (d.truncated) {
    const note = document.createElement('div');
    note.className = 'preview-note';
    note.textContent = '— pré-visualização: primeiras 120 linhas — ficheiro completo disponível no download —';
    pre.appendChild(note);
  }

  const card = document.getElementById('resultCard');
  card.classList.add('visible');
  setTimeout(() => card.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
}

// ── Download ──────────────────────────────────────────────────────────────
document.getElementById('btnDownload').addEventListener('click', () => {
  if (!_currentB64) return;
  const bin = atob(_currentB64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const blob = new Blob([arr], { type: 'application/sql' });
  const a    = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: _currentName,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ── Copy ──────────────────────────────────────────────────────────────────
document.getElementById('btnCopy').addEventListener('click', async (btn) => {
  if (!_currentB64) return;
  try {
    await navigator.clipboard.writeText(atob(_currentB64));
    const b = document.getElementById('btnCopy');
    const orig = b.innerHTML;
    b.innerHTML = '✓ Copiado!';
    b.style.cssText = 'border-color:var(--ok);color:var(--ok)';
    setTimeout(() => { b.innerHTML = orig; b.style.cssText = ''; }, 2000);
  } catch {
    showToast('Não foi possível copiar para o clipboard.', 'error');
  }
});
</script>
</body>
</html>
