# AGENTS.md — dsh-pocket 开发约定

本仓此前**无任何规则文档**（`docs/` 全为 HANDOFF/调查/交付报告），规则的实际载体是
`test/repo-hygiene.test.js`（13 条 ①–⑫ 机械断言）。本文件只补**无法写成断言的纪律**：
测试面房规（基线怎么钉）与提交纪律（混合树怎么判）。凡能写成测试断言的规则，
仍落 `test/repo-hygiene.test.js`，不堆在本文件。

`files` 白名单不含本文件 ⇒ 不进 npm pack，不影响发布面。

---

## 一、测试面房规：基线断言只能钉不可变 sha

**规则**：先红后绿类断言（red-first）钉基线时，**只准钉不可变提交 sha，禁钉会漂移的引用**
（`HEAD`、`HEAD~1`、`HEAD^`、分支名）。

**为什么**：修复一落进 HEAD，钉 `HEAD~1` 的基线就随每次新提交漂移——「先红」的因果证据
会自行腐烂成假绿或假红。本仓已有两处注释明写此理（`test/pages-render-fixes.test.js:773`、
`test/question-no-gesture-no-submit.test.js:348`），但**它是注释不是入口**：新人无从检索，
grep 全树会撞 12 处 `HEAD:` 散文与注释，可执行面与散文面混在一起看不出纪律。

**机械判据**（改测试后自检）：

```bash
git grep -nE 'HEAD[~^]' -- 'test/*' 'lib/*' 'tools/*'   # 须归零
```

- 只扫 `test/lib/tools`（可执行面），**不要**用 `git grep 'HEAD:'` 全树扫——
  `docs/` 散文与注释里 12 处命中是正常文本，扫全树会让判据永远为假。
- 钉基线读不到时：**显式记未取证，绝不回退读当前文件**——「读不到基线 ≠ 基线成立」。
  该语义已固化在 `test/helpers/pre-fix-baseline.mjs:11-14`（`git show <ref>:<file>` 失败
  → `null` → `t.skip`，不 fallback 到工作树）。

**可用基线 sha（不可变，已核 `git cat-file -t` = commit）**：

| sha | 日期 | 用途 |
|---|---|---|
| `f8e1669` | 2026-10-19 04:37:45 | 六 bug 调查/复核报告落盘前的一棵；父卡实证用它替换 `HEAD:` 后归零 |

需要新基线时：取当时的提交 sha 落表，并在测试注释里写清「钉的是什么语义、为什么是这个 sha」。

---

## 二、提交纪律：判树脏先看真 diff，禁 `-A`

**规则（三条）**：

1. **判「树脏不脏」只准 `git diff --name-only`，禁 `git status`**。
   本仓 `core.autocrlf=true`，`git status` 会把纯换行翻转报成 `M`——实测一次报 125 条
   M 而真 diff 只有 1 个文件（`lib/bridge.js` +11，他线在途）。按 status 判脏会得出
   「仓里改了 125 个文件」的错误结论，并直接导致下一条事故。
2. **逐文件显式 `git add`，禁 `git add -A` / `-a`**。
   上条的假 M 若被 `-A` 扫进暂存区，等于一次提交翻搅 123 个文件的行尾
   （并会把仓根 333KB 的 `tmp-shell-check.js` 这类 untracked 卷进来，`.gitignore`
   的 `tmp/` 只抓目录、抓不到仓根那个文件）。
   本仓 `.git/hooks` 非 sample 钩子 **0 个**、无 husky/commitlint、无 devDependencies ⇒
   **零机械拦截**，唯一的拦截点就是这条纪律本身。
3. **真改动与假 M 分开处理**：真改动按任务逐文件 add；假 M 不动（行尾在编辑时自然归一，
   不做全库 renormalize）。

**混合树整文件提交**（目标文件含单物理行巨行、无法按行切时）：走被迫整文件提交，
披露四要素见 flow 侧 `workflows/stages/stages-ship.md` Step 3c「单物理行巨行与整文件提交」条；
本仓的披露范式正源见 `CHANGELOG.md:778-782` / `:814-816`（0.4.32 大合并）。

**测试基线**：本仓测试**必须在 PowerShell / cmd 下跑**（`node --test`）。
Git-bash 下 `test/tunnel.test.js` 会出 2 条假红（MSYS 把 `C:\...` 当远端 host 解析）。

---

## 三、本文件的边界

- 只记**无法写成断言**的纪律；能机械执行的规则一律落 `test/repo-hygiene.test.js`
  （本仓传统＝「规则写成测试」）。
- 本文件**不进 npm pack**（`files` 白名单不含它），改它无需顾虑发布面。
