-- ==============================================================
-- 火箭发射 · 联机机库 — MySQL / MariaDB 表结构
-- 宝塔 -> 数据库 -> 你的库 -> 导入 -> 选这个文件
-- 可以和 Mini Metro 的表共用同一个库，互不影响
-- ==============================================================

CREATE TABLE IF NOT EXISTS rocket_ships (
  id           INT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  design_sig   CHAR(64)      NOT NULL,          -- 设计指纹(零件序列的 hash)，同款只留最好成绩
  player       VARCHAR(32)   NOT NULL,          -- 玩家昵称(匿名，无需注册)
  ship_name    VARCHAR(48)   NOT NULL,
  stack_json   JSON          NOT NULL,          -- 零件序列
  parts        SMALLINT      NOT NULL DEFAULT 0,
  stages       TINYINT       NOT NULL DEFAULT 1,
  apogee       INT           NOT NULL,          -- 最高高度(米)
  flight_time  DECIMAL(7,2)  NOT NULL DEFAULT 0,
  ip_hash      CHAR(64)      NULL,              -- 限流用，不存明文 IP
  created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_design_player (design_sig, player),
  INDEX idx_apogee (apogee DESC),
  INDEX idx_created (created_at),
  INDEX idx_ip_time (ip_hash, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
