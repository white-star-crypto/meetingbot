# 合议 V1 开源发布门禁

> 状态：**功能冻结 RC**（2026-11-14）
> 当前源码版本：`1.0.0`（公开 V1 RC；内部历史 2.4.x）
> 目标：首个公开版本 `1.0.0`
> 原则：V1 只修 bug、补发布工程，不再加功能；副屏插件保持默认关闭并冻结。
> 当前产物：未签名 RC；签名/自动更新/干净安装尚未完成。

## 0. 当前已具备

- 多模型会议：独立提案 → 交叉批判 → Condorcet 投票 → 主 Bot 决策。
- 决策书、执行清单、按会议权限、工作区绑定、审批与审计。
- 官方插件默认关闭；副屏只读状态镜（不再扩展网页操作）。
- `npm test` 全过（UI 契约 92 项）；打包冒烟 25/25；packguard PASS。
- PolyForm Noncommercial 1.0.0 + NOTICE（source-available，不是 OSI 开源；商业使用需单独授权）；review-pack 自审材料已生成。

## 1. 版本与范围（待拍板）

- [x] 公开版本号：`1.0.0`（2026-11-14 决定；内部 `2.4.x` 历史保留在 CHANGELOG）。
- [ ] 明确 V1 支持平台：**Windows x64 优先**；macOS/Linux 是否随 V1 发布需单独决定。
- [ ] 功能冻结：除 P0/P1 bug 外不改行为；副屏不再加交互/网页操作。
- [ ] 更新 CHANGELOG、README、release notes，统一版本号。
- [x] “支持合议”入口关闭（代码保留，后续版本可恢复）。

## 2. 送审与修 bug

- [ ] 用 `review-pack/` 做一次**外部/独立审阅**，不是自评打分。
- [ ] 把 `release/BUG-AUDIT-ALL-1.0.0.md`（或 `release/meetingbot-1.0.0-bug-audit.zip`）交给外部网页 AI 审 bug；只接受有文件/行号、触发条件和影响的结论，强 hypothesis 要标注。
- [ ] 建立 bug 清单：P0 阻断、P1 数据/安全问题、P2 体验；只修 P0/P1 进 V1。
- [ ] 密钥/隐私扫描：仓库、示例配置、`state/`、日志、截图、测试临时文件。
- [ ] 依赖许可证检查（Electron、electron-builder、运行时依赖、字体/图标）。
- [ ] 安全复核：面板 token、远程绑定、权限边界、网页工具 SSRF、Agent 审批。
- [ ] 全量测试、打包冒烟、packguard 每次修 bug 后重跑。

## 3. 干净环境全流程（必须在真实安装包上做）

- [ ] 全新 Windows 用户/虚拟机，不继承开发配置和 `node_modules`。
- [ ] 安装 NSIS 安装包（不是只跑源码或 portable）。
- [ ] 首次启动：工作区绑定/只读选择、模型 Key、权限说明。
- [ ] 跑一场真实多模型会议：提案、批判、投票、决策书。
- [ ] 失败路径：模型超时/断网/主 Bot 失败/恢复续接。
- [ ] 决策后执行：勾选任务、审批、工作区写入、审计记录。
- [ ] 关闭/重启、升级、卸载；确认数据目录与配置不丢。
- [ ] 记录实际耗时、崩溃、误导性提示；修完再签。

## 4. 安装包与签名（当前阻塞）

**现状：未签名；当前 release 是 `--win dir` + portable zip，不是带 updater 的 NSIS 安装包。**

- [x] 选择签名方式：V1 **unsigned + SHA256 + minisign**，并行申请 SignPath OSS；不购买 OV/EV。
  - 详见 `docs/SIGNING-AND-UPDATES.md`。
- [ ] 证书/密钥不进仓库；CI secret 或本机证书存储（仅在未来签名时）。
- [ ] 配置 electron-builder 签名 + 时间戳服务器（仅在未来证书获批时）。
- [ ] 产物验证：`signtool verify /pa`、安装后属性显示签名者（仅已签名时）。
- [x] 未签名兜底：V1 明确标注“未签名”，不能假装已签。
- [ ] macOS 仅在确定发布时处理 Developer ID + notarization；否则 V1 说明不支持。

## 5. 自动更新（当前缺口）

**现状：`package.json` 无 `electron-updater` / `publish` 配置；portable 版本不适合自动更新。**

- [x] 确定更新托管：GitHub Releases 主 + Gitee 镜像/手动下载兜底。
- [ ] 构建目标改为 **NSIS 安装版**用于更新；portable 仅作手动下载。
- [ ] 接入 `electron-updater`，生成并托管 `latest.yml` 与安装包。
- [ ] 更新策略：启动检查/手动检查、用户确认、下载进度、失败回退。
- [ ] 版本单调递增；禁止降级；保留上一版安装包。
- [ ] 灰度/暂停开关；发布说明与 SHA256 同页。
- [ ] 干净机器实测：旧版 → 检查更新 → 下载 → 重启 → 新版可启动。
- [ ] 国内网络回退：GitHub 不可达时的镜像/手动下载说明。

## 6. 开源发布

- [ ] 选择托管：GitHub（主）/ Gitee（镜像）；确认账号、仓库名、可见性。
- [ ] 配置 git `user.name` / `user.email`；当前仓库**没有 initial commit、没有 remote**。
- [ ] 清理后创建首个 commit；打 tag `v1.0.0`。
- [ ] 仓库文件：LICENSE、NOTICE、README、SECURITY.md、CONTRIBUTING、issue 模板。
- [ ] CI：测试、打包、packguard、release 资产；密钥只放 secrets。
- [ ] Release：源码 tag + NSIS + portable + SHA256SUMS + release notes。
- [ ] 明确“未签名/已签名”、支持平台、数据与隐私边界。
- [ ] 发布后回归：从 Release 下载安装，而不是从开发目录复制。

## 7. 真正的阻塞项（按顺序）

1. **签名方式/证书**：V1 采用 unsigned + SHA256 + minisign；SignPath OSS 申请中才可能免费签名。
2. **更新托管与 NSIS/updater 工程**：当前没有 updater，portable 不能自动更新。
3. **git 初始提交/远程/身份**：当前分支无 commit，无法开源发布。
4. **干净环境实测**：安装包全流程没跑完，不能把源码测试当发布验收。

## 8. 85 分验收口径

- P0/P1 bug 清零；P2 允许记录后置。
- 干净 Windows 环境安装包全流程通过。
- 签名状态真实、更新链路可回退、SHA256 可校验。
- 开源仓库能 clone、能按 README 构建；无密钥/本地状态。
- 以上任一未完成，不宣称“V1 可开源”。
