# va-auto-pilot skill

可分发的 Agent Skill，用来把 VA Auto-Pilot 工程闭环安装到任意代码库。

> 当前无需也无需依赖 npm 发布包；若 npm 包尚未发布，请走下面的 GitHub 安装路径。

## 给 Codex

```text
$skill-installer install https://github.com/Vadaski/va-auto-pilot/tree/main/skills/va-auto-pilot
```

若环境不支持 `skill-installer`，可用源码直接安装：

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init .

# VA Auto-Pilot runtime requires yaml
npm install yaml
rm -rf "$tmp"
```

安装后重启 Codex，然后可用 `$va-auto-pilot` 显式调用。

## 给 Claude Code

```bash
mkdir -p .claude/commands
curl -fsSL https://raw.githubusercontent.com/Vadaski/va-auto-pilot/main/skills/va-auto-pilot/claude-command.md -o .claude/commands/va-auto-pilot.md
```

之后可直接输入 `/va-auto-pilot`。
