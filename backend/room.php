<?php
// ==============================================================
// 火箭发射 · 联机信令服务器
// 只负责把两个玩家"接上头"（交换 WebRTC 的 SDP / ICE），
// 接通后游戏数据和语音全部走 P2P，不再经过服务器。
//   POST ?action=create            -> {code}          建房
//   POST ?action=join&code=XXXXXX  -> {ok, host}      加入
//   GET  ?action=status&code=XXX   -> 房间状态（主机轮询等人）
//   POST ?action=signal&code=&to=  -> 投递一条信令
//   GET  ?action=poll&code=&me=&since= -> 取信令
//   GET  ?action=selftest          -> 自检：连库与建表情况
//
// 【数据库配置】不需要在这里填。同目录如果有 db.php（Mini Metro 后端），
// 本文件会直接复用它已经配好的账号密码和 CORS —— 避免两处配置不一致。
// 只有在单独部署、同目录没有 db.php 时，才会用下面的兜底配置。
// ==============================================================
const ROOM_TTL_MIN = 120;   // 房间与信令保留时长（分钟）

$__dbphp = __DIR__ . '/db.php';
if (is_file($__dbphp)) {
    // db.php 会：定义 DB_* 常量、发 CORS 头、处理 OPTIONS 预检、建好 $db
    require_once $__dbphp;
} else {
    define('DB_HOST', '127.0.0.1');
    define('DB_NAME', 'metro_game');
    define('DB_USER', 'metro_user');
    define('DB_PASS', 'CHANGE_ME');
    define('RK_CORS', ['https://vibetool.github.io', 'http://localhost:8790', 'http://127.0.0.1:8790']);
    $o = $_SERVER['HTTP_ORIGIN'] ?? '';
    header('Vary: Origin');
    if ($o !== '' && in_array($o, RK_CORS, true)) header("Access-Control-Allow-Origin: $o");
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
}
header('Content-Type: application/json; charset=utf-8');

// 用 rk_ 前缀避免和 db.php 里的 fail()/json_out() 撞名（它们签名不同）
function rk_out(array $a): void { echo json_encode($a, JSON_UNESCAPED_UNICODE); exit; }
function rk_fail(int $code, string $msg, array $extra = []): void {
    http_response_code($code);
    rk_out(['ok' => false, 'error' => $msg] + $extra);
}

// db.php 已经建好 $db 就直接用；否则自己建
if (!isset($db) || !($db instanceof PDO)) {
    try {
        $db = new PDO('mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
            DB_USER, DB_PASS, [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES => false,
            ]);
    } catch (Throwable $e) {
        // 只回 SQLSTATE 码，不回明文信息：1049=库不存在 1045=账号密码错 2002=连不上
        rk_fail(500, 'db_unavailable', ['sqlstate' => $e->getCode()]);
    }
}

// ---- 自检：不泄露账号密码，只说连的哪个库、表建了没 ----
if (($_GET['action'] ?? '') === 'selftest') {
    $info = ['ok' => true, 'db_connected' => true];
    try { $info['database'] = $db->query('SELECT DATABASE()')->fetchColumn(); } catch (Throwable $e) {}
    foreach (['rocket_rooms', 'rocket_signals', 'rocket_ships'] as $t) {
        try { $db->query("SELECT 1 FROM `$t` LIMIT 1"); $info['tables'][$t] = true; }
        catch (Throwable $e) { $info['tables'][$t] = false; }
    }
    $info['config_source'] = is_file(__DIR__ . '/db.php') ? 'db.php（复用）' : '本文件内置';
    rk_out($info);
}

// 顺手清理过期房间，避免表无限增长
$db->exec('DELETE FROM rocket_signals WHERE created_at < (NOW() - INTERVAL ' . ROOM_TTL_MIN . ' MINUTE)');
$db->exec('DELETE FROM rocket_rooms   WHERE created_at < (NOW() - INTERVAL ' . ROOM_TTL_MIN . ' MINUTE)');

$action = $_GET['action'] ?? '';
$code   = strtoupper(preg_replace('/[^A-Z0-9]/i', '', $_GET['code'] ?? ''));
$body   = json_decode(file_get_contents('php://input') ?: '{}', true) ?: [];
$nameOf = function ($k) use ($body) {
    $n = trim((string)($body[$k] ?? ''));
    if ($n === '') $n = '匿名工程师';
    return mb_substr($n, 0, 16);
};

if ($action === 'create') {
    // 避开易混淆字符（0/O、1/I），房号口头念得清
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for ($try = 0; $try < 12; $try++) {
        $c = '';
        for ($i = 0; $i < 6; $i++) $c .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        $st = $db->prepare('INSERT IGNORE INTO rocket_rooms (code, host_name) VALUES (?, ?)');
        $st->execute([$c, $nameOf('name')]);
        if ($st->rowCount() > 0) rk_out(['ok' => true, 'code' => $c]);
    }
    rk_fail(500, 'code_exhausted');
}

if ($code === '' || strlen($code) !== 6) rk_fail(400, 'bad_code');

if ($action === 'join') {
    $st = $db->prepare('SELECT * FROM rocket_rooms WHERE code = ?');
    $st->execute([$code]);
    $room = $st->fetch();
    if (!$room) rk_fail(404, 'room_not_found');
    if ($room['state'] === 'joined') rk_fail(409, 'room_full');
    $db->prepare('UPDATE rocket_rooms SET guest_name = ?, state = "joined" WHERE code = ?')
       ->execute([$nameOf('name'), $code]);
    rk_out(['ok' => true, 'host' => $room['host_name']]);
}

if ($action === 'status') {
    $st = $db->prepare('SELECT state, host_name, guest_name FROM rocket_rooms WHERE code = ?');
    $st->execute([$code]);
    $room = $st->fetch();
    if (!$room) rk_fail(404, 'room_not_found');
    rk_out(['ok' => true] + $room);
}

if ($action === 'signal') {
    $to = ($_GET['to'] ?? '') === 'host' ? 'host' : 'guest';
    $payload = $body['payload'] ?? null;
    if ($payload === null) rk_fail(400, 'no_payload');
    $json = json_encode($payload, JSON_UNESCAPED_UNICODE);
    if (strlen($json) > 60000) rk_fail(413, 'too_large');
    $db->prepare('INSERT INTO rocket_signals (room, to_peer, payload) VALUES (?,?,?)')
       ->execute([$code, $to, $json]);
    rk_out(['ok' => true]);
}

if ($action === 'poll') {
    $me = ($_GET['me'] ?? '') === 'host' ? 'host' : 'guest';
    $since = (int)($_GET['since'] ?? 0);
    $st = $db->prepare('SELECT id, payload FROM rocket_signals
                        WHERE room = ? AND to_peer = ? AND id > ? ORDER BY id ASC LIMIT 40');
    $st->execute([$code, $me, $since]);
    $msgs = []; $last = $since;
    foreach ($st->fetchAll() as $r) { $msgs[] = json_decode($r['payload'], true); $last = (int)$r['id']; }
    rk_out(['ok' => true, 'msgs' => $msgs, 'last' => $last]);
}

if ($action === 'close') {
    $db->prepare('UPDATE rocket_rooms SET state = "closed" WHERE code = ?')->execute([$code]);
    rk_out(['ok' => true]);
}

rk_fail(400, 'unknown_action');
