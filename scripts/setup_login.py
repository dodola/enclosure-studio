"""Create or reset the administrator from the local terminal only."""
import argparse
import getpass
import json
import os
import secrets
from pathlib import Path

from server.auth import ROOT, password_hash

parser = argparse.ArgumentParser(description="配置壳研管理员账户")
parser.add_argument("--username", default="admin")
parser.add_argument("--reset", action="store_true", help="重置现有账户；完成后重启服务")
parser.add_argument("--prompt", action="store_true", help="在终端输入密码；不生成密码文件")
args = parser.parse_args()
if not 1 <= len(args.username) <= 80:
    parser.error("用户名长度须为 1–80。")
path = Path(os.environ.get("ENCLOSURE_AUTH_FILE", ROOT / ".pi-state/login.json")).resolve()
if path.exists() and not args.reset:
    parser.exit(message="登录账户已经配置。使用 --reset 才会重置。\n")
password = getpass.getpass("密码（至少 12 位）：") if args.prompt else secrets.token_urlsafe(18)
if len(password) < 12 or len(password) > 256:
    parser.error("密码长度须为 12–256。")
if args.prompt and password != getpass.getpass("再次输入："):
    parser.error("两次密码不一致。")
salt = secrets.token_hex(16)
config = {"version": 1, "username": args.username, "salt": salt, "passwordHash": password_hash(password, salt), "internalToken": secrets.token_urlsafe(32)}
path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
path.parent.chmod(0o700)
temporary = path.with_name(path.name + ".tmp")
with open(temporary, "w", encoding="utf-8", opener=lambda p, flags: os.open(p, flags, 0o600)) as file:
    json.dump(config, file, indent=2)
temporary.chmod(0o600)
temporary.replace(path)
password_file = path.with_name("login-password.txt")
if args.prompt:
    password_file.unlink(missing_ok=True)
else:
    with open(password_file, "w", encoding="utf-8", opener=lambda p, flags: os.open(p, flags, 0o600)) as file:
        file.write(f"用户名：{args.username}\n密码：{password}\n")
    password_file.chmod(0o600)
print(f"已配置账户 {args.username}，登录校验使用 scrypt 密码哈希。")
if not args.prompt:
    print(f"初始登录密码保存在本机：{password_file}")
