// 后端地址。留空则该功能关闭（机库退回本机 localStorage，联机入口隐藏）。
// 两个接口都不需要在 PHP 里填数据库配置 —— 它们会复用同目录 db.php 的连接。

// 联机机库：全体玩家的入轨飞船列表
window.ROCKET_API = 'https://api.ovobot.ai/ships.php';

// 双人联机：WebRTC 信令（接通后游戏数据与语音走 P2P，不经服务器）
window.ROCKET_ROOM_API = 'https://api.ovobot.ai/room.php';
