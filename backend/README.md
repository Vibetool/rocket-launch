# 火箭发射 · 联机机库后端

两个文件，10 分钟部署到已有的宝塔服务器（可与 Mini Metro 后端共用同一个库）。

## 1) 导入表
宝塔 → 数据库 → 选你的库 → 导入 → 选 `schema.sql`
（只新增一张 `rocket_ships` 表，不动现有表）

## 2) 上传接口
把 `ships.php` 传到站点根目录，比如 `/www/wwwroot/api.ovobot.ai/`

## 3) 改 ships.php 头部配置
```php
const DB_HOST = '127.0.0.1';
const DB_NAME = 'metro_game';      // 复用地铁那个库就填它
const DB_USER = 'metro_user';
const DB_PASS = '你的密码';
```
`CORS_ALLOWED_ORIGINS` 里默认已含 `https://vibetool.github.io`。

## 4) 前端开启联机
改仓库根目录的 `config.js`：
```js
window.ROCKET_API = 'https://api.ovobot.ai/ships.php';
```
留空则为离线模式（机库只存本机）。

## 接口
| 方法 | 说明 |
|---|---|
| `GET ships.php?limit=60` | 公开机库，按高度降序 |
| `POST ships.php` | 登记飞船，body: `{player, name, stack, apogee, time}` |

## 设计取舍
- **匿名可写**，不需要注册登录 —— 昵称存在玩家浏览器里，降低参与门槛
- 服务端校验零件白名单、零件数上限、必须有引擎、必须过 100km，防伪造设计
- 同一玩家的同款设计只保留最好成绩（`design_sig + player` 唯一索引）
- 同 IP 每小时限 20 次提交，IP 只存 hash 不存明文
- 后端不可用时前端自动降级为离线模式，游戏照常能玩
