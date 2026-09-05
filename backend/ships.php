<?php
// ==============================================================
// 火箭发射 · 联机机库 API（自包含，匿名读写，无需注册）
//   GET  ships.php?limit=60      -> 公开机库列表（按高度降序）
//   POST ships.php               -> 登记一艘入轨飞船
//        body: {player, name, stack:[{partId,fuel}], apogee, time}
// 把下面 4 行改成你宝塔创建的库 / 用户名 / 密码
// ==============================================================
const DB_HOST = '127.0.0.1';
const DB_NAME = 'metro_game';
const DB_USER = 'metro_user';
const DB_PASS = 'CHANGE_ME';

const CORS_ALLOWED_ORIGINS = [
    'https://vibetool.github.io',
    'http://localhost:8790',
    'http://127.0.0.1:8790',
];

const MAX_ROWS        = 200;   // 列表最多返回
const MAX_PARTS       = 40;    // 单艘飞船零件上限
const MIN_APOGEE      = 100000; // 低于卡门线不予登记
const RATE_LIMIT_N    = 20;    // 同一 IP 每小时最多提交
// ==============================================================

function emit_cors(): void {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    header('Vary: Origin');
    if ($origin !== '' && in_array($origin, CORS_ALLOWED_ORIGINS, true)) {
        header("Access-Control-Allow-Origin: $origin");
    }
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
    header('Access-Control-Max-Age: 86400');
}
// CORS 必须先于任何可能 exit 的逻辑，否则 DB 挂掉时前端只看到 CORS 错误
emit_cors();
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') { http_response_code(204); exit; }
header('Content-Type: application/json; charset=utf-8');

function fail(int $code, string $msg): void {
    http_response_code($code);
    echo json_encode(['ok' => false, 'error' => $msg], JSON_UNESCAPED_UNICODE);
    exit;
}

try {
    $db = new PDO('mysql:host=' . DB_HOST . ';dbname=' . DB_NAME . ';charset=utf8mb4',
        DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
} catch (Throwable $e) {
    fail(500, 'db_unavailable');
}

// 合法零件白名单 —— 必须与前端 parts.js 一致，防止伪造设计
const VALID_PARTS = [
    'engine_large', 'engine_medium', 'engine_small',
    'fuel_large', 'fuel_medium', 'fuel_small', 'decoupler', 'capsule',
];

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// ---------------- 读取列表 ----------------
if ($method === 'GET') {
    $limit = (int)($_GET['limit'] ?? 60);
    if ($limit < 1) $limit = 60;
    if ($limit > MAX_ROWS) $limit = MAX_ROWS;
    $st = $db->prepare(
        'SELECT id, player, ship_name, stack_json, parts, stages, apogee, flight_time,
                UNIX_TIMESTAMP(updated_at) AS ts
         FROM rocket_ships ORDER BY apogee DESC, updated_at ASC LIMIT :n');
    $st->bindValue(':n', $limit, PDO::PARAM_INT);
    $st->execute();
    $rows = [];
    foreach ($st->fetchAll() as $r) {
        $rows[] = [
            'id'     => 'srv_' . $r['id'],
            'player' => $r['player'],
            'name'   => $r['ship_name'],
            'stack'  => json_decode($r['stack_json'], true),
            'parts'  => (int)$r['parts'],
            'stages' => (int)$r['stages'],
            'apogee' => (int)$r['apogee'],
            'time'   => (float)$r['flight_time'],
            'ts'     => ((int)$r['ts']) * 1000,
        ];
    }
    echo json_encode(['ok' => true, 'ships' => $rows], JSON_UNESCAPED_UNICODE);
    exit;
}

// ---------------- 登记飞船 ----------------
if ($method !== 'POST') fail(405, 'method_not_allowed');

$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > 20000) fail(413, 'payload_too_large');
$in = json_decode($raw, true);
if (!is_array($in)) fail(400, 'bad_json');

$player = trim((string)($in['player'] ?? ''));
if ($player === '') $player = '匿名工程师';
if (mb_strlen($player) > 16) $player = mb_substr($player, 0, 16);

$shipName = trim((string)($in['name'] ?? '未命名'));
if ($shipName === '') $shipName = '未命名';
if (mb_strlen($shipName) > 24) $shipName = mb_substr($shipName, 0, 24);

$apogee = (int)($in['apogee'] ?? 0);
$time   = (float)($in['time'] ?? 0);
if ($apogee < MIN_APOGEE) fail(422, 'not_orbital');   // 没过卡门线不收
if ($apogee > 100000000) fail(422, 'implausible');
if ($time < 0 || $time > 100000) $time = 0;

$stack = $in['stack'] ?? null;
if (!is_array($stack) || count($stack) === 0 || count($stack) > MAX_PARTS) fail(422, 'bad_stack');

$clean = [];
$stages = 1;
foreach ($stack as $p) {
    $pid = is_array($p) ? (string)($p['partId'] ?? '') : '';
    if (!in_array($pid, VALID_PARTS, true)) fail(422, 'bad_part');
    $fuel = is_array($p) ? (float)($p['fuel'] ?? 0) : 0;
    if ($fuel < 0 || $fuel > 1000) $fuel = 0;
    $clean[] = ['partId' => $pid, 'fuel' => $fuel];
    if ($pid === 'decoupler') $stages++;
}
// 至少要有一个引擎，否则不是能飞的设计
$hasEngine = false;
foreach ($clean as $p) { if (str_starts_with($p['partId'], 'engine_')) { $hasEngine = true; break; } }
if (!$hasEngine) fail(422, 'no_engine');

$sig = hash('sha256', implode('|', array_column($clean, 'partId')));
$ipHash = hash('sha256', ($_SERVER['REMOTE_ADDR'] ?? '') . '|rocket');

// 限流：同 IP 每小时提交上限
$rl = $db->prepare('SELECT COUNT(*) c FROM rocket_ships
                    WHERE ip_hash = ? AND updated_at > (NOW() - INTERVAL 1 HOUR)');
$rl->execute([$ipHash]);
if ((int)$rl->fetch()['c'] >= RATE_LIMIT_N) fail(429, 'rate_limited');

// 同一玩家的同款设计只保留最好成绩
$up = $db->prepare(
    'INSERT INTO rocket_ships
       (design_sig, player, ship_name, stack_json, parts, stages, apogee, flight_time, ip_hash)
     VALUES (:sig, :player, :name, :stack, :parts, :stages, :apo, :t, :ip)
     ON DUPLICATE KEY UPDATE
       ship_name   = IF(VALUES(apogee) > apogee, VALUES(ship_name), ship_name),
       stack_json  = IF(VALUES(apogee) > apogee, VALUES(stack_json), stack_json),
       flight_time = IF(VALUES(apogee) > apogee, VALUES(flight_time), flight_time),
       apogee      = GREATEST(apogee, VALUES(apogee))');
$up->execute([
    ':sig' => $sig, ':player' => $player, ':name' => $shipName,
    ':stack' => json_encode($clean, JSON_UNESCAPED_UNICODE),
    ':parts' => count($clean), ':stages' => $stages,
    ':apo' => $apogee, ':t' => $time, ':ip' => $ipHash,
]);

echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
