<?php
/**
 * XAMPP htdocs Hub — portable single-file project dashboard.
 *
 * Drop into any XAMPP htdocs root as either index.php or hub.php.
 * No config required. Auto-discovers project folders, reads their
 * descriptions, detects entry points (incl. one level deep), and links them.
 */

// ---- Config (all optional; sensible defaults) -----------------------------
$ROOT = __DIR__;
$SELF = basename(__FILE__);

// Entry files to look for, in priority order.
$ENTRY_CANDIDATES = ['index.php', 'index.html', 'index.htm', 'home.php', 'app.php', 'default.php'];
// Common subfolders that hold the real entry (Laravel/Symfony/build output).
$ENTRY_SUBDIRS = ['public', 'web', 'dist', 'build', 'html'];

// Folders that are almost certainly XAMPP's own or infrastructure — hidden by
// default. Detected by a marker file too (below), so this is a light backstop.
$KNOWN_XAMPP = ['dashboard', 'webalizer', 'xampp', 'img', 'licenses', 'errorpages', 'restart'];

// ---- Helpers --------------------------------------------------------------
function first_existing(string $dir, array $names): ?string {
    foreach ($names as $n) {
        if (is_file($dir . DIRECTORY_SEPARATOR . $n)) return $n;
    }
    return null;
}

/** Detect an entry point at the folder root, then one level deep. Returns a
 *  web-relative path fragment (already segment-encoded) or null. */
function detect_entry(string $projPath, string $projName, array $entryFiles, array $subdirs): ?string {
    $enc = rawurlencode($projName);
    // Root-level entry.
    if ($e = first_existing($projPath, $entryFiles)) {
        return $enc . '/' . rawurlencode($e);
    }
    // One level deep (public/, web/, dist/, ...).
    foreach ($subdirs as $sub) {
        $subPath = $projPath . DIRECTORY_SEPARATOR . $sub;
        if (is_dir($subPath) && ($e = first_existing($subPath, $entryFiles))) {
            return $enc . '/' . rawurlencode($sub) . '/' . rawurlencode($e);
        }
    }
    return null;
}

/** Pull a human description from README / manifest files. First non-empty,
 *  non-heading line of a README, or the "description" field of a manifest. */
function read_description(string $dir): ?string {
    // Manifests with a description field.
    $manifests = [
        'composer.json' => 'description',
        'package.json'  => 'description',
    ];
    foreach ($manifests as $file => $field) {
        $p = $dir . DIRECTORY_SEPARATOR . $file;
        if (is_file($p)) {
            $json = json_decode((string)@file_get_contents($p), true);
            if (isset($json[$field]) && is_string($json[$field]) && trim($json[$field]) !== '') {
                return trim($json[$field]);
            }
        }
    }
    // README variants — first meaningful line.
    foreach (['README.md', 'readme.md', 'README.txt', 'README', '.description'] as $rf) {
        $p = $dir . DIRECTORY_SEPARATOR . $rf;
        if (is_file($p)) {
            $fh = @fopen($p, 'r');
            if ($fh) {
                $lines = 0;
                $heading_fallback = null; // used only if the file is nothing but headings
                while (($line = fgets($fh)) !== false && $lines < 60) {
                    $lines++;
                    $line = trim($line);
                    if ($line === '') continue;
                    // Skip badges, HTML comments, and horizontal rules outright.
                    if (str_starts_with($line, '![') || str_starts_with($line, '[!')) continue;
                    if (str_starts_with($line, '<!--') || str_starts_with($line, '---') || str_starts_with($line, '===')) continue;
                    // Headings are usually the project title, not a description.
                    // Remember the first one as a fallback, but keep looking for prose.
                    if ($line[0] === '#') {
                        $h = trim(ltrim($line, "# "));
                        if ($h !== '' && $heading_fallback === null) $heading_fallback = $h;
                        continue;
                    }
                    // First real prose line wins. Strip markdown emphasis noise.
                    $line = trim($line, "*_`");
                    if ($line !== '') { fclose($fh); return $line; }
                }
                fclose($fh);
                if ($heading_fallback !== null) return $heading_fallback;
            }
        }
    }
    return null;
}

/** Detect a project's own icon/logo, returned as a web path fragment. */
function detect_icon(string $projPath, string $projName): ?string {
    $enc = rawurlencode($projName);
    foreach (['favicon.ico', 'favicon.png', 'logo.png', 'logo.svg', 'icon.png'] as $ic) {
        if (is_file($projPath . DIRECTORY_SEPARATOR . $ic)) return $enc . '/' . rawurlencode($ic);
    }
    foreach (['public', 'assets', 'img', 'images'] as $sub) {
        $subPath = $projPath . DIRECTORY_SEPARATOR . $sub;
        if (is_dir($subPath)) {
            foreach (['favicon.ico', 'favicon.png', 'logo.png', 'logo.svg'] as $ic) {
                if (is_file($subPath . DIRECTORY_SEPARATOR . $ic)) {
                    return $enc . '/' . rawurlencode($sub) . '/' . rawurlencode($ic);
                }
            }
        }
    }
    return null;
}

function human_time(int $ts): string {
    $d = time() - $ts;
    if ($d < 60)     return 'just now';
    if ($d < 3600)   return floor($d / 60) . 'm ago';
    if ($d < 86400)  return floor($d / 3600) . 'h ago';
    if ($d < 604800) return floor($d / 86400) . 'd ago';
    return date('d M Y', $ts);
}

function clip(string $s, int $max = 96): string {
    $s = trim(preg_replace('/\s+/', ' ', $s));
    // Prefer multibyte-safe trimming, but fall back if mbstring isn't loaded.
    if (function_exists('mb_strlen')) {
        return mb_strlen($s) > $max ? mb_substr($s, 0, $max - 1) . '…' : $s;
    }
    return strlen($s) > $max ? substr($s, 0, $max - 1) . '…' : $s;
}

// ---- Discovery ------------------------------------------------------------
$projects = [];
$entries = @scandir($ROOT) ?: [];
foreach ($entries as $name) {
    if ($name === '.' || $name === '..') continue;
    $path = $ROOT . DIRECTORY_SEPARATOR . $name;
    if (!is_dir($path)) continue;
    if ($name[0] === '.') continue; // .git, .idea, etc.

    // Skip known XAMPP folders, plus anything carrying an XAMPP marker file.
    $isXampp = in_array(strtolower($name), array_map('strtolower', $KNOWN_XAMPP), true)
        || is_file($path . DIRECTORY_SEPARATOR . 'xampp.html')
        || is_file($path . DIRECTORY_SEPARATOR . '.xampp');
    if ($isXampp) continue;

    $entry = detect_entry($path, $name, $ENTRY_CANDIDATES, $ENTRY_SUBDIRS);
    $desc  = read_description($path);
    $icon  = detect_icon($path, $name);

    $count = 0;
    foreach ((@scandir($path) ?: []) as $f) {
        if ($f !== '.' && $f !== '..') $count++;
    }

    $projects[] = [
        'name'     => $name,
        'url'      => $entry ?: rawurlencode($name) . '/',
        'entry'    => $entry,
        'desc'     => $desc,
        'icon'     => $icon,
        'items'    => $count,
        'modified' => @filemtime($path) ?: 0,
        'has_git'  => is_dir($path . DIRECTORY_SEPARATOR . '.git'),
    ];
}
usort($projects, fn($a, $b) => $b['modified'] <=> $a['modified']);

// ---- Environment / neighbour tools ----------------------------------------
$php_version = phpversion();
$server_soft = $_SERVER['SERVER_SOFTWARE'] ?? 'Unknown server';
$host        = $_SERVER['HTTP_HOST'] ?? 'localhost';
$now         = date('D, d M Y H:i');
$total       = count($projects);
$linkable    = count(array_filter($projects, fn($p) => $p['entry'] !== null));

// Only surface neighbour tools that actually exist on this install.
$tools = [];
foreach (['phpmyadmin' => 'phpMyAdmin', 'dashboard' => 'XAMPP dashboard', 'adminer' => 'Adminer'] as $slug => $label) {
    if (is_dir($ROOT . DIRECTORY_SEPARATOR . $slug)) {
        $tools[] = ['url' => '/' . $slug . '/', 'label' => $label];
    }
}
?>
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>htdocs · local server</title>
<style>
  :root, [data-theme="dark"] {
    --bg:#0c0e12; --panel:#14171d; --panel-2:#1a1e26; --line:#262b34;
    --ink:#e8ecf1; --ink-dim:#8a93a2; --ink-faint:#565e6b;
    --live:#4ade80; --live-dim:#1c3a28; --amber:#f5a524; --accent:#5b8cff;
    --card-shadow:none;
  }
  [data-theme="light"] {
    --bg:#f4f6f9; --panel:#ffffff; --panel-2:#fbfcfe; --line:#e2e6ec;
    --ink:#1c2430; --ink-dim:#5b6472; --ink-faint:#98a1b0;
    --live:#16a34a; --live-dim:#dcfce7; --amber:#c2760a; --accent:#2f6bff;
    --card-shadow:0 1px 2px rgba(20,30,50,0.06);
  }
  --mono: 'SFMono-Regular','JetBrains Mono','Consolas','Courier New',monospace;

  * { box-sizing:border-box; margin:0; padding:0; }
  :root { --mono:'SFMono-Regular','JetBrains Mono','Consolas','Courier New',monospace;
          --sans:'Segoe UI',system-ui,-apple-system,sans-serif; }

  body {
    background:var(--bg); color:var(--ink); font-family:var(--sans);
    line-height:1.5; min-height:100vh;
    transition:background .2s, color .2s;
    background-image:
      radial-gradient(circle at 15% -10%, rgba(91,140,255,0.06), transparent 40%),
      radial-gradient(circle at 90% 0%, rgba(74,222,128,0.04), transparent 35%);
  }
  [data-theme="light"] body {
    background-image:
      radial-gradient(circle at 12% -10%, rgba(47,107,255,0.06), transparent 42%),
      radial-gradient(circle at 92% -5%, rgba(22,163,74,0.05), transparent 38%);
  }
  .wrap { max-width:1180px; margin:0 auto; padding:0 28px; }

  header { border-bottom:1px solid var(--line); padding:26px 0 22px; margin-bottom:34px; }
  .brand { display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  .brand h1 { font-family:var(--mono); font-size:26px; font-weight:600; letter-spacing:-0.5px; }
  .brand h1 .slash { color:var(--ink-faint); } .brand h1 .dir { color:var(--live); }
  .host-chip {
    font-family:var(--mono); font-size:12px; color:var(--ink-dim);
    background:var(--panel); border:1px solid var(--line); padding:3px 10px; border-radius:5px;
  }
  .theme-btn {
    margin-left:auto; background:var(--panel); border:1px solid var(--line);
    color:var(--ink-dim); font-family:var(--mono); font-size:12px;
    padding:6px 12px; border-radius:7px; cursor:pointer; transition:border-color .15s, color .15s;
  }
  .theme-btn:hover { border-color:var(--accent); color:var(--ink); }

  .statline { margin-top:16px; display:flex; gap:26px; flex-wrap:wrap;
    font-family:var(--mono); font-size:12.5px; color:var(--ink-dim); }
  .statline b { color:var(--ink); font-weight:600; }
  .pulse { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--live);
    animation:pulse 2.2s infinite; margin-right:7px; vertical-align:middle; }
  @keyframes pulse {
    0%{box-shadow:0 0 0 0 rgba(74,222,128,0.45);} 70%{box-shadow:0 0 0 7px rgba(74,222,128,0);}
    100%{box-shadow:0 0 0 0 rgba(74,222,128,0);} }
  @media (prefers-reduced-motion: reduce) { .pulse { animation:none; } }

  .toolbar { display:flex; align-items:center; gap:16px; margin-bottom:22px; flex-wrap:wrap; }
  #search { flex:1; min-width:220px; background:var(--panel); border:1px solid var(--line);
    color:var(--ink); font-family:var(--mono); font-size:14px; padding:11px 15px; border-radius:8px;
    outline:none; transition:border-color .15s, box-shadow .15s; }
  #search::placeholder { color:var(--ink-faint); }
  #search:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(91,140,255,0.15); }
  .count-badge { font-family:var(--mono); font-size:12.5px; color:var(--ink-dim); white-space:nowrap; }
  .count-badge b { color:var(--ink); }

  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(285px, 1fr)); gap:14px; }
  .card { position:relative; display:flex; flex-direction:column; text-decoration:none; color:inherit;
    background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px 18px 16px;
    overflow:hidden; box-shadow:var(--card-shadow);
    transition:transform .14s ease, border-color .14s, background .14s; }
  .card::before { content:""; position:absolute; left:0; top:0; bottom:0; width:3px; background:var(--live); }
  .card.offline::before { background:var(--amber); }
  .card[href]:hover { transform:translateY(-2px); border-color:var(--accent); background:var(--panel-2); }
  .card:not([href]) { cursor:default; }
  .card:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }

  .card-top { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
  .id-left { display:flex; align-items:center; gap:9px; }
  .proj-icon { width:18px; height:18px; border-radius:4px; object-fit:cover; flex:none; }
  .status { font-family:var(--mono); font-size:10.5px; letter-spacing:0.8px; text-transform:uppercase;
    padding:3px 8px; border-radius:4px; background:var(--live-dim); color:var(--live); }
  .card.offline .status { background:#3a2c12; color:var(--amber); }
  [data-theme="light"] .card.offline .status { background:#fdecc8; }
  .git-tag { font-family:var(--mono); font-size:10.5px; color:var(--ink-faint); }

  .card h2 { font-family:var(--mono); font-size:17px; font-weight:600; letter-spacing:-0.3px;
    word-break:break-word; margin-bottom:4px; }
  .card .desc { font-size:13px; color:var(--ink-dim); margin-bottom:10px; line-height:1.45; }
  .card .path { font-family:var(--mono); font-size:11.5px; color:var(--ink-faint);
    margin-bottom:16px; word-break:break-all; margin-top:auto; }
  .card-foot { display:flex; justify-content:space-between; align-items:center; font-family:var(--mono);
    font-size:11.5px; color:var(--ink-faint); border-top:1px solid var(--line); padding-top:11px; }
  .launch { color:var(--accent); font-weight:600; } .card.offline .launch { color:var(--ink-faint); }

  .empty { grid-column:1/-1; text-align:center; padding:60px 20px; color:var(--ink-dim);
    font-family:var(--mono); font-size:14px; border:1px dashed var(--line); border-radius:10px; }

  footer { margin:46px 0 30px; padding-top:20px; border-top:1px solid var(--line);
    font-family:var(--mono); font-size:11.5px; color:var(--ink-faint);
    display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px; }
  footer a { color:var(--ink-dim); text-decoration:none; } footer a:hover { color:var(--accent); }

  @media (max-width:560px){ .wrap{padding:0 16px;} .brand h1{font-size:21px;} }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="brand">
      <h1><span class="slash">/</span><span class="dir">htdocs</span></h1>
      <span class="host-chip"><?= htmlspecialchars($host) ?></span>
      <button class="theme-btn" id="themeBtn" type="button" aria-label="Toggle colour theme">◐ theme</button>
    </div>
    <div class="statline">
      <span><span class="pulse"></span>server online</span>
      <span>php <b><?= htmlspecialchars($php_version) ?></b></span>
      <span><?= htmlspecialchars($server_soft) ?></span>
      <span><?= htmlspecialchars($now) ?></span>
    </div>
  </header>

  <div class="toolbar">
    <input id="search" type="text" placeholder="filter projects…  ( / to focus )" autocomplete="off" spellcheck="false">
    <span class="count-badge"><b><?= $linkable ?></b> launchable · <b><?= $total ?></b> total</span>
  </div>

  <div class="grid" id="grid">
    <?php if ($total === 0): ?>
      <div class="empty">No project folders found in <?= htmlspecialchars($ROOT) ?>.<br>Create a folder here and it'll appear automatically.</div>
    <?php else: foreach ($projects as $p):
      $offline = $p['entry'] === null;
      $hrefAttr = $offline ? '' : ' href="' . htmlspecialchars($p['url']) . '"';
      $search_blob = strtolower($p['name'] . ' ' . ($p['desc'] ?? ''));
    ?>
      <a<?= $hrefAttr ?> class="card<?= $offline ? ' offline' : '' ?>" data-search="<?= htmlspecialchars($search_blob) ?>">
        <div class="card-top">
          <div class="id-left">
            <?php if ($p['icon']): ?><img class="proj-icon" src="<?= htmlspecialchars($p['icon']) ?>" alt="" onerror="this.remove()"><?php endif; ?>
            <span class="status"><?= $offline ? 'no entry' : 'ready' ?></span>
          </div>
          <?php if ($p['has_git']): ?><span class="git-tag">git</span><?php endif; ?>
        </div>
        <h2><?= htmlspecialchars($p['name']) ?></h2>
        <?php if ($p['desc']): ?><div class="desc"><?= htmlspecialchars(clip($p['desc'])) ?></div><?php endif; ?>
        <div class="path">/<?= htmlspecialchars($p['entry'] ? rawurldecode($p['url']) : $p['name'] . '/') ?></div>
        <div class="card-foot">
          <span><?= $p['items'] ?> item<?= $p['items'] === 1 ? '' : 's' ?> · <?= human_time($p['modified']) ?></span>
          <span class="launch"><?= $offline ? 'browse →' : 'launch →' ?></span>
        </div>
      </a>
    <?php endforeach; endif; ?>
  </div>

  <footer>
    <span>document root: <?= htmlspecialchars($ROOT) ?></span>
    <?php if ($tools): ?>
    <span><?php foreach ($tools as $i => $t): ?><?= $i ? ' · ' : '' ?><a href="<?= htmlspecialchars($t['url']) ?>" target="_blank" rel="noopener"><?= htmlspecialchars($t['label']) ?></a><?php endforeach; ?></span>
    <?php endif; ?>
  </footer>

</div>

<script>
  // ---- Theme (OS default + persisted preference) ----
  const KEY = 'htdocs-hub-theme';
  const root = document.documentElement;
  const saved = localStorage.getItem(KEY);
  const initial = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  root.setAttribute('data-theme', initial);
  document.getElementById('themeBtn').addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    localStorage.setItem(KEY, next);
  });

  // ---- Filter (name + description) ----
  const search = document.getElementById('search');
  const cards = Array.from(document.querySelectorAll('.card'));
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    cards.forEach(c => { c.style.display = c.dataset.search.includes(q) ? '' : 'none'; });
  });
  document.addEventListener('keydown', e => {
    if (e.key === '/' && document.activeElement !== search) { e.preventDefault(); search.focus(); }
    if (e.key === 'Escape' && document.activeElement === search) {
      search.value = ''; search.dispatchEvent(new Event('input')); search.blur();
    }
  });
</script>
</body>
</html>
