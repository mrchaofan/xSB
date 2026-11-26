# Release 包的来源与保护

## 已采用的控制

- PR 和 main CI 只运行测试及类型检查。只有 main 上手动触发的 `Release App` 调用打包任务；构建和签名使用 GitHub 托管 runner。
- 打包任务通过 GitHub OIDC 为 zip 和构建记录生成签名证明，证明文件随包发布。构建记录绑定实际 checkout 的版本提交、workflow 提交、run ID 和 zip 摘要。版本提交是在 dispatch 后生成的，不能把证明证书中的 workflow/source SHA 误当作实际构建提交。
- 发布任务只下载当前 run 的两个平台 artifact，校验精确文件名单、校验和、签名的仓库/构建 workflow/main ref/workflow SHA，以及构建记录的版本提交和 run ID。不接受其他 run、其他 workflow 或本地构建的未签名包。
- Release 先保持草稿。上传后核对 GitHub 返回的每个资产的摘要、大小和完整名单，然后发布；发布后再次检查资产和 `immutable`。
- 仓库启用 **immutable releases**。新版本发布后，GitHub 禁止新增、替换和删除其资产，并锁定关联标签。已发布版本重跑只能验证，不能覆盖；草稿可恢复上传，但拒绝人工创建的草稿和额外资产。
- 发布完成后要求 GitHub 返回 `immutable: true`，未锁定则报告失败。查询仓库开关需要 `Administration: read`，Actions 临时令牌没有该权限，因此不注入管理员 PAT，也不伪造发布前已检查开关的保证。

## 权限边界

GitHub 的 Release 上传 API 使用仓库 `contents: write` 权限，没有“只允许 GitHub Actions 上传、禁止人的 token 上传”的独立开关。上述来源检查强制约束本仓库的发布 workflow；不可变发布由 GitHub 在发布后强制执行。

拥有写权限的人仍能上传草稿资产、自行创建或发布其他 Release。仓库管理员还能改变保护配置。因此不能宣称所有人工上传 API 已被禁用，也不能声称 workflow 的草稿校验和发布操作是平台原子事务。下载者应验证 Actions 构建证明，拒绝缺少有效证明的包；单独的 `.sha256` 不能证明来源。

若管理员关闭不可变设置，新 Release 可能先被发布为可变版本，workflow 随后的锁定检查会失败，不能将这个检查说成发布前拦截。仓库开关本身才是平台保护。

不可变设置只适用于开启后发布的新版本，现有版本不会被追溯锁定或补出构建证明。不要删除重建历史 Release 来伪造这种保护。

## 下载后验证

下载同一版本的 `.zip`、`.zip.build.json`、`.zip.attestation.jsonl`。例如：

```sh
gh attestation verify xsb-VERSION-mac-arm64.zip \
  --repo mrchaofan/xSB \
  --signer-workflow mrchaofan/xSB/.github/workflows/desktop.yml \
  --source-ref refs/heads/main \
  --deny-self-hosted-runners \
  --bundle xsb-VERSION-mac-arm64.zip.attestation.jsonl

gh attestation verify xsb-VERSION-mac-arm64.zip.build.json \
  --repo mrchaofan/xSB \
  --signer-workflow mrchaofan/xSB/.github/workflows/desktop.yml \
  --source-ref refs/heads/main \
  --deny-self-hosted-runners \
  --bundle xsb-VERSION-mac-arm64.zip.attestation.jsonl
```

构建记录的 `sourceCommit` 应与对应 Release 标签指向的提交一致，`archive`、`version` 和 `sha256` 应与下载的包一致。Windows 包使用 `win-x64` 文件名。证明校验说明包来自可信的 Actions 构建；从本机重新上传同一份字节，不会改变它的构建来源。

官方说明：[Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)、[Prevent release changes](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes)、[GitHub CLI attestation verification](https://cli.github.com/manual/gh_attestation_verify)。
