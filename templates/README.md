# CI 模板（M5）

这些文件不是自动生效的配置，而是**给你复制到自己项目里**的模板。`macmini-station` 不会、也不应该往你的仓库写 CI 文件——那属于"改你的代码"，超出它的职责。

## 用法

```bash
# 在你自己的项目仓库里
mkdir -p .github/workflows
cp /path/to/macmini-station/templates/github-actions-ci.yml .github/workflows/ci.yml
# 删掉不需要的 job，填上你自己的测试命令
```

## 模板包含什么

| 文件 | 作用 |
|---|---|
| `github-actions-ci.yml` | 三件事：Node 矩阵跑测试、禁止运行时依赖（可删）、给 PR 加状态检查名 |
| `pull-request-template.md` | 合并前自查清单，包含"README 是否同步" |

## 为什么仓库自己不写 CI 到别人项目

Agent 能在工作区里改代码（M4.3），但**发布流程的配置应该由人决定**。一旦工具开始往 `.github/workflows/` 写文件，就等于自动获得了"修改 CI/CD"的能力——这是最容易造成供应链问题的位置。所以这里只提供模板，落地由使用者一次手动完成。

## 与 `station worktree pr` 的关系

- 工具的 `pr` 子命令只负责**开 Draft PR**；
- PR 上的检查来自你项目自己的 workflow（可以用这个模板）；
- 工具不会替你合并，也不会替你改 workflow。

## 建议的最小 workflow

```yaml
name: ci
on: [push, pull_request]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm test
```

保持 `permissions: contents: read`：CI 不需要写权限，Draft PR 也只需要读。