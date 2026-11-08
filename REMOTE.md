# 远程仓库连接说明

本仓库有两条版本线（同一份代码、两个长期分支）：

| 分支 | 对应产品 | 版本线 |
|---|---|---|
| `master` | 播放器（本地版） | 2.x |
| `online` | 联网版 | 3.x |

## 一、首次连接远程

### 1. 在托管平台建一个空仓库

GitHub / Gitee（码云）/ 自建 Git 服务都可以。**不要**勾选「初始化 README / .gitignore」，
保持空仓库，避免首推时历史冲突。

### 2. 关联远程（二选一）

```bash
# HTTPS 方式（简单，推送时输账号密码或令牌）
git remote add origin https://github.com/<你的用户名>/<仓库名>.git

# SSH 方式（推荐，配一次免密长期用）
git remote add origin git@github.com:<你的用户名>/<仓库名>.git
```

Gitee 只是把域名换成 `gitee.com`，其余完全一样。

### 3. SSH 免密配置（只在用 SSH 方式时需要）

```bash
ssh-keygen -t ed25519 -C "你的邮箱"     # 一路回车即可
cat ~/.ssh/id_ed25519.pub               # 把输出整段复制
```

粘贴到平台设置里的「SSH 公钥」（GitHub: Settings → SSH and GPG keys；
Gitee: 设置 → SSH 公钥），然后验证：

```bash
ssh -T git@github.com    # 或 ssh -T git@gitee.com
```

### 4. 首次推送（两条分支一起推）

```bash
git push origin --all          # 推送 master 和 online 两个分支
git push origin --tags         # 如有标签
```

之后设置分支 upstream，方便以后直接 `git push` / `git pull`：

```bash
git push -u origin master
git checkout online && git push -u origin online
```

## 二、日常同步

```bash
git fetch origin               # 拉取远程最新（不合并）
git pull                       # 在当前分支拉取并合并
git push                       # 推送当前分支
git push origin master online  # 一次推两条分支
```

## 三、换电脑 / 他人克隆

```bash
git clone <仓库地址>
cd <仓库名>
git checkout online            # 默认克隆的是 master，联网版切到 online
pnpm install                   # 安装依赖
```

注意：`.gitignore` 排除了 `data/`、`node_modules/`、构建产物和环境变量文件，
克隆后需要自己跑 `pnpm install`；运行时数据（曲库缓存、设置、日志）不入库。

## 四、常用维护命令

```bash
git remote -v                  # 查看当前远程配置
git remote set-url origin <新地址>   # 换远程地址（如迁移平台）
git remote remove origin       # 解除远程关联
git branch -vv                 # 查看分支与远程的跟踪关系
```

## 五、约定提醒

- 修 bug / 加功能**两条分支都要改**：先在 `online` 修，再同步到 `master`，分别提交。
- 提交信息里用「播放器」「联网版」指代两条版本线，不写全称。
